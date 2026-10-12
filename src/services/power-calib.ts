/**
 * power-calib.ts — 功率可信度的设备侧编排（标记 + 校准缩放重算，v2）。
 *
 * 两个入口（均由 AI 经工具层或用户在 UI 触发）：
 *  - setPowerFlagAndRefresh：标记/取消某骑行「功率不可信」→ 训练档案即时重建
 *    （被标记骑行从功率派生基线排除，口径见 core/dossier）。可逆操作。
 *  - recalibrateActivityPower：按系数缩放重算单骑全部功率派生指标并写回——
 *    复用 core/reanalyze 的 powerScale 口径（NP/avg/max/VI/峰曲线入重算集、
 *    爬坡均值线性换算），入库与 form 注入照 importFit 两段式；逐秒原始数据
 *    不改写（重导原 FIT 或换系数重跑即可回退）；系数夹逼到 POWER_CALIBRATION
 *    界限并在结果中如实回报是否被夹逼。
 */

import { rollLocalSnapshotQuietly } from '@/backup/export';
import type { Summary } from '@/core/analyze';
import { t, type Lang } from '@/core/i18n';
import { rebuildSummaryFromRecords } from '@/core/reanalyze';
import { POWER_CALIBRATION } from '@/core/settings';
import {
  computeForm,
  getActivitySummary,
  getEffectiveAthlete,
  rebuildDossierQuietly,
  setActivityPowerFlag,
  upsertActivity,
} from '@/db';
import { loadStoredRecords } from '@/records-store';

/** 标记结果（AI 转述给用户 / UI 提示用） */
export interface PowerFlagOutcome {
  ok: true;
  file_name: string;
  flagged: boolean;
  /** 标记原因（原样透传，可能为 null） */
  reason: string | null;
  /** 档案已随标记重建 */
  dossier_updated: true;
}

export async function setPowerFlagAndRefresh(
  fileName: string,
  flagged: boolean,
  lang: Lang = 'zh',
  reason: string | null = null,
): Promise<PowerFlagOutcome> {
  await setActivityPowerFlag(fileName, flagged, lang);
  await rebuildDossierQuietly();
  return { ok: true, file_name: fileName, flagged, reason, dossier_updated: true };
}

/** 校准结果：changes 仅列有变化的字段（旧→新），供 AI 在回答中向用户说明 */
export interface PowerCalibOutcome {
  ok: true;
  file_name: string;
  date: string;
  sport: string;
  /** 请求的系数与实际生效系数（越界被夹逼时两者不同） */
  scale_requested: number;
  scale_applied: number;
  changes: Record<string, { old: unknown; new: unknown }>;
  /** 重算 TSS 后当日体能快照（训练库为空时 null） */
  form: { ctl: number; atl: number; tsb: number } | null;
}

/** 旧→新对比项（仅记录确实变化的字段，避免结果膨胀） */
const pushChange = (
  changes: PowerCalibOutcome['changes'],
  key: string,
  a: unknown,
  b: unknown,
) => {
  if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null))
    changes[key] = { old: a ?? null, new: b ?? null };
};

/** 对比新旧 summary 的校准敏感字段（缩放重算集：功率派生全量，见 core/reanalyze） */
function diffSummaries(prev: Summary, rebuilt: Summary): PowerCalibOutcome['changes'] {
  const changes: PowerCalibOutcome['changes'] = {};
  pushChange(changes, 'normalized_power', prev.power?.normalized_power ?? null, rebuilt.power?.normalized_power ?? null);
  pushChange(changes, 'avg_power', prev.power?.avg ?? null, rebuilt.power?.avg ?? null);
  pushChange(changes, 'max_power', prev.power?.max ?? null, rebuilt.power?.max ?? null);
  pushChange(changes, 'peak_curve', prev.power?.peak_curve ?? null, rebuilt.power?.peak_curve ?? null);
  pushChange(changes, 'tss', prev.power?.tss ?? null, rebuilt.power?.tss ?? null);
  pushChange(changes, 'intensity_factor', prev.power?.intensity_factor ?? null, rebuilt.power?.intensity_factor ?? null);
  pushChange(changes, 'power_zone_distribution_pct', prev.power?.zone_distribution_pct ?? null, rebuilt.power?.zone_distribution_pct ?? null);
  pushChange(changes, 'w_per_kg_avg', prev.power?.w_per_kg_avg ?? null, rebuilt.power?.w_per_kg_avg ?? null);
  pushChange(changes, 'ftp_estimate', prev.power?.ftp_estimate ?? null, rebuilt.power?.ftp_estimate ?? null);
  pushChange(changes, 'interval_set', prev.interval_set ?? null, rebuilt.interval_set ?? null);
  pushChange(changes, 'cadence_power', prev.cadence_power ?? null, rebuilt.cadence_power ?? null);
  pushChange(changes, 'climbs_avg_power', prev.climbs ?? null, rebuilt.climbs ?? null);
  return changes;
}

/**
 * 按系数缩放重算一次训练的功率派生指标并写回。活动行不存在或缺逐秒数据抛
 * 双语 Error（工具层兜为 {error}）；系数夹逼到 POWER_CALIBRATION 界限。
 */
export async function recalibrateActivityPower(
  fileName: string,
  scaleFactor: number,
  lang: Lang = 'zh',
): Promise<PowerCalibOutcome> {
  const prev = await getActivitySummary(fileName);
  if (!prev) throw new Error(t(lang, 'tool.summary_not_found', { name: fileName }));
  const records = await loadStoredRecords(fileName);
  if (!records) throw new Error(t(lang, 'tool.records_not_found', { name: fileName }));

  const scaleApplied = Math.min(
    POWER_CALIBRATION.max_scale,
    Math.max(POWER_CALIBRATION.min_scale, scaleFactor),
  );
  const athlete = await getEffectiveAthlete();
  const rebuilt = rebuildSummaryFromRecords(records, prev, athlete, { powerScale: scaleApplied });
  // category/note 是 activities 列属数据（读取时由 db 层合并回填），不落 summary_json
  // ——原样写回会把用户随后清除的备注"复活"（口径同 services/reanalyze）
  delete rebuilt.activity.category;
  delete rebuilt.activity.note;

  // 入库 + 注入当日 CTL/ATL/TSB 后终版再入库（两段式，口径同 importFit/reanalyze）
  await upsertActivity(fileName, rebuilt);
  const form = await computeForm(rebuilt.activity.date);
  if (form) {
    Object.assign(rebuilt.athlete_context, form);
    await upsertActivity(fileName, rebuilt);
  }

  void rollLocalSnapshotQuietly(); // 数据被改写，滚静默快照（fire-and-forget 串行链）
  await rebuildDossierQuietly(); // 功率基线变了，档案立即对齐

  return {
    ok: true,
    file_name: fileName,
    date: rebuilt.activity.date,
    sport: rebuilt.activity.sport,
    scale_requested: scaleFactor,
    scale_applied: scaleApplied,
    changes: diffSummaries(prev, rebuilt),
    form: form ? { ctl: form.ctl, atl: form.atl, tsb: form.tsb } : null,
  };
}

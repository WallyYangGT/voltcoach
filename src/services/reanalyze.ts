/**
 * reanalyze.ts — AI 教练触发训练重新分析的编排层（设备侧，M5）。
 *
 * 从已存 records gzip 按当前生效骑手参数重建 summary（core/reanalyze，FIT 原始
 * 字节本就不落盘）并**写回该训练**——用户口径：FTP 有更新或用户要求时，让该次
 * 训练的分析结果与最新骑手参数一致，AI 只触发、不手改数值。入库与当日 CTL/ATL/
 * TSB 注入照 importFit 的两段式口径；改写数据后滚本地快照（与「导入成功后滚
 * 快照」对齐）；报告标题的输入（sport/date/records 首帧/created_at）均未变，
 * 无需 invalidateReportTitles。
 */

import { rollLocalSnapshotQuietly } from '@/backup/export';
import { t, type Lang } from '@/core/i18n';
import { rebuildSummaryFromRecords } from '@/core/reanalyze';
import type { Summary } from '@/core/analyze';
import { computeForm, getActivitySummary, getEffectiveAthlete, upsertActivity } from '@/db';
import { loadStoredRecords } from '@/records-store';

/** 重新分析结果：changes 仅列有变化的字段（旧→新），供 AI 在回答中向用户说明 */
export interface ReanalyzeOutcome {
  ok: true;
  file_name: string;
  date: string;
  sport: string;
  ftp_used: number;
  max_hr_used: number;
  weight_used: number;
  changes: Record<string, { old: unknown; new: unknown }>;
  /** 重算 TSS 后当日体能快照（训练库为空时 null） */
  form: { ctl: number; atl: number; tsb: number } | null;
}

/** 旧→新对比项（仅记录确实变化的字段，避免结果膨胀） */
const pushChange = (
  changes: ReanalyzeOutcome['changes'],
  key: string,
  a: unknown,
  b: unknown,
) => {
  if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null))
    changes[key] = { old: a ?? null, new: b ?? null };
};

/** 对比新旧 summary 的骑手参数敏感字段（口径见 core/reanalyze 的重算清单） */
function diffSummaries(prev: Summary, rebuilt: Summary): ReanalyzeOutcome['changes'] {
  const changes: ReanalyzeOutcome['changes'] = {};
  pushChange(changes, 'tss', prev.power?.tss ?? null, rebuilt.power?.tss ?? null);
  pushChange(changes, 'intensity_factor', prev.power?.intensity_factor ?? null, rebuilt.power?.intensity_factor ?? null);
  pushChange(changes, 'power_zone_distribution_pct', prev.power?.zone_distribution_pct ?? null, rebuilt.power?.zone_distribution_pct ?? null);
  pushChange(changes, 'hr_zone_distribution_pct', prev.heart_rate?.zone_distribution_pct ?? null, rebuilt.heart_rate?.zone_distribution_pct ?? null);
  pushChange(changes, 'w_per_kg_avg', prev.power?.w_per_kg_avg ?? null, rebuilt.power?.w_per_kg_avg ?? null);
  pushChange(changes, 'ftp_estimate', prev.power?.ftp_estimate ?? null, rebuilt.power?.ftp_estimate ?? null);
  pushChange(changes, 'interval_set', prev.interval_set ?? null, rebuilt.interval_set ?? null);
  pushChange(changes, 'cadence_power', prev.cadence_power ?? null, rebuilt.cadence_power ?? null);
  return changes;
}

/**
 * 重新分析一次训练并写回：活动行不存在或缺逐秒数据抛双语 Error
 * （工具层兜为 {error}）。返回新旧指标对比供 AI 说明。
 */
export async function reanalyzeActivity(fileName: string, lang: Lang = 'zh'): Promise<ReanalyzeOutcome> {
  const prev = await getActivitySummary(fileName);
  if (!prev) throw new Error(t(lang, 'tool.summary_not_found', { name: fileName }));
  const records = await loadStoredRecords(fileName);
  if (!records) throw new Error(t(lang, 'tool.records_not_found', { name: fileName }));

  const athlete = await getEffectiveAthlete();
  const rebuilt = rebuildSummaryFromRecords(records, prev, athlete);
  // category/note 是 activities 列属数据（读取时由 db 层合并回填），不落 summary_json——
  // prev 取自 getActivitySummary 已合并列值，原样写回会把用户随后清除的备注"复活"
  delete rebuilt.activity.category;
  delete rebuilt.activity.note;

  // 入库 + 注入当日 CTL/ATL/TSB 后终版再入库（两段式，口径同 importFit）
  await upsertActivity(fileName, rebuilt);
  const form = await computeForm(rebuilt.activity.date);
  if (form) {
    Object.assign(rebuilt.athlete_context, form);
    await upsertActivity(fileName, rebuilt);
  }

  void rollLocalSnapshotQuietly(); // 数据被改写，滚静默快照（失败仅警告，fire-and-forget 串行链）

  return {
    ok: true,
    file_name: fileName,
    date: rebuilt.activity.date,
    sport: rebuilt.activity.sport,
    ftp_used: athlete.ftp_watts,
    max_hr_used: athlete.max_hr,
    weight_used: athlete.weight_kg,
    changes: diffSummaries(prev, rebuilt),
    form: form ? { ctl: form.ctl, atl: form.atl, tsb: form.tsb } : null,
  };
}

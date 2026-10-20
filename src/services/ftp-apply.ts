/**
 * ftp-apply.ts — AI 教练自动更新 FTP 的编排层（设备侧，M5）。
 *
 * 流程：窗口取数 → estimateFtpFromHistory 科学估算 → selectFtpFromEstimate 选定写入值
 * （缺省两法均值；模型给了 ftp_watts 时夹逼到估算区间内）→ evaluateFtpApply 采纳门槛
 * （置信度/两法一致性/全力锚点/新鲜度/diff 等硬校验，见 core/ftp）→ 过则
 * setAthlete 写回并盖 ai_coach 溯源戳 + 落 ai_ftp_update 快照（首页披露条与
 * undoAiFtpUpdate 撤销入口的数据源，架构评审 S3）。数值恒出自估算区间——模型只有
 * 「区间内偏保守/偏激进」的取舍权，没有写区间外数值的入口（幻觉写值防护）；
 * 教练的判断权在"何时调用"与"取区间哪一端"。
 */

import { t, type Lang } from '@/core/i18n';
import {
  evaluateFtpApply,
  estimateFtpFromHistory,
  selectFtpFromEstimate,
  type FtpEstimationResult,
  type FtpHistoryEstimate,
} from '@/core/ftp';
import { FTP_ESTIMATION } from '@/core/settings';
import {
  cyclingSummariesSince,
  getAiFtpUpdate,
  getAthleteState,
  getFtpMeta,
  rebuildDossierQuietly,
  setAiFtpUpdate,
  setAthlete,
  type AiFtpUpdateSnapshot,
} from '@/db';

/** applyAiFtpUpdate 选项：ftp_watts 为模型自选值（夹逼到估算区间内再写） */
export interface AiFtpUpdateOptions {
  ftp_watts?: number;
}

/** applyAiFtpUpdate 返回：拒绝时 reason 为已本地化的文案（estimate 供 AI 解释） */
export interface AiFtpUpdateResult {
  applied: boolean;
  /** 拒绝原因（双语）；成功时无 */
  reason?: string;
  old_ftp_w?: number;
  new_ftp_w?: number;
  /** 模型自选的原值（缺省请求时为 null/省略）；被夹逼时与 new_ftp_w 不同 */
  requested_w?: number | null;
  /** 自选值被夹逼到估算区间边界 */
  clamped?: boolean;
  /** 本次采纳所依据的完整估算（含方法明细与锚点溯源） */
  estimate?: FtpHistoryEstimate;
  data_needs?: string[];
  /** 溯源戳（athlete JSON 的 ftp_updated_at） */
  updated_at?: string | null;
}

/** AI 触发的 FTP 更新：估算 → 选定值（可选区间自选）→ 门槛 → 写回（拒绝不抛错，返回结构化结果供 AI 转述） */
export async function applyAiFtpUpdate(
  lang: Lang = 'zh',
  opts?: AiFtpUpdateOptions,
): Promise<AiFtpUpdateResult> {
  const rides = await cyclingSummariesSince(FTP_ESTIMATION.window_days);
  const { athlete } = await getAthleteState();
  const result: FtpEstimationResult = estimateFtpFromHistory(rides, athlete, FTP_ESTIMATION, lang);
  const selection = selectFtpFromEstimate(result, opts?.ftp_watts);

  // 新鲜度依据：与估算器同款"可用"口径（有功率且覆盖率达标的骑行）中最近一次的日期
  // ——无功率的新骑行不能证明估值所依据的数据新鲜；被标记「功率不可信」的骑行同样
  // 不算（估算器已剔除，这里的"最近一次"必须与估算样本同集合）；无可用骑行为 null → 门槛拒
  const usableRides = rides.filter(
    (r) =>
      !r.power_flagged &&
      r.summary?.power &&
      (r.summary.data_quality?.power_coverage_pct ?? 100) >= FTP_ESTIMATION.min_coverage_pct,
  );
  const latestRideDate = usableRides.reduce<string | null>(
    (max, r) => (r.date > (max ?? '') ? r.date : max),
    null,
  );
  const today = new Date().toISOString().slice(0, 10);
  const check = evaluateFtpApply(
    result,
    latestRideDate,
    today,
    FTP_ESTIMATION,
    selection?.ftp_w,
  );
  if (!check.ok || !result.estimate || !selection) {
    return {
      applied: false,
      reason: t(lang, check.reason_key ?? 'ftp.apply.no_data', check.reason_vars),
      requested_w: selection?.requested_w ?? null,
      clamped: selection?.clamped ?? false,
      estimate: result.estimate ?? undefined,
      data_needs: result.data_needs,
    };
  }

  const e = result.estimate;
  // 旧溯源戳先读（撤销要把它恢复回去——否则撤销回默认 106W 会被重新盖戳、
  // 校准判据误判为已校准，code-review P1）
  const metaBefore = await getFtpMeta();
  const updated = await setAthlete({ ftp_watts: selection.ftp_w }, lang, { source: 'ai_coach' });
  const meta = await getFtpMeta();
  // 快照（S3 追认入口）：首页披露条展示「谁改的、从多少到多少」，撤销据此回滚。
  // 自选时附带原值/区间（披露条据此区分「区间自选」与「默认均值」，2026-10-20）；
  // 旧戳随快照保存，供撤销恢复校准状态
  const snapshot: AiFtpUpdateSnapshot = {
    old_ftp_w: e.current_ftp_w,
    new_ftp_w: updated.ftp_watts,
    updated_at: meta.updated_at ?? new Date().toISOString(),
    old_ftp_updated_at: metaBefore.updated_at,
    old_ftp_source: metaBefore.source,
  };
  if (selection.requested_w != null) {
    snapshot.requested_w = selection.requested_w;
    snapshot.range_low_w = e.range_low;
    snapshot.range_high_w = e.range_high;
  }
  await setAiFtpUpdate(snapshot);
  void rebuildDossierQuietly(); // 爬坡强度 %FTP 分母变了，档案随之更新（fire-and-forget）
  return {
    applied: true,
    old_ftp_w: e.current_ftp_w,
    new_ftp_w: updated.ftp_watts,
    requested_w: selection.requested_w,
    clamped: selection.clamped,
    estimate: e,
    updated_at: meta.updated_at,
  };
}

/** undoAiFtpUpdate 返回：undone=false 时 reason 说明原因（none=无可撤销的快照；stale=当前 FTP 已被后续修改） */
export interface AiFtpUndoResult {
  undone: boolean;
  reason?: 'none' | 'stale';
  restored_ftp_w?: number;
}

/**
 * 撤销 AI 的最近一次 FTP 更新（架构评审 S3「审计追认」的可逆半边）：
 * 恢复快照 old 值（溯源戳一并恢复到 AI 更新前的状态——撤销不是一次「校准」，
 * 回到默认 106W 时必须重新判定为未校准，code-review P1）、清快照、重建档案。
 * 当前 FTP 已不等于快照 new 值时拒绝（用户后来手动改过/又发生了一次 AI 更新）——
 * 每笔变更只回滚它自己，不跨笔回滚。旧快照没有 old_ftp_* 字段时按「无戳」恢复，
 * 保守判未校准。
 */
export async function undoAiFtpUpdate(lang: Lang = 'zh'): Promise<AiFtpUndoResult> {
  const snap = await getAiFtpUpdate();
  if (!snap) return { undone: false, reason: 'none' };
  const { athlete } = await getAthleteState();
  if (athlete.ftp_watts !== snap.new_ftp_w) return { undone: false, reason: 'stale' };
  await setAthlete({ ftp_watts: snap.old_ftp_w }, lang, {
    source: 'manual',
    stamps: {
      updated_at: snap.old_ftp_updated_at ?? null,
      source: snap.old_ftp_source ?? null,
    },
  });
  await setAiFtpUpdate(null);
  void rebuildDossierQuietly(); // FTP 变更触发点口径：撤销同样重建档案
  return { undone: true, restored_ftp_w: snap.old_ftp_w };
}

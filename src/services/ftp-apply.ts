/**
 * ftp-apply.ts — AI 教练自动更新 FTP 的编排层（设备侧，M5）。
 *
 * 流程：窗口取数 → estimateFtpFromHistory 科学估算 → evaluateFtpApply 采纳门槛
 * （置信度/两法一致性/全力锚点/新鲜度/diff 等硬校验，见 core/ftp）→ 过则
 * setAthlete 写回并盖 ai_coach 溯源戳。数值始终取估算器输出——工具对模型零参，
 * 没有自定数值的入口，杜绝幻觉写值；教练的判断权在"何时调用"。
 */

import { t, type Lang } from '@/core/i18n';
import {
  evaluateFtpApply,
  estimateFtpFromHistory,
  type FtpEstimationResult,
  type FtpHistoryEstimate,
} from '@/core/ftp';
import { FTP_ESTIMATION } from '@/core/settings';
import { cyclingSummariesSince, getAthleteState, getFtpMeta, rebuildDossierQuietly, setAthlete } from '@/db';

/** applyAiFtpUpdate 返回：拒绝时 reason 为已本地化的文案（estimate 供 AI 解释） */
export interface AiFtpUpdateResult {
  applied: boolean;
  /** 拒绝原因（双语）；成功时无 */
  reason?: string;
  old_ftp_w?: number;
  new_ftp_w?: number;
  /** 本次采纳所依据的完整估算（含方法明细与锚点溯源） */
  estimate?: FtpHistoryEstimate;
  data_needs?: string[];
  /** 溯源戳（athlete JSON 的 ftp_updated_at） */
  updated_at?: string | null;
}

/** AI 触发的 FTP 更新：估算 → 门槛 → 写回（拒绝不抛错，返回结构化结果供 AI 转述） */
export async function applyAiFtpUpdate(lang: Lang = 'zh'): Promise<AiFtpUpdateResult> {
  const rides = await cyclingSummariesSince(FTP_ESTIMATION.window_days);
  const { athlete } = await getAthleteState();
  const result: FtpEstimationResult = estimateFtpFromHistory(rides, athlete, FTP_ESTIMATION, lang);

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
  const check = evaluateFtpApply(result, latestRideDate, today, FTP_ESTIMATION);
  if (!check.ok || !result.estimate) {
    return {
      applied: false,
      reason: t(lang, check.reason_key ?? 'ftp.apply.no_data', check.reason_vars),
      estimate: result.estimate ?? undefined,
      data_needs: result.data_needs,
    };
  }

  const e = result.estimate;
  const updated = await setAthlete({ ftp_watts: e.ftp_w }, lang, { source: 'ai_coach' });
  const meta = await getFtpMeta();
  void rebuildDossierQuietly(); // 爬坡强度 %FTP 分母变了，档案随之更新（fire-and-forget）
  return {
    applied: true,
    old_ftp_w: e.current_ftp_w,
    new_ftp_w: updated.ftp_watts,
    estimate: e,
    updated_at: meta.updated_at,
  };
}

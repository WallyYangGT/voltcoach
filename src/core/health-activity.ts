/**
 * health-activity.ts — WHO 周活动量口径（业余模式首页健康瓦片，纯函数、无 IO）。
 *
 * 目标用户是「以健康/习惯为主」的业余骑友：成绩指标（FTP/CTL）之外给一个
 * 与训练水平无关、每天都能推进的成功指标。口径对齐 WHO 2020 指南：
 * 每周 150–300 分钟中等强度（或 75–150 分钟高强度），高强度按 1:2 折算中等。
 *
 * 强度判定（按优先级）：
 *  1. IF 可用：IF ≥ 0.9 视为高强度，0.6–0.9 中等，<0.6 轻松（不计入达标，单列披露）；
 *  2. IF 缺失但 TSS 与时长可用：按 TSS = 时长h × IF² × 100 反推 IF；
 *  3. 都缺失（无功率骑行）：category='race' 视为高强度，其余按中等计（宽松口径，
 *     数据不足时不惩罚用户；报告/提示词侧仍会要求校准心率锚点）。
 *
 * 窗口：以本地日历日「今天」为末端的近 N 天（默认 7，含今天）；日期必须已是
 * 本地日（调用方经 useRideDateLabels/localDayFromUtc 换算，与 §24 展示口径一致）。
 */

import { addDaysStr } from './dossier.ts';

/** WHO 健康目标（中等强度分钟/周） */
export const WHO_ACTIVITY_TARGET = {
  moderate_min: 150,
  extra_min: 300,
} as const;

/** 强度分界（与功率/心率分区的训练者口径一致：0.9 IF ≈ 阈值，0.6 ≈ 轻松骑上沿） */
const IF_VIGOROUS = 0.9;
const IF_MODERATE = 0.6;

export interface HealthActivityRow {
  /** 本地日历日 YYYY-MM-DD */
  date: string;
  duration_sec: number | null;
  intensity_factor: number | null;
  tss: number | null;
  category?: string | null;
}

export interface WeeklyActivitySummary {
  /** 窗口天数（含今天） */
  days: number;
  /** 中等强度分钟（1:1 计入） */
  moderate_min: number;
  /** 高强度分钟（原始分钟，折算时 ×2） */
  vigorous_min: number;
  /** 轻松骑分钟（IF<0.6；不计入达标，单列披露） */
  light_min: number;
  /** WHO 等效中等强度分钟 = moderate + 2×vigorous */
  equivalent_min: number;
  target_min: number;
  extra_min: number;
}

/** TSS + 时长反推 IF（TSS = h × IF² × 100） */
function inferIf(tss: number | null, minutes: number): number | null {
  if (tss == null || !Number.isFinite(tss) || tss <= 0 || minutes <= 0) return null;
  return Math.sqrt((tss * 60) / (minutes * 100));
}

/**
 * 汇总近 N 天活动量。rows 的 date 必须为本地日历日；窗口外的行忽略。
 * duration 缺失/≤0 的行跳过（无法计分钟）。
 */
export function summarizeWeeklyActivity(
  rows: HealthActivityRow[],
  today: string,
  days: number = 7,
): WeeklyActivitySummary {
  const span = Number.isInteger(days) && days > 0 ? days : 7;
  const start = addDaysStr(today, -(span - 1));
  let moderate = 0;
  let vigorous = 0;
  let light = 0;
  for (const r of rows) {
    if (!r || typeof r.date !== 'string' || r.date < start || r.date > today) continue;
    const minutes = Math.round((Number(r.duration_sec) || 0) / 60);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;

    const ifv =
      r.intensity_factor != null && Number.isFinite(Number(r.intensity_factor))
        ? Number(r.intensity_factor)
        : inferIf(r.tss, minutes);
    if (ifv != null) {
      if (ifv >= IF_VIGOROUS) vigorous += minutes;
      else if (ifv >= IF_MODERATE) moderate += minutes;
      else light += minutes;
    } else if (r.category === 'race') {
      vigorous += minutes; // 无功率比赛按高强度计
    } else {
      moderate += minutes; // 无功率的日常骑行按中等计（数据不足时的宽松口径）
    }
  }
  return {
    days: span,
    moderate_min: moderate,
    vigorous_min: vigorous,
    light_min: light,
    equivalent_min: moderate + 2 * vigorous,
    target_min: WHO_ACTIVITY_TARGET.moderate_min,
    extra_min: WHO_ACTIVITY_TARGET.extra_min,
  };
}

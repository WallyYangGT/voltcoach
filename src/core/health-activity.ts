/**
 * health-activity.ts — WHO 周活动量口径（业余模式首页健康瓦片，纯函数、无 IO）。
 *
 * 目标用户是「以健康/习惯为主」的业余骑友：成绩指标（FTP/CTL）之外给一个
 * 与训练水平无关、每天都能推进的成功指标。口径对齐 WHO 2020 指南：
 * 每周 150–300 分钟中等强度（或 75–150 分钟高强度），高强度按 1:2 折算中等。
 *
 * 强度判定（按优先级）：
 *  1. 功率可信（FTP 已校准且该次骑行未被标记 power_flagged）且 IF 可用：
 *     IF ≥ 0.9（Z4 起）高强度、0.55–0.9（Z2–Z3）中等、<0.55（Z1）轻松（单列披露）；
 *  2. IF 缺失但 TSS 与时长可用：按 TSS = 时长h × IF² × 100 反推 IF；
 *  3. 功率不可信（未校准/被标记）或数据缺失：category='race' 视为高强度，其余按中等
 *     计（宽松口径：数据不足时不惩罚用户；提示词侧仍要求校准心率/功率锚点）。
 *
 * 阈值从 POWER_ZONES 派生（Z2 下沿 = 中等、Z4 下沿 = 高强度），与训练分区单源。
 * 窗口：以本地日历日「今天」为末端的近 N 天（默认 7，含今天）；日期必须已是
 * 本地日（调用方经 useRideDateLabels/localDayFromUtc 换算，与 §24 展示口径一致）。
 * 累加按秒进行、最后统一取整到分钟（避免大量短途逐条四舍五入向上偏差）。
 */

import { addDaysStr } from './dossier.ts';
import { POWER_ZONES } from './settings.ts';

/** WHO 健康目标（中等强度分钟/周） */
export const WHO_ACTIVITY_TARGET = {
  moderate_min: 150,
  extra_min: 300,
} as const;

/** 强度分界（与功率分区单源：按区名取 Z2 下沿 = 中等、Z4 下沿 = 高强度） */
export const HEALTH_IF_MODERATE = POWER_ZONES.find((z) => z.name === 'Z2')?.min ?? 0.55;
export const HEALTH_IF_VIGOROUS = POWER_ZONES.find((z) => z.name === 'Z4')?.min ?? 0.9;

export interface HealthActivityRow {
  /** 本地日历日 YYYY-MM-DD */
  date: string;
  duration_sec: number | null;
  intensity_factor: number | null;
  tss: number | null;
  category?: string | null;
  /** 功率被标记不可信时 IF/TSS 不参与分档（档案层同口径） */
  power_flagged?: boolean;
}

export interface WeeklyActivitySummary {
  /** 窗口天数（含今天） */
  days: number;
  /** 中等强度分钟（1:1 计入） */
  moderate_min: number;
  /** 高强度原始分钟（折算时 ×2） */
  vigorous_min: number;
  /** 高强度折算后的等效中等分钟（与 equivalent_min 同口径，供披露行使用） */
  vigorous_equivalent_min: number;
  /** 轻松骑分钟（IF<0.55；不计入达标，单列披露） */
  light_min: number;
  /** WHO 等效中等强度分钟 = moderate + 2×vigorous */
  equivalent_min: number;
  target_min: number;
  extra_min: number;
  /** FTP 是否已校准（false 时 IF 未参与分档，UI 据此披露估计口径） */
  power_trusted: boolean;
}

export interface WeeklyActivityOptions {
  /** FTP 是否已校准；false 时忽略 IF/TSS（默认 true） */
  powerTrusted?: boolean;
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
  opts: WeeklyActivityOptions = {},
): WeeklyActivitySummary {
  const span = Number.isInteger(days) && days > 0 ? days : 7;
  const powerTrusted = opts.powerTrusted !== false;
  const start = addDaysStr(today, -(span - 1));
  let moderateSec = 0;
  let vigorousSec = 0;
  let lightSec = 0;
  for (const r of rows) {
    if (!r || typeof r.date !== 'string' || r.date < start || r.date > today) continue;
    const seconds = Number(r.duration_sec);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const minutes = seconds / 60;

    // 功率不可信（未校准 FTP / 该次骑行被标记）：IF/TSS 不参与分档
    const powerUsable = powerTrusted && !r.power_flagged;
    const ifv = powerUsable
      ? (r.intensity_factor != null && Number.isFinite(Number(r.intensity_factor))
          ? Number(r.intensity_factor)
          : inferIf(r.tss, minutes))
      : null;
    if (ifv != null) {
      if (ifv >= HEALTH_IF_VIGOROUS) vigorousSec += seconds;
      else if (ifv >= HEALTH_IF_MODERATE) moderateSec += seconds;
      else lightSec += seconds;
    } else if (r.category === 'race') {
      vigorousSec += seconds; // 无功率/未校准比赛按高强度计
    } else {
      moderateSec += seconds; // 数据不足时的宽松口径：按中等计
    }
  }
  return {
    days: span,
    moderate_min: Math.round(moderateSec / 60),
    vigorous_min: Math.round(vigorousSec / 60),
    vigorous_equivalent_min: Math.round((2 * vigorousSec) / 60),
    light_min: Math.round(lightSec / 60),
    equivalent_min: Math.round((moderateSec + 2 * vigorousSec) / 60),
    target_min: WHO_ACTIVITY_TARGET.moderate_min,
    extra_min: WHO_ACTIVITY_TARGET.extra_min,
    power_trusted: powerTrusted,
  };
}

/**
 * plan-adherence.ts — 计划执行情况纯函数（U1 收尾②：本地 adherence 视图的判定层）。
 *
 * 「本周」计划 vs 实际并排，三态判定（完成 / 降强完成 / 未做）与 07-training-plan
 * 技能的执行对比方法论配套；量化单源 PLAN_ADHERENCE.done_ratio（settings）。
 *
 * 口径：
 * - 状态只按 TSS 判（TSS 已合成强度×时长），实际时长仅并排展示；
 * - 计划 TSS 缺失先经 resolvePlanTss 回填（与计划页/AI 面同一份估算）；
 * - 未来与「今天未练」不评（pending）——今天还没过完，不能判未做；
 * - 无课日与计划休息日不评（null）——adherence 评的是「计划课的执行」；
 * - 调用方负责把实际训练归并到本地日历日（records 首帧换算，§24 同伞），
 *   本层只收 { date(本地日), tss, durationSec }。
 */

import { PLAN_ADHERENCE } from './settings.ts';
import { resolvePlanTss, type PlanSession } from './training-plan.ts';

/** 某本地日历日的实际训练合计（调用方按 records 首帧归并后传入） */
export interface DayActual {
  date: string;
  tss: number;
  durationSec: number;
}

export type AdherenceStatus = 'done' | 'partial' | 'missed' | 'pending';

export interface DayAdherence {
  date: string;
  /** 计划课（TSS 已回填；null=无课/休息日，不评） */
  planned: PlanSession | null;
  plannedTss: number;
  plannedMin: number | null;
  actualTss: number;
  /** 实际时长（分钟，取整展示） */
  actualMin: number;
  /** done=完成 / partial=降强完成 / missed=未做 / pending=未到不评；null=无课不评 */
  status: AdherenceStatus | null;
}

/**
 * 周执行判定：weekSessions 传 slicePlanWeek 的周切片（可能含显式 rest），actuals 按
 * 本地日历日聚合，today 为本地「今天」。只对排了非 rest 课的日期出结论，其余日
 * status=null（渲染侧自行决定是否省略）。
 */
export function computeAdherence(
  weekSessions: PlanSession[],
  actuals: DayActual[],
  today: string,
): DayAdherence[] {
  const backfilled = resolvePlanTss(weekSessions);
  // 同日多条直接相加（一天多骑；调用方通常已归并，这里防御性兜住不丢数据）
  const actualByDay = new Map<string, DayActual>();
  for (const a of actuals) {
    const cur = actualByDay.get(a.date);
    if (cur) {
      cur.tss += a.tss;
      cur.durationSec += a.durationSec;
    } else {
      actualByDay.set(a.date, { ...a });
    }
  }
  // 逐日展开（计划可能整日无课），顺序随切片日期升序
  const dates = [...new Set(backfilled.map((s) => s.date))].sort();

  return dates.map((date) => {
    const planned = backfilled.find((s) => s.date === date) ?? null;
    const actual = actualByDay.get(date);
    const actualTss = actual?.tss ?? 0;
    const actualMin = Math.round((actual?.durationSec ?? 0) / 60);
    const plannedTss = planned?.tss ?? 0;

    // 无课/休息日不评；注意 planned 可能是显式 rest（duration_min=null）
    if (!planned || planned.type === 'rest') {
      return { date, planned, plannedTss: 0, plannedMin: planned?.duration_min ?? null, actualTss, actualMin, status: null };
    }

    let status: AdherenceStatus;
    if (date > today || (date === today && actualTss <= 0)) {
      status = 'pending'; // 未到 / 今天还没练（今天练了就按实际判）
    } else if (plannedTss <= 0) {
      status = actualTss > 0 ? 'done' : 'missed';
    } else if (actualTss >= plannedTss * PLAN_ADHERENCE.done_ratio) {
      status = 'done';
    } else if (actualTss > 0) {
      status = 'partial';
    } else {
      status = 'missed';
    }

    return { date, planned, plannedTss, plannedMin: planned.duration_min, actualTss, actualMin, status };
  });
}

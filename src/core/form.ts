/**
 * form.ts — CTL/ATL/TSB 负荷模型递推（纯函数，无 IO）
 *
 * 移植自 reference/src/db.js 的 dailyTssSeries / computeForm / recentFormDaily
 * 的计算段：SQLite 查询由 src/db 层负责，本模块只做「逐日 TSS 序列 → form 递推」，
 * 使递推口径可在 node:test 中直接覆盖（口径与 TrainingPeaks 一致）：
 *   CTL_d = CTL_{d-1} + (TSS_d − CTL_{d-1}) / 42   慢性负荷（体能）
 *   ATL_d = ATL_{d-1} + (TSS_d − ATL_{d-1}) / 7    急性负荷（疲劳）
 *   TSB   = CTL − ATL                              状态（正值=新鲜）
 * 初始值 0，缺天按 TSS=0 参与衰减（休息日同样衰减）。
 */

import { formNote, type Lang } from './i18n.ts';

/** 逐日 TSS（date 为 YYYY-MM-DD，UTC 口径——与训练库日期/records 时间戳前 10 位一致） */
export interface DailyTss {
  date: string;
  tss: number;
}

/** 当日 form 快照（入库后注入 summary.athlete_context；界面按 form_state 重新本地化） */
export interface FormSnapshot {
  ctl: number;
  atl: number;
  tsb: number;
  form_state: 'fresh' | 'good' | 'balanced' | 'fatigued' | 'overtrained';
  form_note: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * 补齐缺天：库内按天聚合的 TSS 行 → [首行日期, endDate] 的连续逐日序列
 * （缺天 TSS=0，休息日同样参与 CTL/ATL 衰减）。rows 需按 date 升序。
 */
export function fillDailyTss(rows: DailyTss[], endDate: string): DailyTss[] {
  if (!rows.length) return [];
  const series: DailyTss[] = [];
  const byDate = new Map(rows.map((r) => [r.date, r.tss]));
  const cur = new Date(rows[0].date + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    series.push({ date: d, tss: byDate.get(d) ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return series;
}

/** 逐日递推 CTL/ATL/TSB（输入连续逐日序列，输出每天的快照，日期升序） */
export function formSeriesDaily(series: DailyTss[]): { date: string; tss: number; ctl: number; atl: number; tsb: number }[] {
  let ctl = 0,
    atl = 0;
  return series.map((d) => {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
    return { date: d.date, tss: r1(d.tss), ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) };
  });
}

/** 序列末端（当天）的 form 快照；空序列返回 null（训练库为空） */
export function formSnapshotAtEnd(series: DailyTss[], lang: Lang = 'zh'): FormSnapshot | null {
  const daily = formSeriesDaily(series);
  if (!daily.length) return null;
  const last = daily[daily.length - 1];
  const tsb = last.tsb;
  const state: FormSnapshot['form_state'] =
    tsb >= 15 ? 'fresh' : tsb >= 5 ? 'good' : tsb >= -10 ? 'balanced' : tsb >= -20 ? 'fatigued' : 'overtrained';
  return {
    ctl: last.ctl,
    atl: last.atl,
    tsb: last.tsb,
    form_state: state,
    form_note: formNote(tsb, lang),
  };
}

/**
 * monthly.ts — 月度训练汇总（纯函数，无 IO）
 *
 * 移植自 reference/src/db.js monthlySummary 的归并计算段（M1 form.ts 同款拆法：
 * SQLite 查询由 src/db 层负责，本模块只做「训练行 → 按自然月归并」，
 * 使归并口径可在 node:test 中直接覆盖）：
 *   - 月 TSS / 时长 / 距离 / 次数按 date 前 7 位（YYYY-MM）归并；
 *   - 强度占比 = zone_distribution_pct × 时长 加权（低=Z1-Z2 / 中=Z3-Z4 / 高=Z5-Z7）；
 *   - 类型判定：低 ≥75% 且 高>中 → polarized（极化）；低>中>高 → pyramidal（金字塔）；
 *     其余 → sweet_spot（甜区/阈值取向）；窗口内无功率强度数据时均为 null。
 */

/** 月度汇总输入行（db 层 SELECT date, duration_sec, distance_km, tss, summary_json 的行形状） */
export interface MonthlyRow {
  date: string;
  duration_sec: number | null;
  distance_km: number | null;
  tss: number | null;
  summary_json: string;
}

/** 低/中/高强度时间占比（%，保留 1 位小数） */
export interface IntensityPct {
  low: number;
  mid: number;
  high: number;
}

/** 单月汇总项（intensity_type：极化/金字塔/甜区取向，无强度数据时为 null） */
export interface MonthlyItem {
  month: string; // YYYY-MM
  tss: number;
  hours: number;
  distance_km: number;
  sessions: number;
  intensity_pct: IntensityPct | null;
  intensity_type: 'polarized' | 'pyramidal' | 'sweet_spot' | null;
}

/** 最近 n 个月汇总（按自然月倒序截取；逻辑与旧版 monthlySummary 逐字平移） */
export function monthlySummaryFromRows(rows: MonthlyRow[], n = 6): MonthlyItem[] {
  interface MonthAcc {
    month: string;
    tss: number;
    duration_sec: number;
    distance_km: number;
    count: number;
    low: number; // 各强度档加权秒数
    mid: number;
    high: number;
  }

  const months = new Map<string, MonthAcc>();
  for (const r of rows) {
    const m = r.date.slice(0, 7); // YYYY-MM
    if (!months.has(m)) {
      months.set(m, {
        month: m,
        tss: 0,
        duration_sec: 0,
        distance_km: 0,
        count: 0,
        low: 0,
        mid: 0,
        high: 0,
      });
    }
    const agg = months.get(m)!;
    const dur = r.duration_sec ?? 0;
    agg.tss += r.tss ?? 0;
    agg.duration_sec += dur;
    agg.distance_km += r.distance_km ?? 0;
    agg.count += 1;
    // 强度分布：zone_distribution_pct × 时长 加权累计
    try {
      const z = JSON.parse(r.summary_json).power?.zone_distribution_pct;
      if (z && dur > 0) {
        agg.low += ((z.Z1 ?? 0) + (z.Z2 ?? 0)) * 0.01 * dur;
        agg.mid += ((z.Z3 ?? 0) + (z.Z4 ?? 0)) * 0.01 * dur;
        agg.high += ((z.Z5 ?? 0) + (z.Z6 ?? 0) + (z.Z7 ?? 0)) * 0.01 * dur;
      }
    } catch {
      // 存档 JSON 损坏时跳过强度分布，不影响其他字段
    }
  }

  const result = [...months.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, n)
    .map((w): MonthlyItem => {
      const zoneTotal = w.low + w.mid + w.high;
      const pct = (x: number) =>
        zoneTotal > 0 ? Math.round((x / zoneTotal) * 1000) / 10 : null;
      const lowPct = pct(w.low),
        midPct = pct(w.mid),
        highPct = pct(w.high);
      let intensity_type: MonthlyItem['intensity_type'] = null;
      if (lowPct != null) {
        // 极化：大量低强度 + 高强度多于中强度；金字塔：低>中>高；其余归为甜区/阈值取向
        //（lowPct 非 null 蕴含 zoneTotal>0，故三档均非 null——断言仅供类型收窄）
        if (lowPct >= 75 && highPct! > midPct!) intensity_type = 'polarized';
        else if (lowPct > midPct! && midPct! > highPct!) intensity_type = 'pyramidal';
        else intensity_type = 'sweet_spot';
      }
      return {
        month: w.month,
        tss: Math.round(w.tss),
        hours: Math.round((w.duration_sec / 3600) * 10) / 10,
        distance_km: Math.round(w.distance_km * 10) / 10,
        sessions: w.count,
        intensity_pct:
          lowPct != null ? { low: lowPct, mid: midPct!, high: highPct! } : null,
        intensity_type,
      };
    });
  return result;
}

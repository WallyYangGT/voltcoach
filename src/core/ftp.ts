/**
 * ftp.ts — FTP 历史估算（纯函数、无 IO）：基于最近窗口期内全部骑行训练的
 * 功率峰曲线 + 心率响应做联合估算，给出估值、置信度与数据收集建议。
 *
 * 移植自 reference/src/ftp.js（逻辑原样、只补类型；zh 文案与旧版逐字一致——回归断言依赖）。
 *
 * 科学参照：
 *   1. 双参数临界功率模型（Morton CP/W′ 模型）：
 *      P(t) = CP + W′/t，用 5min 与 20min 两个锚点解出 CP ≈ FTP；
 *   2. Coggan《Training and Racing with a Power Meter》：
 *      FTP ≈ 20 分钟峰功率 × 0.95；
 *   3. 心率交叉验证：全力 20min 测试心率峰值应接近 LTHR/HRmax 高位；
 *      功率区间与心率区间的系统性偏移提示 FTP 配置漂移；
 *      有氧解耦（hr drift）> 5% 提示疲劳/脱水/高温导致的数据漂移。
 */

import type { Summary } from './analyze.ts';
import { t, type Lang } from './i18n.ts';
import { FTP_ESTIMATION, type AthleteParams } from './settings.ts';

/** 阈值配置口径（settings.ts 集中管理，测试可注入覆盖） */
export type FtpEstimationConfig = typeof FTP_ESTIMATION;

/** 窗口内单次骑行（db 层 cyclingSummariesSince 的元素形状） */
export interface CyclingRideInput {
  file_name: string;
  date: string;
  duration_sec: number | null;
  summary: Summary;
}

/** 方法一：CP 模型结果（p5/p20 为窗口内最佳峰功率锚点） */
export interface FtpCpModel {
  ftp_w: number;
  cp_w: number;
  w_prime_kj: number;
  p5: PeakAnchor;
  p20: PeakAnchor;
}

/** 峰功率锚点（来自窗口内哪次骑行的哪个值） */
export interface PeakAnchor {
  watts: number;
  date: string;
  file_name: string;
}

/** 方法二：Coggan 20min × 0.95 结果 */
export interface FtpCoggan {
  ftp_w: number;
  peak_20min_w: number;
  date: string;
  file_name: string;
}

/** 方法三：心率交叉验证（maximal_effort: true=全力可信 / false=大概率非全力 / null=无心率无法判定） */
export interface FtpHrCheck {
  maximal_effort: boolean | null;
  best20_max_hr: number | null;
  threshold_hr: number;
  zone_mismatch: {
    power_high_pct: number;
    hr_high_pct: number;
    diff_pct: number;
    direction: 'consistent' | 'power_above_hr' | 'hr_above_power';
  } | null;
  median_hr_drift_pct: number | null;
}

/** 合成估值：两法均值 + 区间 + 置信度 */
export interface FtpHistoryEstimate {
  ftp_w: number;
  range_low: number;
  range_high: number;
  confidence: 'high' | 'medium' | 'low';
  confidence_note: string;
  current_ftp_w: number;
  diff_w: number;
  methods: {
    cp_model: FtpCpModel | null;
    coggan_20min: FtpCoggan;
    hr_check: FtpHrCheck;
  };
}

/** estimateFtpFromHistory 返回（status=insufficient 时 estimate 为 null） */
export interface FtpEstimationResult {
  status: 'ok' | 'insufficient';
  window_days: number;
  sample: {
    cycling_rides: number;
    rides_with_power: number;
    usable_power_rides: number;
    rides_with_hr: number;
  };
  estimate: FtpHistoryEstimate | null;
  data_needs: string[];
  notes: string[];
  references: string[];
}

/** 中位数（输入可含 null/undefined，自动过滤；空数组返回 null） */
function median(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * 从历史骑行估算 FTP。
 * @param activities 窗口内骑行（db.cyclingSummariesSince 的输出）
 * @param athlete 骑手参数（AthleteParams：ftp_watts / max_hr / weight_kg）
 * @param cfg 阈值配置（默认 settings.ts 的 FTP_ESTIMATION）
 * @param lang 消息语言（zh/en，默认 zh；zh 与旧版逐字一致）
 */
export function estimateFtpFromHistory(
  activities: CyclingRideInput[],
  athlete: AthleteParams,
  cfg: FtpEstimationConfig = FTP_ESTIMATION,
  lang: Lang = 'zh',
): FtpEstimationResult {
  const dataNeeds: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = []; // 影响置信度的内部标记

  // ---- 1. 样本筛选：仅采信功率覆盖率达标且有 power 段的骑行 ----
  const withPower = activities.filter((a) => a.summary?.power);
  const usable = withPower.filter(
    (a) =>
      (a.summary.data_quality?.power_coverage_pct ?? 100) >=
      cfg.min_coverage_pct,
  );
  const withHr = usable.filter(
    (a) =>
      a.summary?.heart_rate &&
      (a.summary.data_quality?.hr_coverage_pct ?? 0) >= cfg.min_coverage_pct,
  );
  const sample = {
    cycling_rides: activities.length,
    rides_with_power: withPower.length,
    usable_power_rides: usable.length,
    rides_with_hr: withHr.length,
  };

  if (usable.length < cfg.min_rides) {
    dataNeeds.push(t(lang, 'ftp.few_rides', { n: usable.length, min: cfg.min_rides }));
    warnings.push('few_rides');
  }
  if (usable.length && withHr.length < usable.length) {
    dataNeeds.push(
      t(lang, 'ftp.hr_coverage', { n: withHr.length, total: usable.length }),
    );
    warnings.push('hr_coverage');
  }

  // ---- 2. 窗口内最佳 5min / 20min 峰功率（CP 模型与 Coggan 法的锚点） ----
  const bestPeak = (key: '5min' | '20min'): PeakAnchor | null => {
    let best: PeakAnchor | null = null;
    for (const a of usable) {
      const w = a.summary.power?.peak_curve?.[key];
      if (w == null) continue;
      if (!best || w > best.watts)
        best = { watts: w, date: a.date, file_name: a.file_name };
    }
    return best;
  };
  const p5 = bestPeak('5min');
  const p20 = bestPeak('20min');

  if (!p20) {
    dataNeeds.push(t(lang, 'ftp.no_20min'));
    return {
      status: 'insufficient',
      window_days: cfg.window_days,
      sample,
      estimate: null,
      data_needs: dataNeeds,
      notes,
      references: methodReferences(lang),
    };
  }

  // ---- 3. 方法一：双参数 CP 模型（Morton）：P(t) = CP + W′/t ----
  let cpModel: FtpCpModel | null = null;
  if (p5 && p5.watts > p20.watts) {
    const t1 = cfg.cp_short_sec,
      t2 = cfg.cp_long_sec;
    const cp = (p20.watts * t2 - p5.watts * t1) / (t2 - t1);
    if (cp > 0) {
      cpModel = {
        ftp_w: Math.round(cp),
        cp_w: Math.round(cp),
        w_prime_kj: r1(((p5.watts - cp) * t1) / 1000),
        p5,
        p20,
      };
    }
  }
  if (!cpModel) {
    notes.push(t(lang, 'ftp.cp_unavailable'));
    warnings.push('single_method');
  } else {
    dataNeeds.push(t(lang, 'ftp.cp_precision'));
  }

  // ---- 4. 方法二：Coggan 20min × 0.95 ----
  const coggan: FtpCoggan = {
    ftp_w: Math.round(p20.watts * cfg.coggan_factor),
    peak_20min_w: p20.watts,
    date: p20.date,
    file_name: p20.file_name,
  };

  // ---- 5. 心率交叉验证 ----
  const hrCheck: FtpHrCheck = {
    maximal_effort: null, // true=全力可信 / false=大概率非全力 / null=无心率无法判定
    best20_max_hr: null,
    threshold_hr: null as unknown as number,
    zone_mismatch: null,
    median_hr_drift_pct: null,
  };

  // 5a. 全力判定：20min 峰功率所在骑行的心率峰值是否达到全力阈值
  const anchor = usable.find((a) => a.file_name === p20.file_name);
  const thresholdHr = Math.round(athlete.max_hr * cfg.max_effort_hr_pct);
  hrCheck.threshold_hr = thresholdHr;
  const anchorHr = anchor?.summary.heart_rate;
  if (
    anchorHr &&
    (anchor?.summary.data_quality?.hr_coverage_pct ?? 0) >= cfg.min_coverage_pct
  ) {
    hrCheck.best20_max_hr = anchorHr.max ?? null;
    hrCheck.maximal_effort =
      hrCheck.best20_max_hr != null && hrCheck.best20_max_hr >= thresholdHr;
    if (!hrCheck.maximal_effort) {
      notes.push(
        t(lang, 'ftp.not_maximal', {
          date: p20.date,
          hr: hrCheck.best20_max_hr ?? '', // 该分支 maximal_effort=false 蕴含非 null，仅类型兜底（插值对空串同输出）
          thr: thresholdHr,
        }),
      );
      dataNeeds.push(t(lang, 'ftp.maximal_test'));
      warnings.push('not_maximal');
    }
  } else {
    notes.push(t(lang, 'ftp.anchor_no_hr'));
    dataNeeds.push(t(lang, 'ftp.anchor_hr'));
    warnings.push('not_maximal');
  }

  // 5b. 功率/心率区间一致性（时长加权）：系统性偏移提示 FTP 配置漂移
  let pHighSec = 0,
    hHighSec = 0,
    bothSec = 0;
  for (const a of withHr) {
    const dur = a.duration_sec ?? 0;
    const pz = a.summary.power?.zone_distribution_pct;
    const hz = a.summary.heart_rate?.zone_distribution_pct;
    if (!pz || !hz || dur <= 0) continue;
    pHighSec += ((pz.Z5 ?? 0) + (pz.Z6 ?? 0) + (pz.Z7 ?? 0)) * 0.01 * dur;
    hHighSec += ((hz.Z4 ?? 0) + (hz.Z5 ?? 0)) * 0.01 * dur;
    bothSec += dur;
  }
  if (bothSec > 0) {
    const pPct = r1((pHighSec / bothSec) * 100);
    const hPct = r1((hHighSec / bothSec) * 100);
    const diff = r1(pPct - hPct);
    let direction: NonNullable<FtpHrCheck['zone_mismatch']>['direction'] = 'consistent';
    if (diff >= cfg.zone_mismatch_pct) {
      direction = 'power_above_hr';
      notes.push(t(lang, 'ftp.power_above_hr', { p: pPct, h: hPct }));
      warnings.push('zone_mismatch');
    } else if (diff <= -cfg.zone_mismatch_pct) {
      direction = 'hr_above_power';
      notes.push(t(lang, 'ftp.hr_above_power', { h: hPct, p: pPct }));
      warnings.push('zone_mismatch');
    }
    hrCheck.zone_mismatch = {
      power_high_pct: pPct,
      hr_high_pct: hPct,
      diff_pct: diff,
      direction,
    };
  }

  // 5c. 有氧解耦：心率漂移中位数超阈值 → 数据漂移提示
  const driftMedian = median(
    withHr.map((a) => a.summary.heart_rate?.hr_drift_pct),
  );
  hrCheck.median_hr_drift_pct = driftMedian != null ? r1(driftMedian) : null;
  if (driftMedian != null && driftMedian > cfg.drift_warn_pct) {
    notes.push(t(lang, 'ftp.drift', { d: r1(driftMedian), t: cfg.drift_warn_pct }));
    warnings.push('drift');
  }

  // ---- 6. 合成估值与置信度 ----
  const ftps = [cpModel?.ftp_w, coggan.ftp_w].filter((x): x is number => x != null);
  const ftpW = Math.round(ftps.reduce((a, b) => a + b, 0) / ftps.length);
  const rangeLow = Math.min(...ftps);
  const rangeHigh = Math.max(...ftps);
  const consistent =
    ftps.length === 2 &&
    (rangeHigh - rangeLow) / ftpW <= cfg.consistency_pct / 100;

  let confidence: FtpHistoryEstimate['confidence'] = 'high';
  if (!consistent) warnings.push('inconsistent');
  if (warnings.includes('inconsistent') || warnings.includes('single_method'))
    confidence = 'medium';
  if (
    warnings.includes('not_maximal') ||
    warnings.includes('zone_mismatch') ||
    warnings.includes('drift') ||
    warnings.includes('hr_coverage')
  )
    confidence = 'medium';
  if (warnings.includes('few_rides')) confidence = 'low';

  const estimate: FtpHistoryEstimate = {
    ftp_w: ftpW,
    range_low: rangeLow,
    range_high: rangeHigh,
    confidence,
    confidence_note: confidenceNote(confidence, lang),
    current_ftp_w: athlete.ftp_watts,
    diff_w: ftpW - athlete.ftp_watts,
    methods: {
      cp_model: cpModel,
      coggan_20min: coggan,
      hr_check: hrCheck,
    },
  };

  return {
    status: 'ok',
    window_days: cfg.window_days,
    sample,
    estimate,
    data_needs: dataNeeds,
    notes,
    references: methodReferences(lang),
  };
}

function confidenceNote(c: FtpHistoryEstimate['confidence'], lang: Lang): string {
  return t(lang, `ftp.confidence.${c}`);
}

function methodReferences(lang: Lang): string[] {
  return [0, 1, 2].map((i) => t(lang, `ftp.ref.${i}`));
}

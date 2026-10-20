/**
 * ftp.ts — FTP 历史估算（纯函数、无 IO）：基于最近窗口期内全部骑行训练的
 * 功率峰曲线 + 心率响应做联合估算，给出估值、置信度与数据收集建议。
 *
 * 移植自 fit-reader Web 版 src/ftp.js（逻辑原样、只补类型；zh 文案与旧版逐字一致——回归断言依赖）。
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
  /** 活动稳定身份（v3；锚点匹配用） */
  uuid: string;
  file_name: string;
  date: string;
  duration_sec: number | null;
  summary: Summary;
  /** 该骑行是否被标记「功率不可信」（v2）：估算样本剔除（功率失真的锚点只会产出失真的 FTP） */
  power_flagged?: boolean;
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
  uuid: string;
  file_name: string;
}

/** 方法二：Coggan 20min × 0.95 结果 */
export interface FtpCoggan {
  ftp_w: number;
  peak_20min_w: number;
  date: string;
  uuid: string;
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

  // ---- 1. 样本筛选：被标记「功率不可信」的骑行剔除（功率失真的锚点只会产出失真的
  // FTP——特别是系统性偏高会借 power_above_hr 降级路径把虚高值写进用户配置），
  // 其余仅采信功率覆盖率达标且有 power 段的骑行 ----
  const flaggedCount = activities.filter((a) => a.power_flagged === true).length;
  if (flaggedCount > 0) {
    dataNeeds.push(t(lang, 'ftp.flagged_excluded', { n: flaggedCount }));
  }
  const notFlagged = activities.filter((a) => a.power_flagged !== true);
  const withPower = notFlagged.filter((a) => a.summary?.power);
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
        best = { watts: w, date: a.date, uuid: a.uuid, file_name: a.file_name };
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
    uuid: p20.uuid,
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
  const anchor = usable.find((a) => a.uuid === p20.uuid);
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

// ---------------- AI 自动采纳门槛（evaluateFtpApply，M5 新增） ----------------

/** 采纳校验结果：ok=false 时 reason_key 为 core/i18n 的 ftp.apply.* 文案键（reason_vars 供插值） */
export interface FtpApplyCheck {
  ok: boolean;
  reason_key: string | null;
  reason_vars?: Record<string, string | number>;
}

const applyReject = (
  key: string,
  vars?: Record<string, string | number>,
): FtpApplyCheck => ({ ok: false, reason_key: key, reason_vars: vars });

/**
 * FTP 校准判据（2026-10-20 收紧，decisions §35）：健康瓦片 IF 采信与 AI 侧
 * `athlete_configured` 的统一口径（实现在 db.isFtpCalibrated）。
 *
 * 两半：
 *  - 溯源戳 ftp_updated_at 非空 —— 曾有一次 FTP 值实际变更（manual/estimate/ai_coach）；
 *  - FTP 值不等于出厂默认 —— 兼容引入溯源戳之前的存量库。
 * 已知边界：用户把 FTP 恰好设为出厂默认值（106W）时值未变、不盖戳，会被判未校准——
 * 无法区分「从未设置」与「明确设成默认值」，按保守口径处理（不采信 IF）。
 *
 * 旧版撤销的假戳（≤0.4.0）：旧 undo 恢复默认值时因值变化盖 `manual` 戳，但撤销不是
 * 校准。值=默认 + `manual` 戳 + 无待处理 AI 快照 → 按「无戳」判未校准（读时归一化，
 * 不改写存量数据）；代价是「用户明确从别的值改回 106W」也判未校准——与上一条的保守
 * 口径一致。AI 更新留下的 `ai_coach` 戳（快照可撤销）仍算校准。
 *
 * AI 更新被撤销时由 undoAiFtpUpdate 恢复撤销前的溯源戳，避免「撤销回默认值」被
 * 误判为已校准（code-review P1）。
 */
export function isFtpCalibratedFrom(
  ftpWatts: number,
  ftpUpdatedAt: string | null | undefined,
  defaultFtpWatts: number,
  opts?: { source?: string | null; hasAiUpdate?: boolean },
): boolean {
  const stamped = typeof ftpUpdatedAt === 'string' && ftpUpdatedAt.trim().length > 0;
  const valueCalibrated = ftpWatts !== defaultFtpWatts;
  if (!valueCalibrated && stamped && opts?.source === 'manual' && !opts?.hasAiUpdate) {
    // 默认值 + manual 戳 + 无 AI 快照：旧撤销假戳（或无法证明的「明确设为默认值」）
    return false;
  }
  return stamped || valueCalibrated;
}

/** 写入值选定结果：requested_w 为调用方给的原值（缺省 null），clamped 表示被夹逼到区间边界 */
export interface FtpSelection {
  /** 最终写入值（恒在估算区间内） */
  ftp_w: number;
  /** 模型自选的原值（取整后；缺省/非有限数为 null） */
  requested_w: number | null;
  /** 自选值被夹逼到 range_low/range_high 边界 */
  clamped: boolean;
}

/**
 * 从估算结果选定写入值（AI 教练在估算区间内自选 FTP，2026-10-20）。
 *
 * 缺省（requested 省略/非有限数）取估算器输出（两法均值）；给了 requested 时
 * **夹逼到本次估算区间 [range_low, range_high]**——模型只能在科学估算的区间内
 * 表达保守/激进的取舍，永远写不出区间外的值（幻觉写值防护不弱化）。
 * 写入前的 50–500W 采纳范围闸仍由 evaluateFtpApply 在最终值上执行。
 */
export function selectFtpFromEstimate(
  result: FtpEstimationResult,
  requested?: number | null,
): FtpSelection | null {
  const e = result.estimate;
  if (result.status !== 'ok' || !e) return null;
  if (requested == null || !Number.isFinite(requested)) {
    return { ftp_w: e.ftp_w, requested_w: null, clamped: false };
  }
  const want = Math.round(requested);
  const ftp_w = Math.min(Math.max(want, e.range_low), e.range_high);
  return { ftp_w, requested_w: want, clamped: ftp_w !== want };
}

/**
 * 「AI 教练自动更新 FTP」的采纳门槛（纯函数，从估算结果的结构化字段重新推导）。
 *
 * 与 FtpEstimatePanel 的 UI 门控（仅 confidence === 'high'）刻意不同：置信度口径
 * 不动（避免牵动两仓同步的估算算法），但在这里按"该警告是否动摇估值本身"重新
 * 分级——zone_mismatch（功率-心率区间错位）/ drift / hr_coverage 是「当前 FTP 配置
 * 漂移」的信号、正是该更新的依据，由其降级的 medium 放行；而数据单薄（few_rides
 * →low）、两法互斥（inconsistent）、锚点明确非全力（not_maximal）才真正不可信，拦下。
 * 数值默认取估算器输出；2026-10-20 起 AI 可在估算区间内自选（selectFtpFromEstimate
 * 夹逼，chosenW 即夹逼后的最终值）——no_change 与 50–500W 范围闸按最终值判定。
 *
 * @param result estimateFtpFromHistory 的返回
 * @param latestRideDate 窗口内最近一次骑行日期（YYYY-MM-DD；无骑行为 null）
 * @param today 今日日期（YYYY-MM-DD，调用方注入以便测试）
 * @param cfg 阈值配置（freshness_days 为 AI 采纳专属门槛）
 * @param chosenW 自选后的最终写入值（缺省取 e.ftp_w，即两法均值）
 */
export function evaluateFtpApply(
  result: FtpEstimationResult,
  latestRideDate: string | null,
  today: string,
  cfg: FtpEstimationConfig = FTP_ESTIMATION,
  chosenW?: number | null,
): FtpApplyCheck {
  const e = result.estimate;
  if (result.status !== 'ok' || !e) return applyReject('ftp.apply.no_data');
  if (result.sample.usable_power_rides < cfg.min_rides)
    return applyReject('ftp.apply.few_rides', { min: cfg.min_rides });
  if (e.confidence === 'low') return applyReject('ftp.apply.low_confidence');
  // 两法互斥：CP 模型可用时与 Coggan 法差超一致性阈值 → 估值本身不可信。
  // 分母与估算器 consistent 判定同口径（两法取整均值，即 e.ftp_w）
  const cp = e.methods.cp_model;
  if (cp && e.ftp_w > 0) {
    if (
      Math.abs(cp.ftp_w - e.methods.coggan_20min.ftp_w) / e.ftp_w >
      cfg.consistency_pct / 100
    )
      return applyReject('ftp.apply.inconsistent', { pct: cfg.consistency_pct });
  }
  // single_method（缺 5min 峰、仅 Coggan 法）放行：样本量已由 min_rides 把关，
  // 20min×0.95 单法估值仍可信（与"配置漂移"类信号同属可放行的 medium，测试钉住）
  // 锚点"明确非全力"（有合格心率且未达全力线）才拦；无心率（null）不拦——
  // 峰值法只依赖功率，缺心率只是无法交叉验证（estimateFtpFromHistory 同口径）
  if (e.methods.hr_check.maximal_effort === false)
    return applyReject('ftp.apply.not_maximal');
  // 新鲜度：窗口内最近一次骑行距今天 ≤ freshness_days（天数按 UTC 日历日差）
  if (!latestRideDate) return applyReject('ftp.apply.stale', { n: cfg.freshness_days });
  const days = Math.round(
    (Date.parse(today + 'T00:00:00Z') - Date.parse(latestRideDate + 'T00:00:00Z')) /
      86400000,
  );
  if (days > cfg.freshness_days)
    return applyReject('ftp.apply.stale', { n: cfg.freshness_days });
  const target = chosenW != null && Number.isFinite(chosenW) ? chosenW : e.ftp_w;
  if (target === e.current_ftp_w) return applyReject('ftp.apply.no_change');
  if (target < cfg.apply_min_w || target > cfg.apply_max_w)
    return applyReject('ftp.apply.range', {
      w: target,
      lo: cfg.apply_min_w,
      hi: cfg.apply_max_w,
    });
  return { ok: true, reason_key: null };
}

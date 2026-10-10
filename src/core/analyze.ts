/**
 * analyze.ts — FIT 解析与指标分析管线（纯函数层，无任何 IO）
 *
 * 移植自 fit-reader Web 版 index.js（来源 commit 35dc14f，逻辑原样、只补类型）。
 * 与旧版的唯一结构差异：analyzeFile() 依赖注入化——旧版直接 fs 读写 + 入库，
 * 本版接收 { bytes, fileName, athlete } 返回 { records, summary }，CSV/JSON 落盘
 * 与入库由调用方（App 导入服务）决定，使管线可单测、可在黄金 diff 脚本中复用。
 *
 * 解析口径：解析器按 lengthUnit:"km" 会把海拔/爬升缩放成 km，代码统一换回米；
 * FIT 解析 force:true 容忍损坏文件（FIT 视为不可信输入）。
 */

import FitParser from 'fit-file-parser';
import {
  ATHLETE,
  CADENCE_ANALYSIS,
  CLIMB_DETECTION,
  DATA_QUALITY,
  ELEVATION,
  HR_ZONES,
  INTERVAL_DETECTION,
  PEAK_CURVE,
  POWER_ZONES,
  type AthleteParams,
  type Zone,
} from './settings.ts';

// ---------------- 类型定义 ----------------

/** 重采样到 1s 网格后的逐秒记录（缺数据统一 null） */
export interface SecRecord {
  timestamp: string; // ISO-8601（UTC）
  power: number | null;
  heart_rate: number | null;
  cadence: number | null;
  altitude: number | null; // 米（1 位小数）
  speed: number | null; // km/h（2 位小数）
  distance: number | null; // 米（累计值，取整）
  temperature: number | null; // ℃
}

/** FIT event 消息（timer 事件用于暂停识别） */
export interface FitEvent {
  event?: string;
  event_type?: string;
  timestamp?: Date | string;
}

/** fit-file-parser 的解析结果（宽松类型：字段缺失是常态） */
export interface FitParsed {
  sport?: { sport?: string };
  sessions?: {
    sport?: string;
    total_distance?: number;
    avg_speed?: number;
    total_calories?: number;
    total_ascent?: number; // km 口径（解析器缩放），使用时 ×1000
    pool_length?: number;
  }[];
  records?: any[]; // record 消息，字段按设备而异，入口处统一整理
  events?: any[];
  laps?: any[];
  lengths?: any[];
}

/** 结构化异常标注（语言中立，展示时经 formatAnomaly 按语言渲染） */
export type Anomaly =
  | { type: 'power_gap' | 'record_gap' | 'timer_pause'; duration_sec: number; at: string }
  | { type: 'hr_jump'; from: number; to: number; at: string };

/** 当日 CTL/ATL/TSB（入库后由 App 层注入 summary.athlete_context） */
export interface FormContext {
  ctl: number;
  atl: number;
  tsb: number;
  form_state: 'fresh' | 'good' | 'balanced' | 'fatigued' | 'overtrained';
  form_note: string;
}

/** FTP 自动估算结果（20min 峰功率 × 0.95） */
export interface FtpEstimate {
  peak_20min_w: number;
  estimated_ftp_w: number;
  current_ftp_w: number;
  diff_w: number;
  suggestion: 'keep' | 'consider_update' | 'consider_recheck';
}

/** 峰功率曲线（type 别名以获得隐式索引签名——图表组件按 Record 消费） */
export type PeakCurve = {
  '5s'?: number;
  '1min'?: number;
  '5min'?: number;
  '20min'?: number;
};

export interface IntervalItem {
  name: string;
  start: string;
  duration_sec: number;
  avg_power: number | null;
  max_power: number | null;
  pct_ftp: number | null;
  avg_hr: number | null;
  avg_cadence: number | null;
}

export interface IntervalSet {
  count: number;
  avg_duration_sec: number;
  avg_power: number;
  avg_pct_ftp: number;
}

export interface Climb {
  name: string;
  start: string;
  duration_sec: number;
  distance_m: number;
  elevation_gain_m: number;
  avg_grade_pct: number;
  avg_power: number | null;
  avg_hr: number | null;
}

export interface CadencePower {
  sample_sec: number;
  avg_cadence: number;
  pct_low_cadence: number;
  pct_high_cadence: number;
  cadence_power_corr: number | null;
  style: 'normal' | 'low_cadence' | 'high_cadence';
}

/** 汇总训练指标（summary.json 结构，喂 AI 与界面共用） */
export interface Summary {
  activity: {
    date: string;
    sport: string;
    duration_sec: number;
    distance_km: number | null;
    elevation_gain_m: number;
    elevation_gain_source: 'device' | 'computed';
    avg_speed_kmh?: number;
    total_calories?: number;
    /** 训练分类（training/race/recovery/leisure，db 层读取时合并） */
    category?: string;
    /** 用户备注（体感/路况等自由注释，db 层读取时合并，AI 复盘纳入考量） */
    note?: string;
  };
  athlete_context: AthleteParams & Partial<FormContext>;
  power?: {
    avg: number | null;
    normalized_power: number | null;
    max: number | null;
    variability_index: number | null;
    intensity_factor: number | null;
    tss: number | null;
    w_per_kg_avg: number | null;
    peak_curve: PeakCurve;
    ftp_estimate?: FtpEstimate;
    zone_distribution_pct: Record<string, number> | null;
  };
  heart_rate: {
    avg: number | null;
    max: number | null;
    zone_distribution_pct: Record<string, number> | null;
    hr_drift_pct: number | null;
  };
  cadence: { avg: number | null };
  temperature?: { avg: number; min: number; max: number };
  pace?: { avg_pace_min_per_km: number; best_1min_pace_min_per_km: number | null };
  swim?: {
    lengths_count: number;
    pool_length_m: number | null;
    avg_length_time_sec: number | null;
    total_strokes: number | null;
    avg_swolf: number | null;
  };
  developer_fields?: Record<string, { samples: number; avg: number; min: number; max: number }>;
  cadence_power?: CadencePower;
  climbs?: Climb[];
  interval_set?: IntervalSet;
  segments?: (Record<string, unknown> | IntervalItem)[];
  anomalies?: Anomaly[];
  data_quality: {
    record_count: number;
    dropped_records_no_timestamp?: number;
    missing_seconds?: number;
    pause_seconds?: number;
    power_coverage_pct: number;
    hr_coverage_pct: number;
  };
}

/** analyzeFile 依赖注入入参 */
export interface AnalyzeInput {
  bytes: Uint8Array;
  fileName: string; // 原始文件名（入库去重键， basename 由调用方保证）
  /** 骑手参数（训练库生效值）；缺省用 settings.ts 出厂默认值 */
  athlete?: Partial<AthleteParams>;
}

/** analyzeFile 返回：逐秒记录（供落盘/图表）+ 汇总指标（供入库/详情页） */
export interface AnalyzeResult {
  records: SecRecord[];
  summary: Summary;
}

// ---------------- 工具函数 ----------------

export function zoneOf(value: number, zones: Zone[], base: number): string | null {
  const r = value / base;
  for (const z of zones) if (r >= z.min && r < z.max) return z.name;
  return null;
}

export function zoneDistribution(
  values: (number | null)[],
  zones: Zone[],
  base: number,
): Record<string, number> | null {
  const counts = Object.fromEntries(zones.map((z) => [z.name, 0]));
  let total = 0;
  for (const v of values) {
    if (v == null) continue;
    const z = zoneOf(v, zones, base);
    if (z) {
      counts[z]++;
      total++;
    }
  }
  if (!total) return null;
  const pct: Record<string, number> = {};
  for (const k of Object.keys(counts))
    pct[k] = Math.round((counts[k] / total) * 1000) / 10;
  return pct;
}

/** 30s 滚动平均的四次方均根（Normalized Power），要求窗口内数据连续 */
export function normalizedPower(powers: (number | null)[]): number | null {
  const W = 30;
  if (powers.length < W) return null;
  let sum = 0,
    valid = 0;
  const fourthSum: (number | null)[] = [];
  for (let i = 0; i < powers.length; i++) {
    const v = powers[i];
    sum += v == null ? 0 : v;
    valid += v == null ? 0 : 1;
    if (i >= W) {
      const old = powers[i - W];
      sum -= old == null ? 0 : old;
      valid -= old == null ? 0 : 1;
    }
    if (i >= W - 1) fourthSum.push(valid === W ? Math.pow(sum / W, 4) : null);
  }
  const ok = fourthSum.filter((x): x is number => x != null);
  if (!ok.length) return null;
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  return Math.round(Math.pow(mean, 0.25));
}

/** 指定时长（秒）的最大平均功率，要求窗口内数据连续 */
export function peakAvg(powers: (number | null)[], windowSec: number): number | null {
  if (powers.length < windowSec) return null;
  let sum = 0,
    valid = 0,
    best: number | null = null;
  for (let i = 0; i < powers.length; i++) {
    const v = powers[i];
    sum += v == null ? 0 : v;
    valid += v == null ? 0 : 1;
    if (i >= windowSec) {
      const old = powers[i - windowSec];
      sum -= old == null ? 0 : old;
      valid -= old == null ? 0 : 1;
    }
    if (i >= windowSec - 1 && valid === windowSec) {
      const avg = sum / windowSec;
      if (best == null || avg > best) best = avg;
    }
  }
  return best == null ? null : Math.round(best);
}

/**
 * 短缺口线性插值：长度 ≤ maxGapSec 的连续 null 段按左右邻居线性补齐；
 * 更长缺口、以及序列两端无邻居的 null 保持原样（仍视为不连续）。
 * 用于峰功率曲线/FTP 估算前预处理，容忍功率计偶发掉秒；返回新数组，不改原数组。
 */
export function fillShortGaps(values: (number | null)[], maxGapSec: number): (number | null)[] {
  const out = values.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i] != null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] == null) j++;
    const left = i > 0 ? out[i - 1] : null;
    const right = j < out.length ? out[j] : null;
    const len = j - i;
    if (left != null && right != null && len <= maxGapSec) {
      for (let k = i; k < j; k++)
        out[k] = left! + ((right - left!) * (k - i + 1)) / (len + 1);
    }
    i = j;
  }
  return out;
}

/** 心率漂移（有氧解耦）：前后半程 效率因子(功率或速度/心率) 的相对变化，%。
 *  骑行用功率；跑步无功率计时传 field="speed" 用速度代替。 */
export function hrDriftPct(records: SecRecord[], field: 'power' | 'speed' = 'power'): number | null {
  const half = Math.floor(records.length / 2);
  const ef = (recs: SecRecord[]): number | null => {
    const ps = recs.map((r) => r[field]).filter((v): v is number => v != null);
    const hs = recs.map((r) => r.heart_rate).filter((v): v is number => v != null);
    if (ps.length < 60 || hs.length < 60) return null;
    const avgP = ps.reduce((a, b) => a + b, 0) / ps.length;
    const avgH = hs.reduce((a, b) => a + b, 0) / hs.length;
    return avgP / avgH;
  };
  const e1 = ef(records.slice(0, half));
  const e2 = ef(records.slice(half));
  if (e1 == null || e2 == null || e1 === 0) return null;
  return Math.round(((e1 - e2) / e1) * 1000) / 10;
}

/** 检测整条记录（所有字段均为 null，即该秒没有任何数据）连续缺失 ≥ minSec 的片段 */
export function findMissingSpans(records: SecRecord[], minSec: number): { start: string; duration_sec: number }[] {
  const spans: { start: string; duration_sec: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const empty =
      r.power == null &&
      r.heart_rate == null &&
      r.cadence == null &&
      r.altitude == null &&
      r.speed == null &&
      r.distance == null;
    if (empty) {
      if (start == null) start = i;
    } else if (start != null) {
      if (i - start >= minSec)
        spans.push({ start: records[start].timestamp, duration_sec: i - start });
      start = null;
    }
  }
  return spans;
}

/**
 * 暂停识别：从逐秒网格中找出"计时暂停"片段。码表暂停计时（手动或自动暂停）期间
 * 不写记录，网格上表现为整段空缺，不应被标为数据缺失。判定优先级：
 * 1. 事件法：FIT event 消息 timer 的 stop_all→start 时间对（规范设备会写暂停事件），
 *    与空缺段相交即判为暂停；
 * 2. 距离冻结：设备累计距离在空缺两侧几乎不前进（暂停时设备不累计距离；骑行中
 *    掉数据则距离会按速度继续跳变）——设备自身口径的"未计时"证据；
 * 3. 静止恢复：恢复记录后 resumeWindowSec 秒内最大速度仍低于 resumeSpeedKmh
 *    （无距离数据的文件用此兜底；骑行中掉数据恢复时人已在移动）。
 * records 为重采样后的逐秒网格（timestamp 为 ISO 字符串），events 为解析出的
 * FIT event 消息数组；opts 可注入阈值与已算好的空缺段（gaps）。返回空缺段子集：
 * [{ start, duration_sec }]。
 */
export function detectPauseSpans(
  records: SecRecord[],
  events: FitEvent[] = [],
  opts: {
    minSec?: number;
    distJumpM?: number;
    resumeSpeedKmh?: number;
    resumeWindowSec?: number;
    gaps?: { start: string; duration_sec: number }[];
  } = {},
): { start: string; duration_sec: number }[] {
  if (!records.length) return [];
  const minSec = opts.minSec ?? DATA_QUALITY.record_gap_sec;
  const distJumpM = opts.distJumpM ?? DATA_QUALITY.pause_dist_jump_m;
  const resumeSpeedKmh =
    opts.resumeSpeedKmh ?? DATA_QUALITY.pause_resume_speed_kmh;
  const resumeWindowSec =
    opts.resumeWindowSec ?? DATA_QUALITY.pause_resume_window_sec;
  const gaps = opts.gaps ?? findMissingSpans(records, minSec);
  if (!gaps.length) return [];

  const t0Ms = new Date(records[0].timestamp).getTime();

  // 事件法：收集 timer stop_all→start 的绝对时间对
  const eventSpans: [number, number][] = [];
  let stopMs: number | null = null;
  for (const e of events || []) {
    if (e?.event !== 'timer' || e.timestamp == null) continue;
    const ts = new Date(e.timestamp).getTime();
    if (e.event_type === 'stop_all') {
      if (stopMs == null) stopMs = ts;
    } else if (e.event_type === 'start' && stopMs != null) {
      eventSpans.push([stopMs, ts]);
      stopMs = null;
    }
  }

  const pauses: { start: string; duration_sec: number }[] = [];
  for (const g of gaps) {
    const startIdx = Math.round((new Date(g.start).getTime() - t0Ms) / 1000);
    const endIdx = startIdx + g.duration_sec; // 恢复记录所在下标
    const gStartMs = startIdx * 1000 + t0Ms;
    const gEndMs = endIdx * 1000 + t0Ms;
    // 事件区间与该空缺相交 → 暂停
    if (eventSpans.some(([a, b]) => b > gStartMs && a < gEndMs)) {
      pauses.push(g);
      continue;
    }
    // 距离冻结：设备累计距离在空缺两侧几乎不前进 → 设备未计时 → 暂停
    const distBefore = startIdx > 0 ? records[startIdx - 1].distance : null;
    const distAfter = records[endIdx]?.distance ?? null;
    if (distBefore != null && distAfter != null) {
      if (distAfter - distBefore <= distJumpM) {
        pauses.push(g);
        continue;
      }
    }
    // 静止恢复：恢复后窗口内最大速度低于阈值 → 暂停
    let maxSpeed: number | null = null;
    for (
      let i = endIdx;
      i < Math.min(endIdx + resumeWindowSec, records.length);
      i++
    ) {
      const v = records[i]?.speed;
      if (v != null && (maxSpeed == null || v > maxSpeed)) maxSpeed = v;
    }
    if (maxSpeed != null && maxSpeed < resumeSpeedKmh) pauses.push(g);
  }
  return pauses;
}

/** FIT record 中的标准字段（白名单），之外的数值字段视为开发者字段 */
const STANDARD_RECORD_FIELDS = new Set([
  'timestamp',
  'power',
  'heart_rate',
  'cadence',
  'altitude',
  'speed',
  'distance',
  'position_lat',
  'position_long',
  'elapsed_time',
  'timer_time',
  'enhanced_speed',
  'enhanced_altitude',
  'fractional_cadence',
  'temperature',
  'gps_accuracy',
  'vertical_speed',
  'calories',
  'grade',
  'resistance',
  'cycles',
  'accumulated_power',
  'left_right_balance',
  'left_torque_effectiveness',
  'right_torque_effectiveness',
  'left_pedal_smoothness',
  'right_pedal_smoothness',
  'combined_pedal_smoothness',
]);

/** 收集 record 里的开发者字段（第三方码表自定义数据），输出数值统计供 AI 参考 */
export function collectDeveloperFields(rawRecords: any[]): Record<string, { samples: number; avg: number; min: number; max: number }> | null {
  const stats = new Map<string, { count: number; sum: number; min: number; max: number }>();
  for (const r of rawRecords) {
    for (const [k, v] of Object.entries(r)) {
      if (STANDARD_RECORD_FIELDS.has(k)) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      let s = stats.get(k);
      if (!s) stats.set(k, (s = { count: 0, sum: 0, min: v, max: v }));
      s.count++;
      s.sum += v;
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
    }
  }
  if (!stats.size) return null;
  const out: Record<string, { samples: number; avg: number; min: number; max: number }> = {};
  for (const [k, s] of stats) {
    out[k] = {
      samples: s.count,
      avg: Math.round((s.sum / s.count) * 100) / 100,
      min: Math.round(s.min * 100) / 100,
      max: Math.round(s.max * 100) / 100,
    };
  }
  return out;
}

/** 检测功率连续缺失 > gapSec 的片段 */
export function findPowerGaps(records: SecRecord[], gapSec = 60): { start: string; duration_sec: number }[] {
  const gaps: { start: string; duration_sec: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < records.length; i++) {
    if (records[i].power == null) {
      if (start == null) start = i;
    } else if (start != null) {
      if (i - start >= gapSec) {
        gaps.push({ start: records[start].timestamp, duration_sec: i - start });
      }
      start = null;
    }
  }
  return gaps;
}

/**
 * 累计爬升（滞回去抖）：以最近一次"确认点"为基线，逐样本累计相邻上升量，
 * 累计上升达到 thresholdM 才计入爬升并把基线抬到当前高点；期间海拔跌破基线
 * 则基线下跟新低——只有真正超出噪声门限的抬升才被累计，亚米级气压抖动不计数。
 * null 缺口跳过，基线保持不变。
 */
export function elevationGain(alts: (number | null)[], thresholdM = ELEVATION.noise_threshold_m): number {
  let gain = 0,
    base: number | null = null,
    peak: number | null = null;
  for (const a of alts) {
    if (a == null) continue;
    if (base == null) {
      base = a;
      peak = a;
      continue;
    }
    if (a > peak!) peak = a;
    if (peak! - base >= thresholdM) {
      gain += peak! - base;
      base = peak;
    } else if (a < base) {
      base = a;
      peak = a;
    }
  }
  return Math.round(gain);
}

/** 记录片段某字段的平均值（跳过 null），不足 1 个有效值返回 null */
export function avgField(slice: SecRecord[], field: keyof SecRecord, digits = 1): number | null {
  const v = slice.map((r) => r[field]).filter((x): x is number => x != null);
  if (!v.length) return null;
  const f = Math.pow(10, digits);
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * f) / f;
}

/** 记录片段某字段的最大值（跳过 null） */
export function maxField(slice: SecRecord[], field: keyof SecRecord): number | null {
  const v = slice.map((r) => r[field]).filter((x): x is number => x != null);
  return v.length ? Math.round(Math.max(...v)) : null;
}

// ---------------- P0 分析函数（骑手参数经可选末参注入，缺省用出厂默认值） ----------------

/** FTP 自动估算：20 分钟峰功率 × 0.95，并与当前配置对比给出建议 */
export function estimateFtp(powers: (number | null)[], athlete: AthleteParams = ATHLETE): FtpEstimate | null {
  const peak20 = peakAvg(powers, 1200);
  if (peak20 == null) return null; // 时长不足 20 分钟
  const estimated = Math.round(peak20 * 0.95);
  const current = athlete.ftp_watts;
  const diff = estimated - current;
  let suggestion: FtpEstimate['suggestion'] = 'keep';
  if (diff > 3) suggestion = 'consider_update'; // 估算明显高于当前，建议更新 FTP
  else if (diff < -5) suggestion = 'consider_recheck'; // 明显偏低：状态差或本次非全力，不宜直接下调
  return {
    peak_20min_w: peak20,
    estimated_ftp_w: estimated,
    current_ftp_w: current,
    diff_w: diff,
    suggestion,
  };
}

/** 间歇识别结果：过阈段列表 + ≥2 段时的组统计 */
export interface IntervalResult {
  intervals: IntervalItem[];
  interval_set?: IntervalSet;
}

/**
 * 间歇识别：找出功率 ≥ threshold_pct × FTP 的重复工作段。
 * 低于阈值不超过 merge_gap_sec 视为瞬时掉功率（段内合并）；
 * 时长不足 min_duration_sec 的段丢弃。
 */
export function detectIntervals(records: SecRecord[], athlete: AthleteParams = ATHLETE): IntervalResult | null {
  const thr = INTERVAL_DETECTION.threshold_pct * athlete.ftp_watts;
  // 1. 原始过阈段 [startIdx, endIdx]
  const rawSegs: [number, number][] = [];
  let s: number | null = null;
  for (let i = 0; i < records.length; i++) {
    const p = records[i].power;
    if (p != null && p >= thr) {
      if (s == null) s = i;
    } else if (s != null) {
      rawSegs.push([s, i - 1]);
      s = null;
    }
  }
  if (s != null) rawSegs.push([s, records.length - 1]);

  // 2. 合并间隔过短的相邻段
  const merged: [number, number][] = [];
  for (const seg of rawSegs) {
    const last = merged[merged.length - 1];
    if (last && seg[0] - last[1] - 1 <= INTERVAL_DETECTION.merge_gap_sec) {
      last[1] = seg[1];
    } else {
      merged.push([...seg] as [number, number]);
    }
  }

  // 3. 过滤短段并统计
  const intervals: IntervalItem[] = [];
  for (const [a, b] of merged) {
    const dur = b - a + 1;
    if (dur < INTERVAL_DETECTION.min_duration_sec) continue;
    const slice = records.slice(a, b + 1);
    const avgP = avgField(slice, 'power', 0);
    intervals.push({
      name: `interval_${intervals.length + 1}`,
      start: records[a].timestamp,
      duration_sec: dur,
      avg_power: avgP,
      max_power: maxField(slice, 'power'),
      pct_ftp:
        avgP != null ? Math.round((avgP / athlete.ftp_watts) * 100) : null,
      avg_hr: avgField(slice, 'heart_rate', 0),
      avg_cadence: avgField(slice, 'cadence', 0),
    });
  }
  if (!intervals.length) return null;

  const result: IntervalResult = { intervals };
  if (intervals.length >= 2) {
    // 组统计：判断是否为重复组（如 5×5min @ 110% FTP）
    result.interval_set = {
      count: intervals.length,
      avg_duration_sec: Math.round(
        intervals.reduce((a, x) => a + x.duration_sec, 0) / intervals.length,
      ),
      avg_power: Math.round(
        intervals.reduce((a, x) => a + (x.avg_power ?? 0), 0) /
          intervals.length,
      ),
      avg_pct_ftp: Math.round(
        intervals.reduce((a, x) => a + (x.pct_ftp ?? 0), 0) /
          intervals.length,
      ),
    };
  }
  return result;
}

/**
 * 爬坡段提取：用 smooth_sec 窗口计算局部坡度 (Δ海拔/Δ距离)，
 * 连续坡度 ≥ min_grade_pct 的路段为候选段；
 * 段需同时满足累计爬升 ≥ min_gain_m 且长度 ≥ min_distance_m。
 * distance/altitude 数据缺口处自然断段。
 */
export function detectClimbs(records: SecRecord[]): Climb[] | null {
  const S = CLIMB_DETECTION.smooth_sec;
  const n = records.length;
  // 1. 逐秒前向窗口坡度（%），数据无效或距离不增则为 null
  const grades: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const j = Math.min(i + S, n - 1);
    const a0 = records[i].altitude,
      a1 = records[j].altitude;
    const d0 = records[i].distance,
      d1 = records[j].distance;
    if (a0 == null || a1 == null || d0 == null || d1 == null) continue;
    const dd = d1 - d0;
    if (dd <= 0) continue;
    grades[i] = ((a1 - a0) / dd) * 100;
  }

  // 2. 连续过阈路段为候选段
  const climbs: Climb[] = [];
  let s: number | null = null;
  const flush = (end: number) => {
    if (s == null) return;
    const slice = records.slice(s, end + 1);
    const d0 = records[s].distance,
      d1 = records[end].distance;
    const distM = d0 != null && d1 != null ? d1 - d0 : 0;
    const gainM = elevationGain(slice.map((r) => r.altitude));
    if (
      distM >= CLIMB_DETECTION.min_distance_m &&
      gainM >= CLIMB_DETECTION.min_gain_m
    ) {
      climbs.push({
        name: `climb_${climbs.length + 1}`,
        start: records[s].timestamp,
        duration_sec: end - s + 1,
        distance_m: Math.round(distM),
        elevation_gain_m: gainM,
        avg_grade_pct: Math.round((gainM / distM) * 1000) / 10,
        avg_power: avgField(slice, 'power', 0),
        avg_hr: avgField(slice, 'heart_rate', 0),
      });
    }
    s = null;
  };
  for (let i = 0; i < n; i++) {
    if (grades[i] != null && grades[i]! >= CLIMB_DETECTION.min_grade_pct) {
      if (s == null) s = i;
    } else {
      flush(i - 1);
    }
  }
  flush(n - 1);

  return climbs.length ? climbs : null;
}

/**
 * 踏频-功率联合分析：只统计功率 ≥ power_floor_pct × FTP 的"发力时段"，
 * 判断低踏频高扭矩 vs 高踏频的发力习惯，并给出踏频与功率的相关系数。
 */
export function cadencePowerAnalysis(records: SecRecord[], athlete: AthleteParams = ATHLETE): CadencePower | null {
  const floor = CADENCE_ANALYSIS.power_floor_pct * athlete.ftp_watts;
  const pts = records.filter(
    (r) => r.power != null && r.power >= floor && r.cadence != null,
  );
  if (pts.length < 60) return null; // 有效样本不足 60 秒不判读

  const cads = pts.map((r) => r.cadence!);
  const pwrs = pts.map((r) => r.power!);
  const avgCad = cads.reduce((a, b) => a + b, 0) / cads.length;
  const pctLow =
    Math.round(
      (cads.filter((c) => c < CADENCE_ANALYSIS.low_cadence_rpm).length /
        cads.length) *
        1000,
    ) / 10;
  const pctHigh =
    Math.round(
      (cads.filter((c) => c > CADENCE_ANALYSIS.high_cadence_rpm).length /
        cads.length) *
        1000,
    ) / 10;

  // 皮尔逊相关系数
  const avgP = pwrs.reduce((a, b) => a + b, 0) / pwrs.length;
  let num = 0,
    denC = 0,
    denP = 0;
  for (let i = 0; i < pts.length; i++) {
    const dc = cads[i] - avgCad,
      dp = pwrs[i] - avgP;
    num += dc * dp;
    denC += dc * dc;
    denP += dp * dp;
  }
  const corr =
    denC > 0 && denP > 0
      ? Math.round((num / Math.sqrt(denC * denP)) * 100) / 100
      : null;

  // 发力习惯判读（结构化枚举，界面/AI 按语言渲染；thresholds 见 CADENCE_ANALYSIS）
  let style: CadencePower['style'] = 'normal';
  if (pctLow >= 30) style = 'low_cadence';
  else if (pctHigh >= 50) style = 'high_cadence';

  return {
    sample_sec: pts.length,
    avg_cadence: Math.round(avgCad * 10) / 10,
    pct_low_cadence: pctLow,
    pct_high_cadence: pctHigh,
    cadence_power_corr: corr,
    style,
  };
}

// ---------------- 单文件分析流程（依赖注入版） ----------------

/**
 * 解析 FIT 字节并产出逐秒记录 + 汇总指标。
 * 与旧版（fit-reader Web 版 index.js analyzeFile）的差异：不落盘 CSV/JSON、不直接写训练库、
 * 不读全局骑手参数——三者全部由调用方处理，入库注入的 athlete_context form 字段
 * （ctl/atl/tsb/form_state/form_note）同样由调用方后续补写。
 */
export async function analyzeFile(input: AnalyzeInput): Promise<AnalyzeResult> {
  // 骑手参数以训练库为准（App 层传入）；未传字段用出厂默认值
  const athlete: AthleteParams = { ...ATHLETE, ...input.athlete };
  const parser = new FitParser({
    force: true,
    speedUnit: 'km/h',
    lengthUnit: 'km',
    mode: 'list',
  });

  const data: FitParsed = await new Promise((resolve, reject) =>
    parser.parse(input.bytes, (err: unknown, d: FitParsed) =>
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(d),
    ),
  );

  const sport = data.sport?.sport || data.sessions?.[0]?.sport || 'unknown';

  // ---- 1. 整理逐秒记录（重采样到 1s 网格，缺口置 null） ----
  const allRecords: any[] = data.records || [];
  const raw = allRecords.filter((r) => r.timestamp);
  if (!raw.length) throw new Error('FIT 中没有 record 数据');
  const droppedNoTs = allRecords.length - raw.length; // 无时间戳被丢弃的记录数
  raw.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const t0 = Math.floor(raw[0].timestamp.getTime() / 1000);
  const t1 = Math.floor(raw[raw.length - 1].timestamp.getTime() / 1000);
  const bySec = new Map<number, any>();
  for (const r of raw) bySec.set(Math.floor(r.timestamp.getTime() / 1000), r);

  const records: SecRecord[] = [];
  for (let t = t0; t <= t1; t++) {
    const r = bySec.get(t);
    // 解析器按 lengthUnit 把海拔缩放成了 km，这里换回米（保留 1 位小数）；
    // 部分设备只写 enhanced_altitude（32 位增强海拔），缺失时回退
    const altKm = r?.altitude ?? r?.enhanced_altitude;
    records.push({
      timestamp: new Date(t * 1000).toISOString(),
      power: r?.power ?? null,
      heart_rate: r?.heart_rate ?? null,
      cadence: r?.cadence ?? null,
      altitude: altKm != null ? Math.round(altKm * 10000) / 10 : null,
      speed: r?.speed != null ? Math.round(r.speed * 100) / 100 : null,
      distance: r?.distance != null ? Math.round(r.distance * 1000) : null, // 米
      temperature: r?.temperature ?? null, // ℃
    });
  }

  // ---- 2.5 暂停识别与缺失统计 ----
  // 码表暂停计时期间不写记录，网格上表现为整段空缺；重新开始计时时骑手通常
  // 已静止，据此把这类空缺判为"计时暂停"而非"数据缺失"，阈值见 DATA_QUALITY
  const missingSpans = findMissingSpans(records, DATA_QUALITY.record_gap_sec);
  const pauseSpans = detectPauseSpans(records, (data.events as FitEvent[]) || [], {
    gaps: missingSpans,
  });
  const pauseStarts = new Set(pauseSpans.map((s) => s.start));
  const pauseSeconds = pauseSpans.reduce((a, s) => a + s.duration_sec, 0);
  // 时间跨度内没有任何数据的秒数（扣除暂停；损坏文件被 force 模式跳过的记录同样表现为缺口）
  const expectedSec = t1 - t0 + 1;
  const missingSec = expectedSec - bySec.size - pauseSeconds;

  // ---- 3. 计算指标 ----
  const powers = records.map((r) => r.power);
  const hrs = records.map((r) => r.heart_rate);
  const cads = records.map((r) => r.cadence);
  const alts = records.map((r) => r.altitude);

  const avg = (arr: (number | null)[]): number | null => {
    const v = arr.filter((x): x is number => x != null);
    return v.length
      ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10
      : null;
  };
  const max = (arr: (number | null)[]): number | null => {
    const v = arr.filter((x): x is number => x != null);
    return v.length ? Math.round(Math.max(...v)) : null;
  };

  const avgPower = avg(powers);
  const np = normalizedPower(powers);
  // 骑行时长 = 网格秒数 − 暂停秒数（暂停期间码表未计时，不计入时长/TSS/平均速度）
  const durationSec = records.length - pauseSeconds;
  const ifactor =
    np && athlete.ftp_watts
      ? Math.round((np / athlete.ftp_watts) * 100) / 100
      : null;
  const tss =
    np && ifactor
      ? Math.round(
          ((durationSec * np * ifactor) / (athlete.ftp_watts * 3600)) * 100,
        )
      : null;

  const distances = records.map((r) => r.distance).filter((v): v is number => v != null);
  let distanceKm: number | null = distances.length
    ? Math.round(
        ((Math.max(...distances) - Math.min(...distances)) / 1000) * 100,
      ) / 100
    : null;
  if (distanceKm == null) {
    // record 里缺距离时的兜底：用 session 汇总距离（泳池游泳常见）
    const sd = data.sessions?.[0]?.total_distance;
    if (sd != null)
      distanceKm = Math.round((sd > 1000 ? sd / 1000 : sd) * 100) / 100;
  }

  // 平均速度与卡路里：优先取 session 汇总（设备口径），缺失时用记录数据兜底
  const sess = data.sessions?.[0] || {};
  let avgSpeedKmh: number | null =
    sess.avg_speed != null ? Math.round(sess.avg_speed * 100) / 100 : null;
  if (avgSpeedKmh == null && distanceKm != null && durationSec > 0) {
    avgSpeedKmh = Math.round((distanceKm / (durationSec / 3600)) * 100) / 100;
  }
  let totalCalories: number | null = sess.total_calories ?? null;
  if (totalCalories == null) {
    // record 里的 calories 是累计值，取最大（末值）兜底
    const recCals = raw.map((r) => r.calories).filter((v: unknown): v is number => v != null);
    if (recCals.length) totalCalories = Math.max(...recCals);
  }

  // 温度统计（部分码表 record 带温度，无则整段省略）
  const temps = records.map((r) => r.temperature).filter((v): v is number => v != null);
  const temperatureSection =
    temps.length
      ? {
          avg:
            Math.round(
              (temps.reduce((a, b) => a + b, 0) / temps.length) * 10,
            ) / 10,
          min: Math.min(...temps),
          max: Math.max(...temps),
        }
      : undefined;

  // 功率峰曲线：短缺口先线性插值补齐再取峰（容忍功率计偶发掉秒，长缺口仍要求连续）
  const powersFilled = fillShortGaps(powers, PEAK_CURVE.max_interp_gap_sec);
  const peakCurve: PeakCurve = {};
  for (const [label, sec] of [
    ['5s', 5],
    ['1min', 60],
    ['5min', 300],
    ['20min', 1200],
  ] as const) {
    const p = peakAvg(powersFilled, sec);
    if (p != null) peakCurve[label] = p;
  }

  // 功率缺失片段 → 异常标注（结构化：type 语言中立，展示时按语言格式化）；
  // 与暂停区间重叠的功率缺失是停表所致，不算异常
  const anomalies: Anomaly[] = [];
  const overlapsPause = (startIso: string, durSec: number) => {
    const s = new Date(startIso).getTime();
    const e = s + durSec * 1000;
    return pauseSpans.some((p) => {
      const ps = new Date(p.start).getTime();
      return e > ps && s < ps + p.duration_sec * 1000;
    });
  };
  for (const g of findPowerGaps(records)) {
    if (overlapsPause(g.start, g.duration_sec)) continue;
    anomalies.push({ type: 'power_gap', duration_sec: g.duration_sec, at: g.start });
  }
  // 整段记录缺失检测：静止恢复的空缺是计时暂停，其余为数据缺失（损坏文件兜底标注）
  for (const g of missingSpans) {
    if (pauseStarts.has(g.start))
      anomalies.push({ type: 'timer_pause', duration_sec: g.duration_sec, at: g.start });
    else
      anomalies.push({ type: 'record_gap', duration_sec: g.duration_sec, at: g.start });
  }
  // 心率跳变检测（相邻秒差 > 25）
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1].heart_rate,
      b = records[i].heart_rate;
    if (a != null && b != null && Math.abs(b - a) > 25) {
      anomalies.push({ type: 'hr_jump', from: a, to: b, at: records[i].timestamp });
      if (anomalies.length > 20) break;
    }
  }

  // 圈/赛段（lap）+ 自动识别的间歇段
  const segments: (Record<string, unknown> | IntervalItem)[] = (data.laps || [])
    .map((lap: any, i: number) => {
      const s: Record<string, unknown> = {
        name: lap.name || `lap_${i + 1}`,
        duration_sec:
          lap.total_elapsed_time != null
            ? Math.round(lap.total_elapsed_time)
            : undefined,
        avg_power: lap.avg_power,
        max_power: lap.max_power,
        avg_hr: lap.avg_heart_rate,
        avg_cadence: lap.avg_cadence,
        // 跑步的 lap 附平均配速（min/km），速度为 km/h
        ...(sport === 'running' && lap.avg_speed
          ? {
              avg_pace_min_per_km:
                Math.round((60 / lap.avg_speed) * 100) / 100,
            }
          : {}),
        distance_km:
          lap.total_distance != null
            ? Math.round(lap.total_distance * 100) / 100
            : undefined,
        // total_ascent 同样被解析器缩放成 km，换回米
        elevation_gain_m:
          lap.total_ascent != null
            ? Math.round(lap.total_ascent * 1000)
            : undefined,
      };
      Object.keys(s).forEach((k) => s[k] === undefined && delete s[k]);
      return s;
    })
    .filter((s) => Object.keys(s).length > 1);
  const intervalResult = detectIntervals(records, athlete);
  if (intervalResult) segments.push(...intervalResult.intervals);

  // 跑步：配速指标（无功率计时的核心强度指标），单位 min/km
  const speeds = records.map((r) => r.speed); // km/h
  let paceSection: Summary['pace'] | undefined;
  if (sport === 'running' && distanceKm) {
    const bestSpeed1min = peakAvg(speeds, 60);
    paceSection = {
      avg_pace_min_per_km:
        Math.round((durationSec / 60 / distanceKm) * 100) / 100,
      best_1min_pace_min_per_km:
        bestSpeed1min != null
          ? Math.round((60 / bestSpeed1min) * 100) / 100
          : null,
    };
  }

  // 游泳：处理 length 消息（泳池游泳的逐趟数据）
  let swimSection: Summary['swim'] | undefined;
  const lengths: any[] = data.lengths || [];
  if (sport === 'swimming' && lengths.length) {
    const times = lengths
      .map((l) => l.total_elapsed_time)
      .filter((v: unknown): v is number => v != null);
    const strokes = lengths.map((l) => l.total_strokes).filter((v: unknown): v is number => v != null);
    const poolLen = data.sessions?.[0]?.pool_length;
    const swolfs = lengths
      .filter((l) => l.total_elapsed_time != null && l.total_strokes != null)
      .map((l) => l.total_elapsed_time + l.total_strokes);
    swimSection = {
      lengths_count: lengths.length,
      pool_length_m:
        poolLen != null ? Math.round(poolLen < 1 ? poolLen * 1000 : poolLen) : null,
      avg_length_time_sec: times.length
        ? Math.round((times.reduce((a: number, b: number) => a + b, 0) / times.length) * 10) / 10
        : null,
      total_strokes: strokes.length
        ? strokes.reduce((a: number, b: number) => a + b, 0)
        : null,
      avg_swolf: swolfs.length
        ? Math.round((swolfs.reduce((a: number, b: number) => a + b, 0) / swolfs.length) * 10) / 10
        : null,
    };
  }

  // 心率漂移用的效率因子字段：有功率用功率（骑行），否则用速度（跑步）
  const hasPower = powers.some((v) => v != null);
  const driftField: 'power' | 'speed' = hasPower ? 'power' : 'speed';

  // 主爬升指标：优先用码表自报累计爬升（session.total_ascent，与码表屏幕同口径，
  // 设备气压计自带滤波校准）；缺失时回退自算值（elevationGain 滞回去抖）
  const deviceAscentM =
    sess.total_ascent != null ? Math.round(sess.total_ascent * 1000) : null;
  const useDeviceAscent = deviceAscentM != null && deviceAscentM > 0;
  const elevationM = useDeviceAscent ? deviceAscentM : elevationGain(alts);

  // ---- 4. 汇总对象 ----
  const summary: Summary = {
    activity: {
      date: records[0].timestamp.slice(0, 10),
      sport,
      duration_sec: durationSec,
      distance_km: distanceKm,
      elevation_gain_m: elevationM,
      elevation_gain_source: useDeviceAscent ? 'device' : 'computed',
      ...(avgSpeedKmh != null ? { avg_speed_kmh: avgSpeedKmh } : {}),
      ...(totalCalories != null ? { total_calories: totalCalories } : {}),
    },
    athlete_context: { ...athlete },
    power: {
      avg: avgPower,
      normalized_power: np,
      max: max(powers),
      variability_index:
        np && avgPower ? Math.round((np / avgPower) * 100) / 100 : null,
      intensity_factor: ifactor,
      tss,
      w_per_kg_avg: avgPower
        ? Math.round((avgPower / athlete.weight_kg) * 100) / 100
        : null,
      peak_curve: peakCurve,
      ftp_estimate: estimateFtp(powersFilled, athlete) ?? undefined,
      zone_distribution_pct: zoneDistribution(
        powers,
        POWER_ZONES,
        athlete.ftp_watts,
      ),
    },
    heart_rate: {
      avg: avg(hrs),
      max: max(hrs),
      zone_distribution_pct: zoneDistribution(hrs, HR_ZONES, athlete.max_hr),
      hr_drift_pct: hrDriftPct(records, driftField),
    },
    // 踏频均值剔除 0 rpm（滑行）秒，只统计踩踏时段，与码表 session / Strava 口径一致
    cadence: { avg: avg(cads.map((c) => (c != null && c > 0 ? c : null))) },
    temperature: temperatureSection,
    pace: paceSection,
    swim: swimSection,
    developer_fields: collectDeveloperFields(raw) ?? undefined,
    // 踏频-功率联合分析是骑行专属口径（阈值按 FTP 设定）
    cadence_power: sport === 'cycling' ? cadencePowerAnalysis(records, athlete) ?? undefined : undefined,
    climbs: detectClimbs(records) ?? undefined,
    interval_set: intervalResult?.interval_set,
    segments: segments.length ? segments : undefined,
    anomalies: anomalies.length ? anomalies : undefined,
    data_quality: {
      record_count: raw.length,
      ...(droppedNoTs > 0
        ? { dropped_records_no_timestamp: droppedNoTs }
        : {}),
      ...(missingSec > 0 ? { missing_seconds: missingSec } : {}),
      ...(pauseSeconds > 0 ? { pause_seconds: pauseSeconds } : {}),
      power_coverage_pct: Math.round(
        (powers.filter((v): v is number => v != null).length / durationSec) * 100,
      ),
      hr_coverage_pct: Math.round(
        (hrs.filter((v): v is number => v != null).length / durationSec) * 100,
      ),
    },
  };
  // 清理 undefined / null 的空壳字段（口径与旧版一致）
  for (const k of Object.keys(summary) as (keyof Summary)[]) {
    // biome-ignore lint: 与旧版一致的动态删除
    if ((summary as any)[k] === undefined || (summary as any)[k] === null) delete (summary as any)[k];
  }
  if (summary.power?.ftp_estimate == null && summary.power) delete summary.power.ftp_estimate;
  if (summary.cadence_power == null) delete summary.cadence_power;
  // 全程无功率数据（跑步/游泳常见）：整个 power 段无意义，省略
  if (!hasPower && summary.power) delete summary.power;

  return { records, summary };
}

// ---------------- records 序列化（CSV，与旧版列序逐字一致） ----------------

/** 逐秒记录 → CSV 文本（列：timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature；缺数据留空） */
export function recordsToCsv(records: SecRecord[]): string {
  const header =
    'timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature\n';
  const lines = records.map((r) =>
    [
      r.timestamp,
      r.power,
      r.heart_rate,
      r.cadence,
      r.altitude,
      r.speed,
      r.distance,
      r.temperature,
    ]
      .map((v) => (v == null ? '' : v))
      .join(','),
  );
  return header + lines.join('\n');
}

/**
 * reanalyze.ts — 从已存逐秒记录按当前骑手参数重建训练 summary（纯函数、无 IO）。
 *
 * 背景：FIT 原始字节不落盘（只有 records gzip），FTP/最大心率/体重变更后无法对
 * 历史训练直接重跑 analyzeFile。本模块以「overlay 口径」重建：records 无损往返
 * （CSV 列里的功率/心率/踏频均为整数通道，往返零漂移），因此凡 f(records) 或
 * f(records, athlete) 的字段重算后与原管线同源同值、参数不变时幂等；FIT 消息层
 * 才有的信息（lap 段、swim、开发者字段、设备爬升、暂停事件判据）与参数无关字段
 * 从旧 summary 继承。
 *
 * 入库（upsertActivity）与当日 CTL/ATL/TSB 两段式注入由服务层负责（口径同
 * importFit），本模块只做纯计算。
 */

import type { IntervalItem, PeakCurve, SecRecord, Summary } from './analyze.ts';
import {
  avgField,
  cadencePowerAnalysis,
  detectIntervals,
  estimateFtp,
  fillShortGaps,
  maxField,
  normalizedPower,
  peakAvg,
  zoneDistribution,
} from './analyze.ts';
import { detectStationarySpans, pedalTimeBreakdown } from './pedalTime.ts';
import { PEAK_CURVE, HR_ZONES, POWER_ZONES, type AthleteParams } from './settings.ts';

/** segments 里自动识别的间歇段特征（IntervalItem 必有 start/pct_ftp 键；lap 段两者皆无） */
const isIntervalItem = (s: Record<string, unknown> | IntervalItem): boolean =>
  'start' in s || 'pct_ftp' in s;

/**
 * 从已存 records 按当前骑手参数重建 summary。
 *
 * 重算（f(records, athlete)）：功率 IF/TSS/区间分布/单次 FTP 估算/w_per_kg、
 * 心率区间分布、间歇识别与组统计（阈值 1.05×FTP）、踏频-功率分析（门槛
 * 0.75×FTP，骑行专属）、athlete_context 三参数。
 * 继承（FIT 消息层信息或参数无关）：activity 全部、NP/avg/max/VI/峰曲线、
 * 心率 avg/max/漂移、踏频均值、pace/temperature/swim/developer_fields/climbs、
 * anomalies、data_quality、segments 中的 lap 段。
 * 回填（f(records) 参数无关，但升级前入库的存量 summary 缺失）：pedal_time
 * 三分解与 stationary 异常段——0W 根治披露字段，重建时按当前 records 补算
 * （先滤旧 stationary 条目再并入，重复触发幂等）。
 *
 * 功率缩放（opts.powerScale，校准口径）：给定时把逐秒功率 × scale 后再进全部
 * 功率派生计算，且 NP/avg/max/VI/峰曲线从「继承集」移入「重算集」、爬坡段
 * avg_power 线性换算（段边界由海拔/距离决定，不受影响）——数学上 NP/峰功率
 * 对 scale 线性、TSS ∝ scale²；records 原件不改写（summary 是派生结果，重导
 * 原 FIT 或换系数重跑即可回退/再校准）。scale 非法（≤0/非有限值/恰为 1）按
 * 未缩放处理。
 *
 * @param records 已存逐秒记录（loadStoredRecords 的输出；缺失由调用方拦截）
 * @param prev 库内现有 summary（getActivitySummary 的输出，含 category/note 合并）
 * @param athlete 当前生效骑手参数
 * @param opts.powerScale 功率校准系数（可选；夹逼界限见 settings.POWER_CALIBRATION，由服务层执行）
 */
export function rebuildSummaryFromRecords(
  records: SecRecord[],
  prev: Summary,
  athlete: AthleteParams,
  opts?: { powerScale?: number },
): Summary {
  // 逐秒深拷贝起底：summary 本就是 JSON 可序列化结构，JSON 往返即安全克隆
  const out: Summary = JSON.parse(JSON.stringify(prev)) as Summary;

  // ---- 功率缩放源记录（仅功率通道换算；心率/踏频/海拔等其余通道原样） ----
  const scale = opts?.powerScale;
  const hasScale =
    typeof scale === 'number' && Number.isFinite(scale) && scale > 0 && scale !== 1;
  const src: SecRecord[] = hasScale
    ? records.map((r) =>
        r.power == null ? r : { ...r, power: r.power * (scale as number) },
      )
    : records;

  // ---- 骑手参数三件套覆盖（form 字段随 prev 带入，服务层入库后两段式重注） ----
  out.athlete_context = {
    ...out.athlete_context,
    ftp_watts: athlete.ftp_watts,
    max_hr: athlete.max_hr,
    weight_kg: athlete.weight_kg,
  };

  // ---- 心率区间分布（f(records, max_hr)；avg/max/漂移参数无关，继承） ----
  out.heart_rate = {
    ...out.heart_rate,
    zone_distribution_pct: zoneDistribution(
      src.map((r) => r.heart_rate),
      HR_ZONES,
      athlete.max_hr,
    ),
  };

  // ---- 功率块（全程无功率的运动没有 power 段，跳过） ----
  if (prev.power) {
    const powers = src.map((r) => r.power);
    const powersFilled = fillShortGaps(powers, PEAK_CURVE.max_interp_gap_sec);
    // 默认（未缩放）：NP/avg/max/峰曲线是 f(records) 参数无关 → 继承；
    // 缩放时随记录线性变化 → 重算（与 analyzeFile 直跑同代码路径，结果同源同值）
    const np = hasScale ? normalizedPower(powers) : prev.power.normalized_power;
    const avgPower = hasScale ? avgField(src, 'power', 0) : prev.power.avg;
    const maxPower = hasScale ? maxField(src, 'power') : prev.power.max;
    const peakCurve: PeakCurve | null = hasScale
      ? ((): PeakCurve => {
          const curve: PeakCurve = {};
          for (const [label, sec] of [
            ['5s', 5],
            ['1min', 60],
            ['5min', 300],
            ['20min', 1200],
          ] as const) {
            const p = peakAvg(powersFilled, sec);
            if (p != null) curve[label] = p;
          }
          return curve;
        })()
      : null;
    const durationSec = prev.activity.duration_sec; // 网格秒数−暂停秒数，records 未变 → 继承
    const ifactor =
      np && athlete.ftp_watts
        ? Math.round((np / athlete.ftp_watts) * 100) / 100
        : null;
    const tss =
      np && ifactor
        ? Math.round(((durationSec * np * ifactor) / (athlete.ftp_watts * 3600)) * 100)
        : null;
    out.power = {
      ...prev.power,
      ...(hasScale
        ? {
            avg: avgPower,
            normalized_power: np,
            max: maxPower,
            peak_curve: peakCurve!,
            variability_index:
              np && avgPower ? Math.round((np / avgPower) * 100) / 100 : null,
          }
        : {}),
      intensity_factor: ifactor,
      tss,
      w_per_kg_avg: avgPower
        ? Math.round((avgPower / athlete.weight_kg) * 100) / 100
        : null,
      ftp_estimate: estimateFtp(powersFilled, athlete) ?? undefined,
      zone_distribution_pct: zoneDistribution(powers, POWER_ZONES, athlete.ftp_watts),
    };
    // 时长不足 20 分钟无估算 → 删键（口径同 analyzeFile 收尾）
    if (out.power.ftp_estimate == null) delete out.power.ftp_estimate;
  }

  // ---- 爬坡段（缩放时）：段边界由海拔/距离决定不受影响，段内均值功率线性换算 ----
  if (hasScale && out.climbs?.length) {
    out.climbs = out.climbs.map((c) => ({
      ...c,
      avg_power:
        typeof c.avg_power === 'number'
          ? Math.round(c.avg_power * (scale as number))
          : c.avg_power,
    }));
  }

  // ---- 间歇段与组统计（识别阈值 1.05×FTP → 随 FTP/缩放记录重算）；lap 段来自 FIT 消息，继承 ----
  const intervalResult = detectIntervals(src, athlete);
  const laps = (prev.segments ?? []).filter((s) => !isIntervalItem(s));
  const segments = [...laps, ...(intervalResult?.intervals ?? [])];
  if (segments.length) out.segments = segments;
  else delete out.segments;
  if (intervalResult?.interval_set) out.interval_set = intervalResult.interval_set;
  else delete out.interval_set;

  // ---- 踏频-功率联合分析（骑行专属口径，发力门槛 0.75×FTP）；非骑行保持原样 ----
  if (prev.activity.sport === 'cycling') {
    const cadencePower = cadencePowerAnalysis(src, athlete) ?? undefined;
    if (cadencePower) out.cadence_power = cadencePower;
    else delete out.cadence_power;
  }

  // ---- 0W 根治披露字段回填（f(records) 参数无关，但升级前入库的存量 summary 缺该键/
  // 该类异常——重建时按当前 records 补算，用户改 FTP 触发 reanalyze 即完成历史行追溯；
  // 先滤掉旧 stationary 条目再并入新识别结果，重复触发幂等） ----
  const pedal = pedalTimeBreakdown(src);
  if (pedal) out.pedal_time = pedal;
  else delete out.pedal_time;
  const stationary = detectStationarySpans(src);
  if (stationary.length) {
    const others = (out.anomalies ?? []).filter((a) => a.type !== 'stationary');
    out.anomalies = [...others, ...stationary];
  }

  return out;
}

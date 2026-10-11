/**
 * pedalTime.ts — 踩踏时间分解与静止段识别（0W 根治：pedal_time 进 summary 喂 AI，
 * 静止段进 anomalies；自 VoltCoach 展示层轻量实现升级，与旧仓 index.js 同口径）。
 *
 * 背景（roadmap「0W/踩踏时间分解」）：「计时未停的静止以 0W 进入指标且不被
 * anomalies 标注」。口径拍板（decisions.md #14）：**只披露不改数值**——本模块
 * 提供两件披露：① pedal_time 三分解进 summary，AI 可量化解释 Z1 占比偏高；
 * ② 静止段 stationary 异常标注，解决"不被 anomalies 标注"。NP/TSS/时长/区间
 * 分布等指标数值口径不变（仍计入 0W，与码表/Strava/历史可比）。
 *
 * 口径：
 * - 三分解：踩踏 = P>0；滑行 = P=0 且速度 ≥ 静止阈值；静止 = P=0 且速度低于
 *   阈值（含速度缺失——无速度可证仍在移动，向披露侧保守）。无功率数据的秒
 *   不计入分母（保守口径，同踏频均值剔 0）；
 * - 「静止」速度阈值复用 DATA_QUALITY.pause_resume_speed_kmh（同一物理概念
 *   「低于该速度即静止」，避免两处常量漂移）；
 * - 静止段与暂停/功率缺失判据天然无重叠：暂停=记录空缺、power_gap=功率缺失、
 *   静止=显式 P=0 的有记录秒。
 */

import type { Anomaly, SecRecord } from './analyze.ts';
import { DATA_QUALITY, PEDAL_TIME } from './settings.ts';

/** 踩踏时间分解（秒数口径；占比由渲染侧按 sample_sec 现算） */
export interface PedalTimeBreakdown {
  /** 有功率数据的秒数（分母 = 踩踏 + 滑行 + 静止） */
  sample_sec: number;
  /** 踩踏：power > 0 */
  pedaling_sec: number;
  /** 滑行：power = 0 且 speed ≥ 静止阈值 */
  coasting_sec: number;
  /** 静止：power = 0 且 speed < 静止阈值（含 speed 缺失） */
  stationary_sec: number;
}

/** 逐秒记录 → 三分解；全程无功率数据（如跑步/游泳）返回 null（summary 不出键、卡片隐藏） */
export function pedalTimeBreakdown(records: SecRecord[]): PedalTimeBreakdown | null {
  let sample = 0;
  let pedaling = 0;
  let coasting = 0;
  let stationary = 0;
  for (const r of records) {
    if (r.power == null) continue;
    sample++;
    if (r.power > 0) {
      pedaling++;
    } else if (r.speed != null && r.speed >= DATA_QUALITY.pause_resume_speed_kmh) {
      coasting++;
    } else {
      stationary++;
    }
  }
  return sample
    ? { sample_sec: sample, pedaling_sec: pedaling, coasting_sec: coasting, stationary_sec: stationary }
    : null;
}

/**
 * 计时未停的静止段标注：1s 网格上 P=0 且速度低于静止阈值的连续段，时长达到
 * PEDAL_TIME.stationary_min_sec 才产出 {type:'stationary'} 异常（短暂红灯/起步
 * 不标注，控制条目噪声）。
 */
export function detectStationarySpans(records: SecRecord[]): Anomaly[] {
  const threshold = DATA_QUALITY.pause_resume_speed_kmh;
  const spans: Anomaly[] = [];
  let start = -1;
  for (let i = 0; i <= records.length; i++) {
    const r = records[i];
    const isStationary = r != null && r.power === 0 && (r.speed == null || r.speed < threshold);
    if (isStationary && start < 0) start = i;
    if (!isStationary && start >= 0) {
      const duration = i - start;
      if (duration >= PEDAL_TIME.stationary_min_sec)
        spans.push({ type: 'stationary', duration_sec: duration, at: records[start].timestamp });
      start = -1;
    }
  }
  return spans;
}

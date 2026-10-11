/**
 * pedalTime.ts — 踩踏时间分解（详情页展示层口径，roadmap「0W/踩踏时间分解」的轻量实现）
 *
 * 背景（roadmap 2026-09-25 留档）：「计时未停的静止以 0W 进入指标且不被 anomalies 标注」
 * 的根治属数据侧口径变更（动 summary 会牵动黄金 diff 基准，须走双仓流程），本模块刻意
 * 不做口径变更：只在详情页从已存逐秒数据现算展示三分解——踩踏（P>0）/滑行（P=0 且
 * 移动）/静止（P=0 且速度≈0）。不进 summary、不喂 AI，功率分区与负荷指标口径不变。
 *
 * 口径：
 * - 「静止」速度阈值复用 DATA_QUALITY.pause_resume_speed_kmh（同一物理概念「低于该速度
 *   即静止」，避免两处常量漂移）；
 * - 无功率数据的秒不计入分母（保守口径，同踏频均值剔 0）；
 * - P=0 且速度缺失视为静止（无速度可证仍在移动，向用户提示侧偏保守——提示多报无害，
 *   漏报会让 0W 静止继续伪装成骑行）。
 */

import type { SecRecord } from './analyze.ts';
import { DATA_QUALITY } from './settings.ts';

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

/** 逐秒记录 → 三分解；全程无功率数据（如跑步/游泳）返回 null（卡片隐藏） */
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

/**
 * records.ts — 逐秒记录的抽稀与 CSV 解析（纯函数层）
 *
 * 移植自 reference/src/records.js 的 loadRecords：旧版从 CSV 文件读取，本版拆成
 * 「CSV 解析」与「时间窗截取 + 抽稀」两个纯函数——文件 IO（gzip 落盘/读取）由
 * src/records-store.ts 负责，抽稀口径（≤1400 点、先截取后抽稀）与旧版一致，
 * 详情页图表与 AI 工具（M3 get_activity_records）共用。
 */

import type { SecRecord } from './analyze.ts';

/** 抽稀后的时序点（图表/AI 工具的消费格式，与旧版 /api/records 输出字段一致） */
export interface RecordPoint {
  t: string;
  power: number | null;
  heart_rate: number | null;
  cadence: number | null;
  altitude: number | null;
  speed: number | null;
  distance_m: number | null;
  temperature: number | null;
}

export interface ThinResult {
  points: RecordPoint[];
  total_seconds: number;
  stride: number;
}

/**
 * 解析 records CSV 文本 → 逐秒记录数组（recordsToCsv 的逆函数，缺列/空值归一为 null）。
 */
export function parseRecordsCsv(text: string): SecRecord[] {
  const lines = text.trim().split('\n');
  const rows = lines.slice(1); // 跳过表头
  const num = (s: string | undefined): number | null =>
    s === '' || s == null || Number.isNaN(Number(s)) ? null : Number(s);
  const out: SecRecord[] = [];
  for (const row of rows) {
    const c = row.split(',');
    out.push({
      timestamp: c[0],
      power: num(c[1]),
      heart_rate: num(c[2]),
      cadence: num(c[3]),
      altitude: num(c[4]),
      speed: num(c[5]),
      distance: num(c[6]),
      temperature: num(c[7]),
    });
  }
  return out;
}

/**
 * 时间窗截取 + 抽稀：startSec/endSec 为相对训练开始的秒数（先截取再抽稀），
 * 供 AI 工具只取片段（如"最后 10 分钟功率"）；maxPoints 为输出点数上限
 * （口径 1400：stride = ceil(rows/maxPoints)，从 0 号点起按 stride 取点）。
 */
export function thinRecords(
  records: SecRecord[],
  { maxPoints = 1400, startSec, endSec }: { maxPoints?: number; startSec?: number; endSec?: number } = {},
): ThinResult | null {
  let rows = records;
  // 时间窗截取：按首条时间戳为 0 点计算每行相对秒数
  const hasWindow = startSec != null || endSec != null;
  if (hasWindow && rows.length) {
    const t0 = Date.parse(rows[0].timestamp);
    if (Number.isFinite(t0)) {
      rows = rows.filter((row) => {
        const sec = (Date.parse(row.timestamp) - t0) / 1000;
        if (!Number.isFinite(sec)) return false;
        if (startSec != null && sec < startSec) return false;
        if (endSec != null && sec > endSec) return false;
        return true;
      });
    }
  }
  if (!rows.length) return null;

  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out: RecordPoint[] = [];
  for (let i = 0; i < rows.length; i += stride) {
    const r = rows[i];
    out.push({
      t: r.timestamp,
      power: r.power,
      heart_rate: r.heart_rate,
      cadence: r.cadence,
      altitude: r.altitude,
      speed: r.speed,
      distance_m: r.distance,
      temperature: r.temperature,
    });
  }
  return { points: out, total_seconds: rows.length, stride };
}

/**
 * 文件名安全化：只取 basename（兼容 / 与 \ 分隔符），含路径穿越片段返回 null。
 * 入库键与 records 文件名共用此口径，防止系统 URI/分享文件名带路径。
 */
export function safeName(name: unknown): string | null {
  if (!name || typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop() ?? name;
  return base === name && !base.includes('..') && base.length > 0 ? base : null;
}

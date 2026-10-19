/**
 * records.ts — 逐秒记录的抽稀与 CSV 解析（纯函数层）
 *
 * 移植自 fit-reader Web 版 src/records.js 的 loadRecords：旧版从 CSV 文件读取，本版拆成
 * 「CSV 解析」与「时间窗截取 + 抽稀」两个纯函数——文件 IO（gzip 落盘/读取）由
 * src/records-store.ts 负责，抽稀口径（≤1400 点、先截取后抽稀）与旧版一致，
 * 详情页图表与 AI 工具（M3 get_activity_records）共用。
 * M5 追加首帧时间戳读取（firstRecordTimestampFromGz）：AI 报告标题要显示起骑时刻，
 * 解压后只扫头部两行，不解析整篇逐秒记录。
 */

import { ungzip } from 'pako';
import type { SecRecord } from './analyze.ts';
import { isActivityUuid } from './identity.ts';

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

// ---------------- 文件布局（v3：records 以活动 uuid 命名，迁移逻辑纯函数） ----------------

/** records 存储基名是否为活动 uuid（与 db 身份同一形状，单源在 core/identity） */
export function isActivityRecordBase(base: unknown): base is string {
  return isActivityUuid(base);
}

/** 旧布局（v2 及以前）的活动文件名 → records 基名（去最后一个扩展名） */
export function recordBaseFromFileName(fileName: string): string | null {
  const safe = safeName(fileName);
  if (!safe) return null;
  return safe.replace(/\.[^.]+$/, '');
}

/** records 目录布局迁移计划（纯函数；执行侧只做 IO） */
export interface RecordLayoutPlan {
  /** 旧基名 → uuid 的复制（多条活动共享同一旧基名时会出现多条） */
  copies: { from: string; to: string }[];
  /** 全部复制完成后可删除的旧基名（不是任何活动的 uuid 目标） */
  deletes: string[];
}

/**
 * 计算 v2 → v3 records 布局迁移计划：
 *  - 目标 `<uuid>` 已存在 → 不复制（幂等重跑）；
 *  - 目标缺失且旧基名文件存在 → 复制（复制而非改名：`ride.fit`/`ride.FIT` 在旧
 *    布局下会落到同一个 `ride` 基名，直接 rename 会丢掉其中一条）；
 *  - 迁移完成后删除不再被任何活动 uuid 引用的旧基名；孤儿文件（无活动引用）不动。
 */
export function planRecordLayout(
  activities: { uuid: string; file_name: string }[],
  existingBases: string[],
): RecordLayoutPlan {
  const existing = new Set(existingBases);
  const targets = new Set<string>();
  const oldBases = new Set<string>();
  const copies: { from: string; to: string }[] = [];
  for (const a of activities) {
    if (!isActivityRecordBase(a.uuid)) continue; // 防御：非法身份不参与改名
    targets.add(a.uuid);
    const old = recordBaseFromFileName(a.file_name);
    if (!old || old === a.uuid) continue;
    oldBases.add(old);
    if (!existing.has(a.uuid) && existing.has(old)) copies.push({ from: old, to: a.uuid });
  }
  const deletes = [...oldBases].filter((b) => existing.has(b) && !targets.has(b)).sort();
  return { copies, deletes };
}

// ---------------- 首帧时间戳（起骑时刻，M5：AI 报告标题用） ----------------

/**
 * 从 records CSV 文本取首条数据行的时间戳（ISO UTC）。
 * 只扫到第二个换行为止（不 split 整篇——万行 CSV 没必要为一行付分配的代价）；
 * 表头之后没有完整数据行（空文件/被截断）返回 null。
 */
export function firstTimestampFromCsvHead(text: string): string | null {
  if (!text) return null;
  const headEnd = text.indexOf('\n');
  if (headEnd < 0) return null;
  const lineEnd = text.indexOf('\n', headEnd + 1);
  const first = text.slice(headEnd + 1, lineEnd < 0 ? undefined : lineEnd).split(',')[0]?.trim() ?? '';
  // 末行可能缺换行（文件未以 \n 收尾），因此不要求有第二个换行；但时间戳必须形状完整
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(first) ? first : null;
}

/**
 * 从 records gzip 字节取首帧时间戳（ISO UTC）；无逐秒记录或数据损坏返回 null。
 * 解压失败与解析失败同口径（null）——调用方（AI 报告标题）缺这一项时退回只显示日期。
 */
export function firstRecordTimestampFromGz(gz: Uint8Array): string | null {
  if (!gz.length) return null;
  try {
    return firstTimestampFromCsvHead(ungzip(gz, { toText: true }));
  } catch {
    return null;
  }
}

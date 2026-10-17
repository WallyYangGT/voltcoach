/**
 * dedupe.ts（services）— 判重所需骑行键的起骑时刻补齐（2026-10-17 室内骑行判重）
 *
 * 核心判定在 src/core/dedupe.ts（纯函数）：无有效距离（null/0）的室内骑行需要
 * 「起骑时刻 ±60s」才能安全判重，但 activities 表只存 UTC 日期（date 列无时刻），
 * 精确起骑时刻要到 records gzip 首帧里读。本层负责按需补齐：
 *  - 只在「同一 UTC 日期出现 ≥2 条无有效距离记录」时读 records（否则不可能构成
 *    室内重复组；导入路径只补候选同日期），避免每次全表解压；
 *  - 复用 aiTitle.getRideStartAt 的进程内缓存（导入/删除/合并时已统一失效）；
 *  - 读不到首帧（records 缺失/损坏/导入时落盘失败的旧行）→ start_at=null，
 *    核心判定保守地不判重。
 *
 * 设备侧模块（依赖 records-store / expo-file-system），不进 node:test；
 * 纯判定逻辑的测试见 test/dedupe.test.mjs 与 test/dedupe-indoor.test.mjs。
 */

import { listActivityRideKeys, type ActivityRideKey } from '@/db';
import { hasPositiveDistance, type RideKey } from '@/core/dedupe';
import { getRideStartAt } from './aiTitle';

/** 判重用的骑行键：db 行 + 起骑时刻（无有效距离时才可能非空） */
export interface RideKeyWithStart extends ActivityRideKey {
  start_at: string | null;
}

/** 给指定候选行补起骑时刻；其余行 start_at=null（日期不同的行不会被核心判定比较到） */
async function withStarts(
  rows: ActivityRideKey[],
  candidates: ActivityRideKey[],
): Promise<RideKeyWithStart[]> {
  if (!candidates.length) return rows.map((r) => ({ ...r, start_at: null }));
  const starts = new Map<string, string | null>();
  // 串行读取：每条候选都要整包解压 records gzip，同一日期候选多时并发会同时压多份
  // 文件进内存；个人训练量级（同日期无距离候选通常 2–5 条）串行成本可忽略
  for (const r of candidates) starts.set(r.file_name, await getRideStartAt(r.file_name));
  return rows.map((r) => ({ ...r, start_at: starts.get(r.file_name) ?? null }));
}

/**
 * 全表骑行键（数据管理页「重复检查」用）：只对同一日期出现 ≥2 条无有效距离记录的
 * 行补起骑时刻——单条室内记录不可能有重复组，不读盘。
 */
export async function listRideKeysForDedupe(): Promise<RideKeyWithStart[]> {
  const rows = await listActivityRideKeys();
  const noDistanceByDate = new Map<string, ActivityRideKey[]>();
  for (const r of rows) {
    if (hasPositiveDistance(r.distance_km)) continue;
    const bucket = noDistanceByDate.get(r.date);
    if (bucket) bucket.push(r);
    else noDistanceByDate.set(r.date, [r]);
  }
  const candidates = [...noDistanceByDate.values()].filter((g) => g.length >= 2).flat();
  return withStarts(rows, candidates);
}

/**
 * 导入查重用：候选有有效距离时不需要任何起骑时刻（走原户外指纹）；候选无有效距离时
 * 只补候选同日期、同样无有效距离的库内行——这是唯一可能命中的集合。
 */
export async function enrichRideKeysForDedupe(
  rows: ActivityRideKey[],
  candidate: RideKey,
): Promise<RideKeyWithStart[]> {
  if (hasPositiveDistance(candidate.distance_km)) {
    return rows.map((r) => ({ ...r, start_at: null }));
  }
  const candidates = rows.filter(
    (r) => r.date === candidate.date && !hasPositiveDistance(r.distance_km),
  );
  return withStarts(rows, candidates);
}

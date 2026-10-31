/**
 * memories.ts — AI 记忆域（ai_memories 表，带时间戳与取代链，M3）
 *
 * 记忆保存/注入集合/管理列表/删除/失效清除。短期记忆失效判定与失效记忆的
 * 物理删除判定单一事实源在 core/memory（不在 SQL 里复制失效天数/次数/宽限期
 * 规则），本层取全量后 JS 侧过滤；表受 MEMORY_KEEP=100 约束，全量取回后过滤
 * 的代价可忽略。
 *
 * 失效记忆生命周期（v4 起）：过期（short）或被取代（superseded_by）即退出
 * 注入集合 + 管理页灰标，失效满 core/memory 的 MEMORY_PURGE_GRACE_DAYS（5 天）
 * 后物理删除——清除触发点：saveMemory 写入时顺带 + App 冷启动/回前台的
 * purgeInvalidatedMemoriesQuietly（节流）。
 */

import { getDb } from './client';
import { invalidateDb } from './notify';
import { t, type Lang } from '@/core/i18n';
import {
  isShortMemoryExpired,
  memoryInvalidatedAtMs,
  shouldPurgeMemory,
  MEMORY_PURGE_GRACE_DAYS,
  type MemoryScope,
} from '@/core/memory';

// 记忆分类白名单（非法值归入 general）；strategy = 与教练商定的训练策略（权威段，见 prompts）
const MEMORY_CATEGORIES = new Set(['general', 'injury', 'schedule', 'goal', 'preference', 'strategy']);
// 单条记忆长度上限（AI 用中文概括的完整陈述）
const MEMORY_MAX_LEN = 500;
// 库中最多保留条数：超出先删最旧的已被取代记忆，不足再删最旧有效记忆
const MEMORY_KEEP = 100;

/** 记忆行（listAll 附 active/expired/purge_in_days 标记） */
export interface AiMemoryRow {
  id: number;
  content: string;
  category: string;
  source: string | null;
  /** 分层：short = 近期上下文（14 天或 5 次训练先到即失效，常量见 core/memory.ts），long = 长期（默认） */
  scope: string;
  created_at: string;
  superseded_by: number | null;
  /** 被取代时刻（v4 起落库；取代动作发生的那一刻，物理删除宽限期的计时起点） */
  superseded_at: string | null;
  active?: boolean;
  /** 仅短期记忆可能为 true：已过失效线（注入时被过滤、管理页灰显） */
  expired?: boolean;
  /**
   * 距自动清除的天数（向上取整）：仅已失效条目非空（宽限期内 1..N，管理页
   * 倒计时徽标用）；有效条目/无法确定失效时刻的条目为 null（不清除）。
   */
  purge_in_days?: number | null;
}

/**
 * 保存一条 AI 记忆（用户个人事实：伤病/日程约束/目标变化/明确偏好/训练策略等），返回 id。
 * content 必填且 ≤500 字；category 非法归 general；scope 非法归 long；
 * supersedes_id 存在时校验目标记忆存在，并把其 superseded_by/superseded_at 置为
 * 新 id/当前时刻（被取代的记忆退出注入集合，失效满宽限期后被 purgeInvalidatedMemories
 * 物理删除）。非法输入抛 Error（双语 message，工具层转为 {error} JSON 反馈给 AI）。
 */
export async function saveMemory(
  input: {
    content?: unknown;
    category?: unknown;
    scope?: unknown;
    source?: string | null;
    supersedes_id?: unknown;
  },
  lang: Lang = 'zh',
): Promise<number> {
  const text = String(input?.content ?? '').trim();
  if (!text) throw new Error(t(lang, 'memory.empty'));
  if (text.length > MEMORY_MAX_LEN)
    throw new Error(t(lang, 'memory.too_long', { n: MEMORY_MAX_LEN }));
  const cat = MEMORY_CATEGORIES.has(input?.category as string)
    ? (input.category as string)
    : 'general';
  const scope: MemoryScope = input?.scope === 'short' ? 'short' : 'long';
  const db = await getDb();
  let supersedeId: number | null = null;
  if (input?.supersedes_id != null) {
    supersedeId = Number(input.supersedes_id);
    const target = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM ai_memories WHERE id = ?`,
      supersedeId,
    );
    if (!target)
      throw new Error(t(lang, 'memory.supersede_not_found', { id: supersedeId }));
  }
  const info = await db.runAsync(
    `INSERT INTO ai_memories (content, category, source, scope) VALUES (?, ?, ?, ?)`,
    text,
    cat,
    input?.source ?? null,
    scope,
  );
  const id = Number(info.lastInsertRowId);
  if (supersedeId != null) {
    // superseded_at 是宽限期的计时起点（取代时刻）；重复取代同一目标时两列一并覆盖，以最新为准
    await db.runAsync(
      `UPDATE ai_memories SET superseded_by = ?, superseded_at = datetime('now') WHERE id = ?`,
      id,
      supersedeId,
    );
  }
  // 失效清除：过期/被取代满宽限期的行先出局（core 判定），再按 MEMORY_KEEP 条数兜底
  await purgeInvalidatedMemories();
  // 滚动清理：最多保留 100 条，先删最旧的已被取代记忆，不足再删最旧有效记忆
  const totalRow = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM ai_memories`);
  let excess = (totalRow?.c ?? 0) - MEMORY_KEEP;
  if (excess > 0) {
    const del = await db.runAsync(
      `DELETE FROM ai_memories WHERE id IN (
         SELECT id FROM ai_memories WHERE superseded_by IS NOT NULL ORDER BY id LIMIT ?
       )`,
      excess,
    );
    excess -= del.changes;
    if (excess > 0) {
      await db.runAsync(
        `DELETE FROM ai_memories WHERE id IN (
           SELECT id FROM ai_memories ORDER BY id LIMIT ?
         )`,
        excess,
      );
    }
  }
  invalidateDb('memories');
  return id;
}

/**
 * 全部「可注入」记忆（未被取代，且短期记忆未过失效线），id DESC。
 * E1 起默认返回全量（≤MEMORY_KEEP=100），由编排层用 rankMemories 按相关度
 * top-k 挑选；不再在这里截最近 30 条（旧口径会让高相关旧记忆永远进不了 prompt）。
 * 失效过滤在 JS 侧调 core/memory 的单一判定源（不在 SQL 里复制失效天数/次数规则）；
 * 表受 MEMORY_KEEP=100 约束，全量取回后过滤的代价可忽略。
 */
export async function listMemories(n = MEMORY_KEEP): Promise<AiMemoryRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<AiMemoryRow>(
    `SELECT id, content, category, source, scope, created_at
     FROM ai_memories WHERE superseded_by IS NULL
     ORDER BY id DESC`,
  );
  const activityTimes = await listActivityCreatedAts();
  const nowMs = Date.now();
  return rows.filter((m) => !isShortMemoryExpired(m, nowMs, activityTimes)).slice(0, n);
}

/** 全部记忆（含已被取代与已过期的，管理界面用；id DESC，附 active/expired/purge_in_days 标记） */
export async function listAllMemories(): Promise<AiMemoryRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<AiMemoryRow>(
    `SELECT id, content, category, source, scope, created_at, superseded_by, superseded_at
     FROM ai_memories ORDER BY id DESC`,
  );
  const activityTimes = await listActivityCreatedAts();
  const nowMs = Date.now();
  return rows.map((r) => ({
    ...r,
    active: r.superseded_by == null,
    expired: isShortMemoryExpired(r, nowMs, activityTimes),
    purge_in_days: purgeInDays(r, nowMs, activityTimes),
  }));
}

/**
 * 距自动清除的天数（向上取整）：仅对「已失效」条目给值——失效时刻（core 单源）
 * 已过当前时刻；宽限期内显示 1..N 的倒计时，满宽限期后被 purgeInvalidatedMemories
 * 删除。有效条目/失效时刻落在未来（如第 5 次训练时刻晚于现在）/无法判定 → null。
 */
function purgeInDays(
  row: AiMemoryRow,
  nowMs: number,
  activityCreatedAts: string[],
): number | null {
  const invalidatedAt = memoryInvalidatedAtMs(row, activityCreatedAts);
  if (invalidatedAt == null || invalidatedAt > nowMs) return null;
  const remainingMs = invalidatedAt + MEMORY_PURGE_GRACE_DAYS * 86400000 - nowMs;
  return Math.max(1, Math.ceil(remainingMs / 86400000));
}

/**
 * 物理删除「失效满宽限期」的记忆，返回删除条数。判定调 core/memory 的
 * shouldPurgeMemory（单一事实源），被取代看 superseded_at、短期过期看 14 天线/
 * 第 5 次训练时刻，先失效者起算。删除后发 memories 域事件（正开着的记忆页即时重取）。
 */
export async function purgeInvalidatedMemories(): Promise<number> {
  const db = await getDb();
  const rows = await db.getAllAsync<AiMemoryRow>(
    `SELECT id, scope, created_at, superseded_by, superseded_at FROM ai_memories`,
  );
  if (rows.length === 0) return 0;
  const activityTimes = await listActivityCreatedAts();
  const nowMs = Date.now();
  const ids = rows
    .filter((r) => shouldPurgeMemory(r, nowMs, activityTimes))
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  const info = await db.runAsync(
    `DELETE FROM ai_memories WHERE id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  if (info.changes > 0) invalidateDb('memories');
  return info.changes;
}

// 静默清理节流：App 冷启动/回前台的 Dispatcher 触发，1 小时内最多实跑一次
const PURGE_THROTTLE_MS = 3_600_000;
let lastPurgeAttempt = 0;

/**
 * purgeInvalidatedMemories 的静默壳：节流 + 自吞异常（失败只告警，下个触发点重试）。
 * 供 _layout 的 MemoryPurgeDispatcher 调用——清理失败不能打扰启动/回前台路径；
 * saveMemory 内部走无节流的原函数，保证每次写记忆都顺带清一次。
 */
export async function purgeInvalidatedMemoriesQuietly(): Promise<void> {
  if (Date.now() - lastPurgeAttempt < PURGE_THROTTLE_MS) return;
  lastPurgeAttempt = Date.now();
  try {
    await purgeInvalidatedMemories();
  } catch (e) {
    console.warn('失效记忆清理失败（下个触发点重试）:', e);
  }
}

/** 全部活动的入库时刻（短期记忆失效判定的「新增训练数」依据；≤数百行） */
async function listActivityCreatedAts(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ created_at: string }>(
    `SELECT created_at FROM activities`,
  );
  return rows.map((r) => r.created_at);
}

/** 删除指定记忆，返回删除条数（0 = 不存在） */
export async function deleteMemory(id: number): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(`DELETE FROM ai_memories WHERE id = ?`, id);
  if (info.changes > 0) invalidateDb('memories');
  return info.changes;
}

/**
 * memories.ts — AI 记忆域（ai_memories 表，带时间戳与取代链，M3）
 *
 * 记忆保存/注入集合/管理列表/删除。短期记忆失效判定单一事实源在 core/memory
 * （不在 SQL 里复制失效天数/次数规则），本层取全量后 JS 侧过滤；表受
 * MEMORY_KEEP=100 约束，全量取回后过滤的代价可忽略。
 */

import { getDb } from './client';
import { t, type Lang } from '@/core/i18n';
import { isShortMemoryExpired, type MemoryScope } from '@/core/memory';

// 记忆分类白名单（非法值归入 general）；strategy = 与教练商定的训练策略（权威段，见 prompts）
const MEMORY_CATEGORIES = new Set(['general', 'injury', 'schedule', 'goal', 'preference', 'strategy']);
// 单条记忆长度上限（AI 用中文概括的完整陈述）
const MEMORY_MAX_LEN = 500;
// 库中最多保留条数：超出先删最旧的已被取代记忆，不足再删最旧有效记忆
const MEMORY_KEEP = 100;

/** 记忆行（listAll 附 active/expired 标记） */
export interface AiMemoryRow {
  id: number;
  content: string;
  category: string;
  source: string | null;
  /** 分层：short = 近期上下文（14 天或 5 次训练先到即失效，常量见 core/memory.ts），long = 长期（默认） */
  scope: string;
  created_at: string;
  superseded_by: number | null;
  active?: boolean;
  /** 仅短期记忆可能为 true：已过失效线（注入时被过滤、管理页灰显） */
  expired?: boolean;
}

/**
 * 保存一条 AI 记忆（用户个人事实：伤病/日程约束/目标变化/明确偏好/训练策略等），返回 id。
 * content 必填且 ≤500 字；category 非法归 general；scope 非法归 long；
 * supersedes_id 存在时校验目标记忆存在，并把其 superseded_by 置为新 id
 * （被取代的记忆不再注入但保留可追溯）。非法输入抛 Error（双语 message，
 * 工具层转为 {error} JSON 反馈给 AI）。
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
    await db.runAsync(`UPDATE ai_memories SET superseded_by = ? WHERE id = ?`, id, supersedeId);
  }
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

/** 全部记忆（含已被取代与已过期的，管理界面用；id DESC，附 active/expired 标记） */
export async function listAllMemories(): Promise<AiMemoryRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<AiMemoryRow>(
    `SELECT id, content, category, source, scope, created_at, superseded_by
     FROM ai_memories ORDER BY id DESC`,
  );
  const activityTimes = await listActivityCreatedAts();
  const nowMs = Date.now();
  return rows.map((r) => ({
    ...r,
    active: r.superseded_by == null,
    expired: isShortMemoryExpired(r, nowMs, activityTimes),
  }));
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
  return info.changes;
}

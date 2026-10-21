/**
 * chats.ts — AI 对话域（ai_chats / ai_chat_messages 表，追问与直接对话统一，M3）
 * + 对话滚动摘要（E1 上下文装配器，2026-10-17）
 *
 * 对话 CRUD、每 mode 50 条滚动清理、pending 占位与取消守卫、续跑扫描轻查询。
 * 滚动摘要存 settings 表 `chat_summary:<chatId>` JSON 行：**不加列、不动
 * SCHEMA_VERSION**（沿 dossier/training_plan 的 settings KV 先例），备份整库拷贝
 * 透明携带。生命周期与 ai_chats 绑定：deleteAiChat 删行；createAiChat 滚动清理旧
 * 对话后按前缀清孤儿行（AUTOINCREMENT 不复用 id，残留行不会误配新对话，但收拾干净）。
 */

import { getDb } from './client';
import { invalidateDb } from './notify';
import {
  CHAT_SUMMARY_SHAPE,
  parseChatSummary,
  type ChatSummaryRecord,
} from '@/core/chat-summary';

/** mode：follow_up 报告追问 / chat 直接对话 / plan 训练计划会话（v2，锚定当前计划而非活动，file_name/report_id 恒空） */
export type AiChatMode = 'follow_up' | 'chat' | 'plan';

// 每个 mode 滚动保留的对话数上限（沿用 ai_reports 的 id DESC LIMIT 清理模式）
const AI_CHAT_KEEP = 50;

/** 对话列表项（附消息条数与 pending 标记，供列表态显示"生成中"，不含正文） */
export interface AiChatListItem {
  id: number;
  mode: AiChatMode;
  report_id: number | null;
  /** 追问锚定的活动（v3；活动删除后置 NULL，靠 activity_fingerprint 重挂） */
  activity_uuid: string | null;
  title: string | null;
  message_count: number;
  has_pending: boolean;
  created_at: string;
  updated_at: string;
}

/** 对话消息行 */
export interface AiChatMessageRow {
  id: number;
  chat_id: number;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  error: string | null;
  created_at: string;
}

/** 对话元信息 + 全部消息（按 id 升序） */
export interface AiChatRow extends Omit<AiChatListItem, 'message_count' | 'has_pending'> {
  messages: AiChatMessageRow[];
}

/**
 * 创建 AI 对话（mode: follow_up 报告追问 / chat 直接对话 / plan 计划会话），返回 id。
 * 每个 mode 仅保留最近 50 个对话，超出的旧对话连同其全部消息一起删除（级联）。
 * activity_uuid 非空时一并落活动指纹（删除后重挂用）。
 */
export async function createAiChat(
  mode: AiChatMode,
  meta: { report_id?: number | null; activity_uuid?: string | null; title?: string | null } = {},
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_chats (mode, report_id, activity_uuid, activity_fingerprint, title)
     VALUES (?, ?, ?, (SELECT fingerprint FROM activities WHERE uuid = ?), ?)`,
    mode,
    meta.report_id ?? null,
    meta.activity_uuid ?? null,
    meta.activity_uuid ?? null,
    meta.title ?? null,
  );
  const id = Number(info.lastInsertRowId);
  // 滚动清理：先删被挤出对话的消息，再删对话本身
  await db.runAsync(
    `DELETE FROM ai_chat_messages WHERE chat_id IN (
       SELECT id FROM ai_chats WHERE mode = ? AND id NOT IN (
         SELECT id FROM ai_chats WHERE mode = ? ORDER BY id DESC LIMIT ?
       )
     )`,
    mode,
    mode,
    AI_CHAT_KEEP,
  );
  await db.runAsync(
    `DELETE FROM ai_chats
     WHERE id NOT IN (
       SELECT id FROM ai_chats WHERE mode = ? ORDER BY id DESC LIMIT ?
     ) AND mode = ?`,
    mode,
    AI_CHAT_KEEP,
    mode,
  );
  await pruneOrphanChatSummaries(); // 被挤出对话的滚动摘要行一并清理
  invalidateDb('chats');
  return id;
}

/** 追加一条对话消息（assistant 可用 status='pending' 占位），返回消息 id */
export async function addAiChatMessage(
  chatId: number,
  role: AiChatMessageRow['role'],
  content: string,
  status = 'completed',
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_chat_messages (chat_id, role, content, status) VALUES (?, ?, ?, ?)`,
    chatId,
    role,
    String(content ?? ''),
    status,
  );
  invalidateDb('chats');
  return Number(info.lastInsertRowId);
}

/** 更新对话消息（后台生成成功/失败时回填，COALESCE 语义同 updateAiReport） */
export async function updateAiChatMessage(
  id: number,
  patch: { content?: string; status?: string; error?: string | null },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE ai_chat_messages
     SET content = COALESCE(?, content),
         status = COALESCE(?, status),
         error = COALESCE(?, error)
     WHERE id = ?`,
    patch.content ?? null,
    patch.status ?? null,
    patch.error ?? null,
    id,
  );
  invalidateDb('chats');
}

/** 用户取消对话消息生成（同 cancelPendingAiReport 的 pending 守卫口径），返回是否取消成功 */
export async function cancelPendingChatMessage(id: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE ai_chat_messages SET status = 'cancelled', error = NULL WHERE id = ? AND status = 'pending'`,
    id,
  );
  if (r.changes > 0) invalidateDb('chats');
  return r.changes > 0;
}

/** 有新消息时刷新对话的 updated_at（列表按它倒序，最近活跃的对话排前） */
export async function touchAiChat(chatId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE ai_chats SET updated_at = datetime('now') WHERE id = ?`, chatId);
  invalidateDb('chats');
}

/**
 * 待恢复的对话占位消息（status=pending 的 chat_id/message_id + created_at）。
 * 只读轻查询，供根布局回前台/冷启动时的自动续跑扫描用（同 listPendingAiReportRefs）。
 */
export async function listPendingChatMessageRefs(): Promise<
  { chat_id: number; message_id: number; created_at: string }[]
> {
  const db = await getDb();
  return db.getAllAsync<{ chat_id: number; message_id: number; created_at: string }>(
    `SELECT chat_id, id AS message_id, created_at
     FROM ai_chat_messages WHERE status = 'pending' ORDER BY id`,
  );
}

/** 某 mode 的对话列表（按 updated_at 倒序，附消息条数与 pending 标记，不含正文） */
export async function listAiChats(mode: AiChatMode, n = AI_CHAT_KEEP): Promise<AiChatListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    mode: AiChatMode;
    report_id: number | null;
    activity_uuid: string | null;
    title: string | null;
    message_count: number;
    has_pending: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT c.id, c.mode, c.report_id, c.activity_uuid, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.chat_id = c.id) AS message_count,
            EXISTS(SELECT 1 FROM ai_chat_messages m
                   WHERE m.chat_id = c.id AND m.status = 'pending') AS has_pending
     FROM ai_chats c WHERE c.mode = ?
     ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    mode,
    n,
  );
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    report_id: r.report_id,
    activity_uuid: r.activity_uuid,
    title: r.title,
    message_count: r.message_count,
    has_pending: !!r.has_pending,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/** 按 id 取对话元信息 + 全部消息（按 id 升序），不存在返回 null */
export async function getAiChat(id: number): Promise<AiChatRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: number;
    mode: AiChatMode;
    report_id: number | null;
    activity_uuid: string | null;
    title: string | null;
    created_at: string;
    updated_at: string;
  }>(`SELECT * FROM ai_chats WHERE id = ?`, id);
  if (!row) return null;
  const messages = await db.getAllAsync<AiChatMessageRow>(
    `SELECT id, chat_id, role, content, status, error, created_at
     FROM ai_chat_messages WHERE chat_id = ? ORDER BY id`,
    id,
  );
  return {
    id: row.id,
    mode: row.mode,
    report_id: row.report_id,
    activity_uuid: row.activity_uuid,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    messages,
  };
}

/** 该报告最新的 follow_up 对话 id（报告详情页追问"继续既有对话"用），没有返回 null */
export async function findFollowUpChat(reportId: number): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM ai_chats WHERE mode = 'follow_up' AND report_id = ?
     ORDER BY id DESC LIMIT 1`,
    reportId,
  );
  return row?.id ?? null;
}

/**
 * 最新的训练计划会话 id（计划页底部追问窗口用）：计划会话不锚定活动/报告，
 * 跨计划版本存活（调整产生新版本后同一会话继续），全局只有一条活跃线程，
 * 滚动清理按 mode 独立计数不会误删。没有返回 null。
 */
export async function findPlanChat(): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM ai_chats WHERE mode = 'plan' ORDER BY id DESC LIMIT 1`,
  );
  return row?.id ?? null;
}

/** 删除整个对话及其全部消息，返回删除的对话数（0 = 不存在） */
export async function deleteAiChat(id: number): Promise<number> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM ai_chat_messages WHERE chat_id = ?`, id);
  const info = await db.runAsync(`DELETE FROM ai_chats WHERE id = ?`, id);
  // 滚动摘要行随对话删除（settings KV，无外键；不删会成为孤儿行）
  await db.runAsync(`DELETE FROM settings WHERE key = ?`, chatSummaryKey(id));
  if (info.changes > 0) invalidateDb('chats');
  return info.changes;
}

// ---------------- 对话滚动摘要（E1 上下文装配器，2026-10-17） ----------------

const CHAT_SUMMARY_KEY_PREFIX = 'chat_summary:';
const chatSummaryKey = (chatId: number) => `${CHAT_SUMMARY_KEY_PREFIX}${chatId}`;

/** 读取对话滚动摘要（行损坏/形状不符返回 null，下次成功摘要自愈覆盖） */
export async function getChatSummary(chatId: number): Promise<ChatSummaryRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    chatSummaryKey(chatId),
  );
  return parseChatSummary(row?.value);
}

/** 写入对话滚动摘要（up_to_message_id 为已覆盖的最后一条消息 id） */
export async function saveChatSummary(
  chatId: number,
  summary: string,
  upToMessageId: number,
): Promise<void> {
  const db = await getDb();
  const entry: ChatSummaryRecord = {
    shape: CHAT_SUMMARY_SHAPE,
    up_to_message_id: upToMessageId,
    summary,
  };
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    chatSummaryKey(chatId),
    JSON.stringify(entry),
  );
}

/** 清理已不存在的对话留下的摘要行（createAiChat 滚动删除后调用；best-effort，失败不影响新建对话） */
async function pruneOrphanChatSummaries(): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      `DELETE FROM settings
       WHERE key LIKE 'chat_summary:%'
         AND CAST(substr(key, ?) AS INTEGER) NOT IN (SELECT id FROM ai_chats)`,
      CHAT_SUMMARY_KEY_PREFIX.length + 1,
    );
  } catch (e) {
    console.warn('清理孤儿对话摘要失败（不影响新建对话）:', e);
  }
}

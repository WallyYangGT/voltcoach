/// <reference types="node" />
/**
 * chats.test.ts — AI 对话域（含滚动摘要）真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：每 mode 50 条滚动清理（消息级联 + 摘要孤儿行回收）、
 * activity_uuid 指纹捕获、updateAiChatMessage 的 COALESCE、cancelPendingChatMessage
 * 守卫、列表聚合列（message_count/has_pending）。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import {
  addAiChatMessage,
  cancelPendingChatMessage,
  createAiChat,
  deleteAiChat,
  findFollowUpChat,
  findPlanChat,
  getAiChat,
  getChatSummary,
  listAiChats,
  listPendingChatMessageRefs,
  saveChatSummary,
  touchAiChat,
  updateAiChatMessage,
} from '@/db/chats';
import { saveAiReport } from '@/db/reports';
import { getRawDb, resetTestDb, seedActivityRow } from '../helpers/sqlite-port';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

beforeEach(() => {
  resetTestDb();
});
describe('创建与滚动清理', () => {
  test('activity_uuid 非空时一并落活动指纹（删除后重挂用）', async () => {
    const uuid = seedActivityRow({ fingerprint: 'fp-chat' });
    const id = await createAiChat('follow_up', { report_id: null, activity_uuid: uuid });
    const row = getRawDb()
      .prepare(`SELECT activity_uuid, activity_fingerprint, report_id FROM ai_chats WHERE id = ?`)
      .get(id) as { activity_uuid: string; activity_fingerprint: string; report_id: number | null };
    expect(row.activity_uuid).toBe(uuid);
    expect(row.activity_fingerprint).toBe('fp-chat');
  });
  test('每 mode 滚动保留 50 条：被挤出对话的消息与摘要行一并回收', async () => {
    const first = await createAiChat('chat');
    await addAiChatMessage(first, 'user', '第一条对话的消息');
    await saveChatSummary(first, '摘要', 1);
    for (let i = 0; i < 50; i += 1) {
      await createAiChat('chat');
    }
    const chats = await listAiChats('chat');
    expect(chats).toHaveLength(50);
    expect(chats.some((c) => c.id === first)).toBe(false); // 最旧对话被挤出
    // 消息与摘要孤儿行随对话一起消失
    const msg = getRawDb().prepare(`SELECT COUNT(*) AS c FROM ai_chat_messages`).get() as { c: number };
    expect(msg.c).toBe(0);
    const summary = getRawDb()
      .prepare(`SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'chat_summary:%'`)
      .get() as { c: number };
    expect(summary.c).toBe(0);
    // plan mode 独立计数不受 chat 滚动影响
    expect(await findPlanChat()).toBeNull();
  });
});
describe('消息与取消守卫', () => {
  test('追加/更新消息；COALESCE 不覆盖既有正文', async () => {
    const chatId = await createAiChat('follow_up', { report_id: null });
    const msgId = await addAiChatMessage(chatId, 'assistant', '', 'pending');
    await updateAiChatMessage(msgId, { content: '部分正文', status: 'pending' });
    await updateAiChatMessage(msgId, { status: 'completed', error: null });
    const row = (await getAiChat(chatId))?.messages[0];
    expect(row?.content).toBe('部分正文');
    expect(row?.status).toBe('completed');
  });
  test('cancelPendingChatMessage 的 pending 守卫', async () => {
    const chatId = await createAiChat('chat');
    const msgId = await addAiChatMessage(chatId, 'assistant', '', 'pending');
    expect(await cancelPendingChatMessage(msgId)).toBe(true);
    expect(await cancelPendingChatMessage(msgId)).toBe(false);
  });
  test('touchAiChat 刷新 updated_at（列表排序依据）', async () => {
    const chatId = await createAiChat('chat');
    const before = getRawDb().prepare(`SELECT updated_at FROM ai_chats WHERE id = ?`).get(chatId) as {
      updated_at: string;
    };
    await touchAiChat(chatId);
    const after = getRawDb().prepare(`SELECT updated_at FROM ai_chats WHERE id = ?`).get(chatId) as {
      updated_at: string;
    };
    expect(new Date(after.updated_at + 'Z').getTime()).toBeGreaterThanOrEqual(
      new Date(before.updated_at + 'Z').getTime(),
    );
  });
});
describe('列表聚合与查找', () => {
  test('listAiChats 附消息条数与 pending 标记', async () => {
    const a = await createAiChat('chat', { title: 'A' });
    await addAiChatMessage(a, 'user', 'q');
    const b = await createAiChat('chat', { title: 'B' });
    await addAiChatMessage(b, 'assistant', '', 'pending');
    const chats = await listAiChats('chat');
    expect(chats.map((c) => c.title)).toEqual(['B', 'A']); // updated_at DESC（同秒回退 id DESC）
    expect(chats[0].has_pending).toBe(true);
    expect(chats[1].message_count).toBe(1);
  });
  test('findFollowUpChat / findPlanChat 按 mode 各取最新', async () => {
    const reportId = await saveAiReport('review', null, 'p', 'm'); // ai_chats.report_id 有外键，须真实报告
    const fu1 = await createAiChat('follow_up', { report_id: reportId });
    await createAiChat('chat');
    const fu2 = await createAiChat('follow_up', { report_id: reportId });
    expect(await findFollowUpChat(reportId)).toBe(fu2);
    expect(fu1).not.toBe(fu2);
    const plan = await createAiChat('plan');
    expect(await findPlanChat()).toBe(plan);
  });
});
describe('删除与滚动摘要', () => {
  test('deleteAiChat 清消息与摘要行，返回删除数', async () => {
    const chatId = await createAiChat('chat');
    await addAiChatMessage(chatId, 'user', 'q');
    await saveChatSummary(chatId, 's', 1);
    expect(await deleteAiChat(chatId)).toBe(1);
    expect(await deleteAiChat(chatId)).toBe(0);
    expect(await getAiChat(chatId)).toBeNull();
    expect(await getChatSummary(chatId)).toBeNull();
  });
  test('saveChatSummary/getChatSummary 往返', async () => {
    const chatId = await createAiChat('chat');
    await saveChatSummary(chatId, '截至第 3 条的摘要', 3);
    expect(await getChatSummary(chatId)).toEqual({
      shape: expect.any(Number),
      up_to_message_id: 3,
      summary: '截至第 3 条的摘要',
    });
  });
  test('listPendingChatMessageRefs 供续跑扫描（chat_id/message_id/created_at）', async () => {
    const chatId = await createAiChat('chat');
    const msgId = await addAiChatMessage(chatId, 'assistant', '', 'pending');
    const refs = await listPendingChatMessageRefs();
    expect(refs).toEqual([
      { chat_id: chatId, message_id: msgId, created_at: expect.any(String) },
    ]);
  });
});
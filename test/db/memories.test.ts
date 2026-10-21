/// <reference types="node" />
/**
 * memories.test.ts — AI 记忆域真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：supersede 链、MEMORY_KEEP=100 滚动清理
 * （先删已被取代、不足再删最旧有效）、短期记忆失效过滤（14 天线）。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import { deleteMemory, listAllMemories, listMemories, saveMemory } from '@/db/memories';
import { getRawDb, resetTestDb, seedActivityRow } from '../helpers/sqlite-port';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

beforeEach(() => {
  resetTestDb();
});
describe('保存校验', () => {
  test('空内容/超长抛错；非法 category 归 general；scope 非法归 long', async () => {
    await expect(saveMemory({ content: '   ' })).rejects.toThrow();
    await expect(saveMemory({ content: 'x'.repeat(501) })).rejects.toThrow();
    const id = await saveMemory({ content: '左膝旧伤', category: 'bogus', scope: 'bogus' });
    const row = (await listAllMemories()).find((m) => m.id === id);
    expect(row?.category).toBe('general');
    expect(row?.scope).toBe('long');
  });
  test('supersedes 校验目标存在并置取代链；被取代记忆退出注入集合', async () => {
    const old = await saveMemory({ content: '旧目标：年底 200km' });
    await expect(saveMemory({ content: '新目标', supersedes_id: 9999 })).rejects.toThrow();
    const newer = await saveMemory({ content: '新目标：改期明年', supersedes_id: old });
    const all = await listAllMemories();
    const oldRow = all.find((m) => m.id === old);
    expect(oldRow?.superseded_by).toBe(newer);
    expect(oldRow?.active).toBe(false);
    expect((await listMemories()).map((m) => m.id)).toEqual([newer]);
  });
});
describe('短期记忆失效（14 天先到即失效）', () => {
  test('过期短期记忆被 listMemories 过滤、listAllMemories 灰显标注', async () => {
    const id = await saveMemory({ content: '本周右膝不适', scope: 'short' });
    // 回拨 created_at 到 20 天前（超过 14 天失效线；无新增活动，走天数分支）
    getRawDb()
      .prepare(
        `UPDATE ai_memories SET created_at = datetime('now', '-20 days') WHERE id = ?`,
      )
      .run(id);
    expect(await listMemories()).toEqual([]);
    const all = await listAllMemories();
    expect(all).toHaveLength(1);
    expect(all[0].expired).toBe(true);
    expect(all[0].active).toBe(true); // 未被取代，只是失效
  });
  test('新鲜短期记忆照常注入', async () => {
    await saveMemory({ content: '今天练完腿酸', scope: 'short' });
    expect(await listMemories()).toHaveLength(1);
  });
});
describe('MEMORY_KEEP=100 滚动清理', () => {
  test('超限先删最旧已被取代记忆；不足再删最旧有效记忆', async () => {
    // 造满 100 条（1 条已被取代 + 99 条有效，不触发清理）
    const superseded = await saveMemory({ content: '被取代的记忆' });
    for (let i = 0; i < 99; i += 1) {
      await saveMemory({ content: `有效记忆 ${i}` });
    }
    expect((await listAllMemories()).length).toBe(100);
    // 再存 1 条取代它 → 101 条，超限 1 条；先删「最旧的已被取代」即它自己
    await saveMemory({ content: '取代后的新记忆', supersedes_id: superseded });
    let all = await listAllMemories();
    expect(all).toHaveLength(100);
    expect(all.find((m) => m.id === superseded)).toBeUndefined();
    // 再存 1 条无取代 → 101 条、已无被取代可删 → 删最旧有效
    const firstValid = (await listAllMemories()).filter((m) => m.active).sort((a, b) => a.id - b.id)[0];
    await saveMemory({ content: '普通新记忆' });
    all = await listAllMemories();
    expect(all).toHaveLength(100);
    expect(all.find((m) => m.id === firstValid.id)).toBeUndefined(); // 最旧有效被删
  });
});
describe('删除与跨域依赖', () => {
  test('deleteMemory 返回删除条数', async () => {
    const id = await saveMemory({ content: '训练策略：维持有氧基底' });
    expect(await deleteMemory(id)).toBe(1);
    expect(await deleteMemory(id)).toBe(0);
  });
  test('「新增 5 次训练」分支：入库后累计 5 条更晚入库的活动即失效', async () => {
    await saveMemory({ content: '刚记的短期事实', scope: 'short' });
    // 记忆 created_at = datetime('now')；造 5 条 created_at 晚于它的活动（判定按 SQLite UTC 文本比较）
    for (let i = 0; i < 5; i += 1) {
      seedActivityRow({ created_at: '2030-01-01T00:00:00', date: '2026-10-01' });
    }
    expect(await listMemories()).toEqual([]);
    expect((await listAllMemories())[0]?.expired).toBe(true);
  });
  test('「新增 4 次训练」未到线：短期记忆照常注入', async () => {
    await saveMemory({ content: '刚记的短期事实', scope: 'short' });
    for (let i = 0; i < 4; i += 1) {
      seedActivityRow({ created_at: '2030-01-01T00:00:00', date: '2026-10-01' });
    }
    expect((await listMemories()).map((m) => m.content)).toEqual(['刚记的短期事实']);
  });
});
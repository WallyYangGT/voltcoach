/// <reference types="node" />
/**
 * memories.test.ts — AI 记忆域真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：supersede 链（含 superseded_at 落库）、MEMORY_KEEP=100
 * 滚动清理（先删已被取代、不足再删最旧有效）、短期记忆失效过滤（14 天线）、
 * 失效记忆宽限期物理清除（purgeInvalidatedMemories，判定单源 core/memory）。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import {
  deleteMemory,
  listAllMemories,
  listMemories,
  purgeInvalidatedMemories,
  saveMemory,
} from '@/db/memories';
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
    // v4：取代同时落 superseded_at（宽限期计时起点），格式为 SQLite UTC 文本
    expect(oldRow?.superseded_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
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
describe('失效记忆宽限期清除（v4：过期/被取代满 5 天物理删除）', () => {
  test('被取代 6 天后清除、宽限期内保留；重复清除幂等', async () => {
    const old = await saveMemory({ content: '旧目标' });
    await saveMemory({ content: '新目标', supersedes_id: old });
    // 刚被取代：宽限期内保留（灰标 + 倒计时）
    expect(await purgeInvalidatedMemories()).toBe(0);
    expect((await listAllMemories()).find((m) => m.id === old)?.superseded_at).toBeTruthy();
    // 回拨 superseded_at 到 6 天前 → 满宽限期，清除
    getRawDb()
      .prepare(`UPDATE ai_memories SET superseded_at = datetime('now', '-6 days') WHERE id = ?`)
      .run(old);
    expect(await purgeInvalidatedMemories()).toBe(1);
    expect((await listAllMemories()).find((m) => m.id === old)).toBeUndefined();
    // 再跑一次：无可清，幂等
    expect(await purgeInvalidatedMemories()).toBe(0);
  });
  test('短期过期按失效线起算：18 天留（宽限期内）、25 天删', async () => {
    const id = await saveMemory({ content: '本周右膝不适', scope: 'short' });
    // 回拨 18 天：失效于 4 天前（14 天线），宽限期未满 → 保留
    getRawDb()
      .prepare(`UPDATE ai_memories SET created_at = datetime('now', '-18 days') WHERE id = ?`)
      .run(id);
    expect(await purgeInvalidatedMemories()).toBe(0);
    expect(await listMemories()).toEqual([]); // 注入集合已排除（失效）
    expect((await listAllMemories())[0]?.expired).toBe(true);
    // 回拨 25 天：失效于 11 天前 → 清除
    getRawDb()
      .prepare(`UPDATE ai_memories SET created_at = datetime('now', '-25 days') WHERE id = ?`)
      .run(id);
    expect(await purgeInvalidatedMemories()).toBe(1);
    expect(await listAllMemories()).toEqual([]);
  });
  test('长期记忆未取代不清除；悬空取代指针（缺 superseded_at）保守不删', async () => {
    await saveMemory({ content: '十年前的长期偏好', scope: 'long' });
    getRawDb()
      .prepare(`UPDATE ai_memories SET created_at = datetime('now', '-3650 days')`)
      .run();
    expect(await purgeInvalidatedMemories()).toBe(0);
    expect(await listAllMemories()).toHaveLength(1);
    // 悬空：superseded_by 指向已不存在的 id 且无 superseded_at（v4 之前的历史形态）
    getRawDb().prepare(`UPDATE ai_memories SET superseded_by = 9999, superseded_at = NULL`).run();
    expect(await purgeInvalidatedMemories()).toBe(0);
    expect(await listAllMemories()).toHaveLength(1);
  });
  test('saveMemory 写入时顺带清除；清除先于 MEMORY_KEEP 条数清理', async () => {
    for (let i = 0; i < 100; i += 1) {
      await saveMemory({ content: `有效记忆 ${i}` });
    }
    // 绕过 saveMemory 直插一条已满宽限期的过期短期记忆（id 999，晚于全部有效行），
    // 使下一条 saveMemory 同时面临「1 条待清除」与「超 KEEP 上限 1 条」
    getRawDb()
      .prepare(
        `INSERT INTO ai_memories (id, content, scope, created_at)
         VALUES (999, '早已过期的短期记忆', 'short', datetime('now', '-30 days'))`,
      )
      .run();
    expect((await listAllMemories()).length).toBe(101);
    const oldestValidId = (await listAllMemories())
      .map((m) => m.id)
      .sort((a, b) => a - b)[0];
    await saveMemory({ content: '触发写入的新记忆' });
    const all = await listAllMemories();
    // purge 先删过期行（102 → 101），KEEP 裁 1 条最旧有效（→ 100）；
    // 若顺序颠倒（KEEP 先跑），会裁掉 2 条最旧有效（99 条）——条数即顺序的证词
    expect(all).toHaveLength(100);
    expect(all.find((m) => m.id === 999)).toBeUndefined();
    expect(all.find((m) => m.id === oldestValidId)).toBeUndefined();
  });
  test('MEMORY_KEEP 兜底按失效时刻淘汰被取代行，不抢删宽限期内的最新失效行', async () => {
    // 99 条有效 + 两条被取代：id 99「3 天前被取代」（宽限期内）、id 1「刚被取代」，
    // 直插绕过 saveMemory 的顺带清理/裁剪以构造「同一次写入同时面临两条被取代行」
    for (let i = 0; i < 99; i += 1) {
      await saveMemory({ content: `有效记忆 ${i}` });
    }
    getRawDb()
      .prepare(
        `UPDATE ai_memories SET superseded_by = 98, superseded_at = datetime('now', '-3 days')
         WHERE id = 99`,
      )
      .run();
    getRawDb()
      .prepare(`UPDATE ai_memories SET superseded_by = 2, superseded_at = datetime('now') WHERE id = 1`)
      .run();
    getRawDb()
      .prepare(`INSERT INTO ai_memories (id, content) VALUES (100, '补位有效行')`)
      .run();
    await saveMemory({ content: '触发条数兜底的新记忆' });
    const all = await listAllMemories();
    expect(all).toHaveLength(100);
    // 裁掉的是「被取代最早」的 id 99（3 天前），刚被取代的 id 1 保留——
    // 旧口径（按 id 排序）会删 id 1 留 id 99，与宽限期承诺相反
    expect(all.find((m) => m.id === 99)).toBeUndefined();
    expect(all.find((m) => m.id === 1)).toBeDefined();
  });
  test('listAllMemories 附 purge_in_days 倒计时：宽限期内给天数、有效条目为 null', async () => {
    const shortId = await saveMemory({ content: '近期短期事实', scope: 'short' });
    const longId = await saveMemory({ content: '长期偏好' });
    // 短期回拨 16 天：失效于 2 天前 → 宽限期剩 3 天
    getRawDb()
      .prepare(`UPDATE ai_memories SET created_at = datetime('now', '-16 days') WHERE id = ?`)
      .run(shortId);
    // 被取代行同样有倒计时（宽限期按被取代时刻起算）
    const supersededId = await saveMemory({ content: '旧目标' });
    await saveMemory({ content: '新目标', supersedes_id: supersededId });
    const all = await listAllMemories();
    expect(all.find((m) => m.id === shortId)?.purge_in_days).toBe(3);
    expect(all.find((m) => m.id === longId)?.purge_in_days).toBeNull();
    const supersededRow = all.find((m) => m.id === supersededId);
    expect(supersededRow?.purge_in_days).toBeGreaterThanOrEqual(1);
    expect(supersededRow?.purge_in_days).toBeLessThanOrEqual(5);
    expect(all.find((m) => m.content === '新目标')?.purge_in_days).toBeNull();
  });
});
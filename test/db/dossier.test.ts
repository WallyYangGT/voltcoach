/**
 * dossier.test.ts — 训练档案缓存域真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：settings 缓存行读写、指纹（活动总数 + FTP）命中判定、
 * miss 自愈重建、rebuildDossierQuietly 的并发合并（rolling 中再触发只在链尾补一次）。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import { getDossier, rebuildDossierQuietly } from '@/db/dossier';
import { setAthlete } from '@/db/athlete';
import { insertActivity } from '@/db/activities';
import { getRawDb, makeSummary, resetTestDb } from '../helpers/sqlite-port';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

beforeEach(() => {
  resetTestDb();
});
describe('getDossier', () => {
  test('无骑行数据返回 null（提示词侧整段省略口径）', async () => {
    expect(await getDossier()).toBeNull();
  });
  test('聚合后写缓存行，二次读取命中缓存（指纹一致）', async () => {
    await insertActivity({ fileName: 'a.fit', fingerprint: 'fp1', summary: makeSummary({ date: '2026-10-01' }) });
    await insertActivity({ fileName: 'b.fit', fingerprint: 'fp2', summary: makeSummary({ date: '2026-10-05' }) });
    const first = await getDossier();
    expect(first).not.toBeNull();
    const cached = getRawDb()
      .prepare(`SELECT value FROM settings WHERE key = 'dossier'`)
      .get() as { value: string };
    expect(JSON.parse(cached.value).fingerprint).toEqual({ rides: 2, ftp: expect.any(Number) });
    // 缓存行改坏结果字段也能暴露「未走重建」：命中时返回值与缓存行一致
    const second = await getDossier();
    expect(second).toEqual(first);
  });
  test('活动总数变化 → 指纹 miss → 自愈重建', async () => {
    await insertActivity({ fileName: 'a.fit', fingerprint: 'fp1', summary: makeSummary() });
    const before = await getDossier();
    await insertActivity({ fileName: 'b.fit', fingerprint: 'fp2', summary: makeSummary({ date: '2026-10-02' }) });
    // 不调 rebuildDossierQuietly，直接读：指纹兜底自愈
    const after = await getDossier();
    expect(after).not.toEqual(before);
  });
  test('FTP 变化 → 指纹 miss → 重建；缓存行损坏按 miss 处理', async () => {
    await insertActivity({ fileName: 'a.fit', fingerprint: 'fp1', summary: makeSummary() });
    await getDossier();
    await setAthlete({ ftp_watts: 260 }); // FTP 变更（档案指纹的 ftp 分量）
    const rebuilt = await getDossier();
    expect(rebuilt).not.toBeNull();
    getRawDb()
      .prepare(`UPDATE settings SET value = '{broken' WHERE key = 'dossier'`)
      .run();
    expect(await getDossier()).not.toBeNull(); // 损坏走重建，不抛错
  });
});
describe('rebuildDossierQuietly', () => {
  test('fire-and-forget 重建后缓存行就位；失败不影响调用方（不抛出）', async () => {
    await insertActivity({ fileName: 'a.fit', fingerprint: 'fp1', summary: makeSummary() });
    await expect(rebuildDossierQuietly()).resolves.toBeUndefined();
    const cached = getRawDb()
      .prepare(`SELECT value FROM settings WHERE key = 'dossier'`)
      .get() as { value: string } | undefined;
    expect(cached).toBeDefined();
    expect(await getDossier()).not.toBeNull();
  });
  test('滚动中再触发只在链尾多补一次（并发合并口径）', async () => {
    await insertActivity({ fileName: 'a.fit', fingerprint: 'fp1', summary: makeSummary() });
    // 连发多次：rolling 标志把后续触发折叠成 rerollPending，最终只做 ≤2 轮
    await Promise.all([
      rebuildDossierQuietly(),
      rebuildDossierQuietly(),
      rebuildDossierQuietly(),
    ]);
    const row = getRawDb()
      .prepare(`SELECT value FROM settings WHERE key = 'dossier'`)
      .get() as { value: string };
    expect(JSON.parse(row.value).fingerprint.rides).toBe(1);
  });
});
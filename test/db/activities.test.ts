/// <reference types="node" />
/**
 * activities.test.ts — 训练记录域真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：uuid 身份与 file_name 回退、updateActivitySummary 的
 * COALESCE 指纹口径、删除时指纹覆盖引用（v3 重挂前提）、孤儿重挂、合并重复事务、
 * 统计查询（form/月度/FTP 估算取数）。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import {
  computeForm,
  countActivities,
  cyclingSummariesSince,
  deleteActivity,
  getActivityFileName,
  getActivityPowerFlag,
  getActivitySummary,
  insertActivity,
  isActivityUuid,
  listActivities,
  listActivitiesInRange,
  listActivityFileNames,
  listActivityRideKeys,
  listActivityUuids,
  mergeActivityRows,
  monthlySummary,
  newActivityUuid,
  recentFormDaily,
  reattachOrphanRefs,
  resolveActivityUuid,
  setActivityCategory,
  setActivityNote,
  setActivityPowerFlag,
  updateActivitySummary,
} from '@/db/activities';
import { getRawDb, makeSummary, resetTestDb, seedActivityRow } from '../helpers/sqlite-port';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

beforeEach(() => {
  resetTestDb();
});
describe('身份与插入', () => {
  test('newActivityUuid / insertActivity 生成 32 位小写 hex 身份', async () => {
    expect(isActivityUuid(newActivityUuid())).toBe(true);
    const uuid = await insertActivity({
      fileName: 'a.fit',
      fingerprint: 'fp-1',
      summary: makeSummary(),
    });
    expect(isActivityUuid(uuid)).toBe(true);
    expect(await countActivities()).toBe(1);
    expect(await getActivityFileName(uuid)).toBe('a.fit');
  });
  test('getActivitySummary 合并 category 与 note 进 activity；损坏 JSON 返回 null', async () => {
    const uuid = seedActivityRow({ category: 'race', note: '集团冲刺' });
    const summary = await getActivitySummary(uuid);
    expect(summary?.activity.category).toBe('race');
    expect(summary?.activity.note).toBe('集团冲刺');
    getRawDb().prepare(`UPDATE activities SET summary_json = '{broken' WHERE uuid = ?`).run(uuid);
    expect(await getActivitySummary(uuid)).toBeNull();
  });
  test('resolveActivityUuid：uuid 直查 / file_name 回退（v2 旧链接）/ 不存在 null', async () => {
    const uuid = seedActivityRow({ file_name: 'legacy.fit' });
    expect(await resolveActivityUuid(uuid)).toBe(uuid);
    expect(await resolveActivityUuid('legacy.fit')).toBe(uuid);
    expect(await resolveActivityUuid('nope')).toBeNull();
  });
});
describe('updateActivitySummary', () => {
  test('更新分析结果并保留分类/备注；指纹仅显式提供时更新', async () => {
    const uuid = seedActivityRow({ category: 'race', note: '备注', fingerprint: 'fp-old' });
    await updateActivitySummary(uuid, makeSummary({ tss: 99 }));
    const row = getRawDb()
      .prepare(`SELECT tss, category, note, fingerprint FROM activities WHERE uuid = ?`)
      .get(uuid) as { tss: number; category: string; note: string; fingerprint: string };
    expect(row.tss).toBe(99);
    expect(row.category).toBe('race');
    expect(row.note).toBe('备注');
    expect(row.fingerprint).toBe('fp-old'); // 重算不改骑行身份
    await updateActivitySummary(uuid, makeSummary(), { fingerprint: 'fp-new' });
    expect(
      (getRawDb().prepare(`SELECT fingerprint FROM activities WHERE uuid = ?`).get(uuid) as { fingerprint: string })
        .fingerprint,
    ).toBe('fp-new');
  });
  test('活动不存在抛 not_found', async () => {
    await expect(updateActivitySummary(newActivityUuid(), makeSummary())).rejects.toThrow();
  });
});
describe('清单与统计', () => {
  test('listActivities 按日期倒序 + 数值取整口径（tss/np/avg_power 取整、IF 保 2 位）', async () => {
    seedActivityRow({ date: '2026-10-01', tss: 60.4, intensity_factor: 0.85 });
    seedActivityRow({ date: '2026-10-05', tss: 120.6, intensity_factor: 0.66 });
    const rows = await listActivities();
    expect(rows.map((r) => r.date)).toEqual(['2026-10-05', '2026-10-01']);
    expect(rows[0].tss).toBe(121);
    expect(rows[0].intensity_factor).toBe(0.66); // 阈值判定依赖 2 位精度
    expect(rows[1].tss).toBe(60);
  });
  test('listActivitiesInRange 闭区间过滤（计划执行视图）', async () => {
    seedActivityRow({ date: '2026-09-30' });
    seedActivityRow({ date: '2026-10-02' });
    seedActivityRow({ date: '2026-10-08' });
    const rows = await listActivitiesInRange('2026-10-01', '2026-10-07');
    expect(rows.map((r) => r.date)).toEqual(['2026-10-02']);
  });
  test('computeForm/monthlySummary/cyclingSummariesSince：空库安全回落，有数据正常聚合', async () => {
    expect(await computeForm('2026-10-01')).toBeNull();
    expect(await monthlySummary(6)).toEqual([]);
    expect(await cyclingSummariesSince(42)).toEqual([]);
    expect(await recentFormDaily(7)).toEqual([]);
    seedActivityRow({ date: '2026-10-01', tss: 100 });
    seedActivityRow({ date: '2026-10-02', tss: 50, sport: 'cycling' });
    seedActivityRow({ date: '2026-10-03', tss: 30, sport: 'running' }); // 非骑行不进 FTP 估算
    const form = await computeForm('2026-10-02');
    expect(form).not.toBeNull();
    expect(await cyclingSummariesSince(42)).toHaveLength(2);
    const monthly = await monthlySummary(6);
    expect(monthly.length).toBeGreaterThan(0);
  });
});
describe('分类/备注/功率标记', () => {
  test('非法分类与超长备注抛错；空备注清除为 null；功率标记往返', async () => {
    const uuid = seedActivityRow();
    await expect(setActivityCategory(uuid, 'bogus')).rejects.toThrow();
    await expect(setActivityNote(uuid, 'x'.repeat(2001))).rejects.toThrow();
    await setActivityNote(uuid, '   '); // 空白清除
    expect(
      (getRawDb().prepare(`SELECT note FROM activities WHERE uuid = ?`).get(uuid) as { note: string | null }).note,
    ).toBeNull();
    await setActivityPowerFlag(uuid, true);
    expect(await getActivityPowerFlag(uuid)).toBe(true);
    await setActivityPowerFlag(uuid, false);
    expect(await getActivityPowerFlag(uuid)).toBe(false);
  });
});
describe('删除 / 重挂 / 合并（v3 指纹闭环）', () => {
  test('删除前把指纹覆盖到报告/对话引用上，行随之消失', async () => {
    const uuid = seedActivityRow({ fingerprint: 'fp-del' });
    const raw = getRawDb();
    raw
      .prepare(
        `INSERT INTO ai_reports (mode, activity_uuid, activity_fingerprint, prompt, markdown)
         VALUES ('review', ?, NULL, 'p', 'm')`,
      )
      .run(uuid);
    raw
      .prepare(
        `INSERT INTO ai_chats (mode, activity_uuid, activity_fingerprint, title)
         VALUES ('follow_up', ?, NULL, 't')`,
      )
      .run(uuid);
    expect(await deleteActivity(uuid)).toBe(1);
    expect(await countActivities()).toBe(0);
    const report = raw
      .prepare(`SELECT activity_uuid, activity_fingerprint FROM ai_reports`)
      .get() as { activity_uuid: string | null; activity_fingerprint: string | null };
    expect(report.activity_uuid).toBeNull(); // 外键 SET NULL
    expect(report.activity_fingerprint).toBe('fp-del'); // 指纹留下供重挂
    const chat = raw
      .prepare(`SELECT activity_uuid, activity_fingerprint FROM ai_chats`)
      .get() as { activity_uuid: string | null; activity_fingerprint: string | null };
    expect(chat.activity_fingerprint).toBe('fp-del');
  });
  test('删除不存在的活动返回 0', async () => {
    expect(await deleteActivity(newActivityUuid())).toBe(0);
  });
  test('reattachOrphanRefs 按精确指纹把孤儿引用挂回新活动', async () => {
    const newUuid = seedActivityRow({ fingerprint: 'fp-re' });
    const raw = getRawDb();
    raw
      .prepare(
        `INSERT INTO ai_reports (mode, activity_uuid, activity_fingerprint, prompt, markdown)
         VALUES ('review', NULL, 'fp-re', 'p', 'm')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO ai_reports (mode, compare_uuid, compare_fingerprint, prompt, markdown)
         VALUES ('compare', NULL, 'fp-re', 'p', 'm')`,
      )
      .run();
    const moved = await reattachOrphanRefs('fp-re', newUuid);
    expect(moved).toBe(2);
    const refs = raw.prepare(`SELECT activity_uuid, compare_uuid FROM ai_reports`).all() as {
      activity_uuid: string | null;
      compare_uuid: string | null;
    }[];
    expect(refs.map((r) => r.activity_uuid ?? r.compare_uuid)).toEqual([newUuid, newUuid]);
    expect(await reattachOrphanRefs('', newUuid)).toBe(0); // 空指纹保守不挂
  });
  test('mergeActivityRows：extras 接管 → 引用重挂 → 删副本，一个事务', async () => {
    const keep = seedActivityRow({ category: 'training', note: null, power_flagged: 0, fingerprint: 'fp-keep' });
    const drop = seedActivityRow({ category: 'race', note: '副本备注', power_flagged: 1, fingerprint: 'fp-drop' });
    const raw = getRawDb();
    raw
      .prepare(
        `INSERT INTO ai_reports (mode, activity_uuid, activity_fingerprint, prompt, markdown)
         VALUES ('review', ?, NULL, 'p', 'm')`,
      )
      .run(drop);
    const moved = await mergeActivityRows(keep, drop);
    expect(moved).toBe(1);
    expect(await countActivities()).toBe(1);
    const keptRow = raw
      .prepare(`SELECT category, note, power_flagged FROM activities WHERE uuid = ?`)
      .get(keep) as { category: string; note: string; power_flagged: number };
    expect(keptRow).toEqual({ category: 'race', note: '副本备注', power_flagged: 1 });
    const report = raw
      .prepare(`SELECT activity_uuid, activity_fingerprint FROM ai_reports`)
      .get() as { activity_uuid: string; activity_fingerprint: string };
    expect(report.activity_uuid).toBe(keep);
    expect(report.activity_fingerprint).toBe('fp-keep'); // 指纹同步为保留项的
    expect(await mergeActivityRows(keep, newActivityUuid())).toBe(0); // 副本不存在 no-op
  });
});
describe('辅助查询', () => {
  test('listActivityRideKeys / FileNames / Uuids（查重、同步与备份共用）', async () => {
    const a = seedActivityRow({ file_name: 'x.fit', category: null, note: 'n' });
    seedActivityRow({ file_name: 'y.fit' });
    const keys = await listActivityRideKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0].uuid).toBe(a); // 按 id 升序 = 入库先后
    expect(keys[0].category).toBe('training'); // NULL 归一化
    expect(await listActivityFileNames()).toEqual(['x.fit', 'y.fit']);
    expect(await listActivityUuids()).toHaveLength(2);
  });
});
/**
 * db-invalidation-wiring.test.ts — 「db 写 → 事件 → aiTitle 缓存失效」闭环
 *
 * 架构评审 A3 的核心断言：标题/起骑时刻缓存的失效不再靠 7 处散点手工调用
 * （漏一处就停旧值），而是由 db 写函数的 events 驱动。这里用真 SQL 假库跑真实的
 * db 写函数，断言 aiTitle 的进程内缓存确实被清、且下一次装配会重新读库。
 *
 * 覆盖三类写入形态：
 *  - 行级（updateActivitySummary / setActivityCategory）：payload 带 uuid；
 *  - 跨表事务（deleteActivity / mergeActivityRows）：事务提交后发；
 *  - 域级（reanalyze 之外的备份整库替换走 invalidateAllDb，见 db-notify.test.mjs）。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from './helpers/sqlite-port';
import { buildReportTitle, getRideStartAt, invalidateReportTitles } from '@/services/aiTitle';
import { deleteActivity, mergeActivityRows, setActivityCategory, updateActivitySummary } from '@/db/activities';
import { makeSummary, resetTestDb, seedActivityRow } from './helpers/sqlite-port';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));
// records 首帧：本测试只关心「缓存被清后是否重新读」，用可控桩标记读取次数
const mockStartReads: string[] = [];
jest.mock('@/records-store', () => ({
  readStoredRecordStart: async (uuid: string) => {
    mockStartReads.push(uuid);
    return '2026-10-01T06:00:00.000Z';
  },
  // aiTitle 之外的其他导入（records-store 的导出面在 barrel 里被用到一部分）
  ensureRecordFileLayout: async () => {},
}));

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetTestDb();
  // 只清 aiTitle 的进程内缓存（跨测试不串味）。**不能**用 resetDbInvalidationForTesting：
  // 那个会把 aiTitle 的模块级订阅一起清掉，本文件就测不到事件闭环了
  invalidateReportTitles();
  mockStartReads.length = 0;
});

describe('事件驱动的标题缓存失效', () => {
  test('行级写（updateActivitySummary）带 uuid 事件 → 该活动首帧缓存被清、重新读盘', async () => {
    const uuid = seedActivityRow({ fingerprint: 'fp-w' });
    expect(await getRideStartAt(uuid)).toBe('2026-10-01T06:00:00.000Z');
    expect(await getRideStartAt(uuid)).toBe('2026-10-01T06:00:00.000Z');
    expect(mockStartReads).toEqual([uuid]); // 第二次命中缓存，不读盘

    await updateActivitySummary(uuid, makeSummary()); // db 写 → 发 activities 事件
    await flushMicrotasks(); // 微任务合并冲刷

    expect(await getRideStartAt(uuid)).toBe('2026-10-01T06:00:00.000Z');
    expect(mockStartReads).toEqual([uuid, uuid]); // 缓存已失效 → 重新读
  });

  test('分类变更（非逐秒数据）同样触发域事件 → 标题缓存全清', async () => {
    const uuid = seedActivityRow();
    const t = ((key: string) => key) as never;
    const before = await buildReportTitle(
      { id: 1, mode: 'review', activity_uuid: uuid, race_date: null, compare_uuid: null, created_at: '2026-10-01T00:00:00Z' },
      'zh',
      t,
    );
    await setActivityCategory(uuid, 'race');
    await flushMicrotasks();
    const after = await buildReportTitle(
      { id: 1, mode: 'review', activity_uuid: uuid, race_date: null, compare_uuid: null, created_at: '2026-10-01T00:00:00Z' },
      'zh',
      t,
    );
    // 标题文本可能相同（分类不进标题），断言的是「重新装配过」——读盘次数证明缓存被清
    expect(after).toBe(before);
    expect(mockStartReads.filter((u) => u === uuid).length).toBeGreaterThanOrEqual(2);
  });

  test('跨表事务：deleteActivity 提交后发事件（列表/标题同步失效）', async () => {
    const uuid = seedActivityRow();
    await getRideStartAt(uuid);
    expect(mockStartReads).toEqual([uuid]);

    expect(await deleteActivity(uuid)).toBe(1);
    await flushMicrotasks();

    // 行已删：缓存若未被清会继续返回旧首帧；清掉后重新读（桩恒返回同一时刻）
    expect(await getRideStartAt(uuid)).toBe('2026-10-01T06:00:00.000Z');
    expect(mockStartReads).toEqual([uuid, uuid]);
  });

  test('mergeActivityRows 同时带保留项与副本 uuid（两者缓存都清）', async () => {
    const keep = seedActivityRow({ fingerprint: 'fp-k', file_name: 'k.fit' });
    const drop = seedActivityRow({ fingerprint: 'fp-d', file_name: 'd.fit' });
    await getRideStartAt(keep);
    await getRideStartAt(drop);
    mockStartReads.length = 0;

    await mergeActivityRows(keep, drop);
    await flushMicrotasks();

    await getRideStartAt(keep);
    await getRideStartAt(drop);
    expect(mockStartReads.sort()).toEqual([drop, keep].sort());
  });

  test('无写入时缓存长期有效（事件不误发）', async () => {
    const uuid = seedActivityRow();
    await getRideStartAt(uuid);
    await flushMicrotasks();
    await getRideStartAt(uuid);
    expect(mockStartReads).toEqual([uuid]);
  });
});

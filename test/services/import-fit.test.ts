/**
 * import-fit.test.ts — FIT 导入编排（services 层可测化，A7/T3）
 *
 * 钉导入管线的编排决策（纯函数/真 SQL 都测不到的这一层）：
 *  - decideImport 三条决策各自接到正确的 db 动作（insert / update / skip 不入库）；
 *  - 查重发生在入库之前——skip 时**不落 records、不滚快照**（避免孤儿文件）；
 *  - 每条成功路径都挂上「快照滚动 + activities 失效事件 + 档案重建」三个触发点；
 *  - form 注入后写回最终版 summary（两次 update 的口径）；
 *  - 文件名/空字节等入参校验在解析前拒绝。
 *
 * mock 边界：'@/db'（数据访问注入点）、'@/core/analyze'（解析器桩）、
 * '@/records-store'、'@/backup/export'（快照）、'@/db/notify'（事件）、
 * './dedupe'（起骑时刻补齐——设备侧读盘，另由 dedupe 核心测试覆盖）。
 */
import { importFitBytes } from '@/services/importFit';

const mockInvalidateDb = jest.fn();
const mockSaveRecords = jest.fn();
const mockRollSnapshot = jest.fn(async () => {});
const mockAnalyze = jest.fn();

jest.mock('expo-file-system', () => ({ File: class {} }));
jest.mock('@/db/notify', () => ({ invalidateDb: (...a: unknown[]) => mockInvalidateDb(...a) }));
jest.mock('@/backup/export', () => ({
  rollLocalSnapshotQuietly: () => mockRollSnapshot(),
}));
jest.mock('@/records-store', () => ({ saveRecords: (...a: unknown[]) => mockSaveRecords(...a) }));
jest.mock('@/core/analyze', () => ({ analyzeFile: (...a: unknown[]) => mockAnalyze(...a) }));
jest.mock('@/services/dedupe', () => ({
  enrichRideKeysForDedupe: async (rows: unknown) => rows,
}));
jest.mock('@/db', () => ({
  getEffectiveAthlete: jest.fn(),
  insertActivity: jest.fn(),
  updateActivitySummary: jest.fn(),
  listActivityRideKeys: jest.fn(),
  reattachOrphanRefs: jest.fn(),
  rebuildDossierQuietly: jest.fn(async () => {}),
  computeForm: jest.fn(),
}));

type DbMock = {
  getEffectiveAthlete: jest.Mock;
  insertActivity: jest.Mock;
  updateActivitySummary: jest.Mock;
  listActivityRideKeys: jest.Mock;
  reattachOrphanRefs: jest.Mock;
  rebuildDossierQuietly: jest.Mock;
  computeForm: jest.Mock;
};
const dbMock = (): DbMock => jest.requireMock('@/db') as DbMock;

const UUID = 'b'.repeat(32);

const makeSummary = (overrides: Record<string, unknown> = {}) => ({
  activity: {
    date: '2026-10-20',
    sport: 'cycling',
    duration_sec: 3600,
    distance_km: 40,
    elevation_gain_m: 100,
    elevation_gain_source: 'device',
    ...overrides,
  },
  athlete_context: { ftp_watts: 250 },
  power: { tss: 60, intensity_factor: 0.8 },
});
const makeRecords = () => [{ timestamp: '2026-10-20T06:00:00Z', power: 200 }];

/** 已有骑行行（fingerprint/文件名可覆盖，用于驱动 decideImport 的三条分支） */
const rideRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  uuid: UUID,
  file_name: 'ride.fit',
  fingerprint: '2026-10-20|3600|40000',
  date: '2026-10-20',
  sport: 'cycling',
  duration_sec: 3600,
  distance_km: 40,
  category: 'training',
  note: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  dbMock().getEffectiveAthlete.mockResolvedValue({ ftp_watts: 250, max_hr: 190, weight_kg: 70 });
  mockAnalyze.mockResolvedValue({ records: makeRecords(), summary: makeSummary() });
  dbMock().listActivityRideKeys.mockResolvedValue([]);
  dbMock().insertActivity.mockResolvedValue(UUID);
  dbMock().updateActivitySummary.mockResolvedValue(undefined);
  dbMock().reattachOrphanRefs.mockResolvedValue(0);
  dbMock().computeForm.mockResolvedValue(null);
  mockSaveRecords.mockResolvedValue(undefined);
});

describe('入参校验（解析前拒绝）', () => {
  test.each([
    ['非法文件名', '', new Uint8Array([1])],
    ['不是 .fit', 'ride.txt', new Uint8Array([1])],
    ['空字节', 'ride.fit', new Uint8Array()],
  ])('%s 直接抛错且不解析', async (_label, name, bytes) => {
    await expect(importFitBytes(bytes as Uint8Array, name as string)).rejects.toThrow();
    expect(mockAnalyze).not.toHaveBeenCalled();
  });
});

describe('查重决策接线', () => {
  test('无同趟骑行 → insert（新 uuid 入库）', async () => {
    const res = await importFitBytes(new Uint8Array([1, 2]), 'ride.fit');
    expect(res.created).toBe(true);
    expect(res.uuid).toBe(UUID);
    expect(dbMock().insertActivity).toHaveBeenCalledTimes(1);
    expect(dbMock().updateActivitySummary).not.toHaveBeenCalled();
    expect(mockSaveRecords).toHaveBeenCalledWith(UUID, makeRecords());
  });

  test('指纹精确一致 → update（不新建行）', async () => {
    dbMock().listActivityRideKeys.mockResolvedValue([rideRow()]);
    const res = await importFitBytes(new Uint8Array([1, 2]), 'ride.fit');
    expect(res.created).toBe(false);
    expect(dbMock().insertActivity).not.toHaveBeenCalled();
    expect(dbMock().updateActivitySummary).toHaveBeenCalledWith(UUID, expect.any(Object), {
      fingerprint: expect.any(String),
    });
  });

  test('异名同趟 → skip：不入库、不落 records、不滚快照', async () => {
    // 指纹不同（否则先命中「精确一致 → update」），但同日同时长同距离 → isSameRide
    dbMock().listActivityRideKeys.mockResolvedValue([
      rideRow({ uuid: 'c'.repeat(32), file_name: 'other.fit', fingerprint: 'legacy-fp' }),
    ]);
    const res = await importFitBytes(new Uint8Array([1, 2]), 'ride.fit');
    expect(res.duplicateOfUuid).toBe('c'.repeat(32));
    expect(dbMock().insertActivity).not.toHaveBeenCalled();
    expect(dbMock().updateActivitySummary).not.toHaveBeenCalled();
    expect(mockSaveRecords).not.toHaveBeenCalled();
    expect(mockRollSnapshot).not.toHaveBeenCalled();
    expect(dbMock().rebuildDossierQuietly).not.toHaveBeenCalled();
    // 但仍尝试按指纹重挂孤儿引用（删后重导入场景）
    expect(dbMock().reattachOrphanRefs).toHaveBeenCalled();
  });
});

describe('成功路径的触发点', () => {
  test('快照滚动 + activities 失效 + 档案重建三者都挂上（且事件在 records 之后）', async () => {
    await importFitBytes(new Uint8Array([1, 2]), 'ride.fit');
    expect(mockRollSnapshot).toHaveBeenCalledTimes(1);
    expect(dbMock().rebuildDossierQuietly).toHaveBeenCalledTimes(1);
    expect(mockInvalidateDb).toHaveBeenCalledWith('activities', UUID);
    // records 落盘先于补充失效（标题起骑时刻读 records 首帧）
    const saveOrder = mockSaveRecords.mock.invocationCallOrder[0];
    const invalidateOrder = mockInvalidateDb.mock.invocationCallOrder.at(-1)!;
    expect(saveOrder).toBeLessThan(invalidateOrder);
  });

  test('form 可用时注入后写回最终版 summary（同 uuid 二次 update）', async () => {
    dbMock().computeForm.mockResolvedValue({ ctl: 42, atl: 40, tsb: 2 });
    dbMock().listActivityRideKeys.mockResolvedValue([rideRow()]); // update 路径
    await importFitBytes(new Uint8Array([1, 2]), 'ride.fit');
    const calls = dbMock().updateActivitySummary.mock.calls;
    expect(calls).toHaveLength(2); // 首次摘要 + 注入 form 后的最终版
    expect(calls[1][1].athlete_context).toMatchObject({ ctl: 42 });
  });

  test('records 落盘失败不影响入库结果（只告警）', async () => {
    mockSaveRecords.mockRejectedValue(new Error('磁盘满'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await importFitBytes(new Uint8Array([1, 2]), 'ride.fit');
    expect(res.uuid).toBe(UUID);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('来源元数据默认 import，cloud 同步可覆盖', async () => {
    await importFitBytes(new Uint8Array([1, 2]), 'ride.fit');
    expect(dbMock().insertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'import' }),
    );
    await importFitBytes(new Uint8Array([1, 2]), 'cloud.fit', { source: 'onelap' });
    expect(dbMock().insertActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'onelap' }),
    );
  });
});

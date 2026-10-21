/**
 * power-calib.test.ts — 功率标记/校准编排（services 层可测化，A7/T3）
 *
 * 钉两条编排口径（这两条都是「纯函数测不到」的夹缝）：
 *  - 标记：写标记必须**先于**档案重建，且重建是 await（返回时档案已对齐）；
 *  - 校准：系数夹逼到 POWER_CALIBRATION 界限、缺活动/缺功率/缺逐秒数据各自抛
 *    双语错误（工具层兜成 {error}，不能静默成功）、写回后滚快照 + 重建档案。
 */
import { recalibrateActivityPower, setPowerFlagAndRefresh } from '@/services/power-calib';

const mockRollSnapshot = jest.fn(async () => {});
const mockLoadRecords = jest.fn();

jest.mock('@/backup/export', () => ({
  rollLocalSnapshotQuietly: () => mockRollSnapshot(),
}));
jest.mock('@/records-store', () => ({
  loadStoredRecords: (...a: unknown[]) => mockLoadRecords(...a),
}));
jest.mock('@/db', () => ({
  setActivityPowerFlag: jest.fn(),
  getActivityFileName: jest.fn(),
  getActivitySummary: jest.fn(),
  getEffectiveAthlete: jest.fn(),
  rebuildDossierQuietly: jest.fn(),
  computeForm: jest.fn(async () => null),
  updateActivitySummary: jest.fn(),
}));
// 重算核心用桩：这里只验编排（写回字段裁剪、夹逼、触发点）；重算口径由 core 测试覆盖
jest.mock('@/core/reanalyze', () => ({
  rebuildSummaryFromRecords: jest.fn(() => ({
    activity: { date: '2026-10-20', sport: 'cycling', duration_sec: 3600, note: '旧备注', category: 'race' },
    athlete_context: {},
    power: { avg: 220, normalized_power: 240, intensity_factor: 0.85, tss: 70 },
  })),
  diffSummaries: jest.fn(() => ({ 'power.avg': [200, 220] })),
}));

type DbMock = {
  setActivityPowerFlag: jest.Mock;
  getActivityFileName: jest.Mock;
  getActivitySummary: jest.Mock;
  getEffectiveAthlete: jest.Mock;
  rebuildDossierQuietly: jest.Mock;
  updateActivitySummary: jest.Mock;
};
const dbMock = (): DbMock => jest.requireMock('@/db') as DbMock;

const UUID = 'd'.repeat(32);

beforeEach(() => {
  jest.clearAllMocks();
  dbMock().setActivityPowerFlag.mockResolvedValue(undefined);
  dbMock().getActivityFileName.mockResolvedValue('ride.fit');
  dbMock().getActivitySummary.mockResolvedValue({ activity: {}, power: { avg: 200 } });
  dbMock().getEffectiveAthlete.mockResolvedValue({ ftp_watts: 250 });
  dbMock().rebuildDossierQuietly.mockResolvedValue(undefined);
  dbMock().updateActivitySummary.mockResolvedValue(undefined);
  mockLoadRecords.mockResolvedValue([{ timestamp: '2026-10-20T06:00:00Z', power: 200 }]);
});

describe('setPowerFlagAndRefresh', () => {
  test('先写标记、再 await 档案重建（返回时档案已对齐）', async () => {
    const out = await setPowerFlagAndRefresh(UUID, true, 'zh', '功率计漂移');
    expect(out).toMatchObject({
      ok: true,
      uuid: UUID,
      file_name: 'ride.fit',
      flagged: true,
      reason: '功率计漂移',
      dossier_updated: true,
    });
    const flagOrder = dbMock().setActivityPowerFlag.mock.invocationCallOrder[0];
    const rebuildOrder = dbMock().rebuildDossierQuietly.mock.invocationCallOrder[0];
    expect(flagOrder).toBeLessThan(rebuildOrder); // 先标记后重建（否则重建读到旧标记）
  });

  test('标记失败时不做档案重建（错误上抛给工具层）', async () => {
    dbMock().setActivityPowerFlag.mockRejectedValue(new Error('activity.not_found'));
    await expect(setPowerFlagAndRefresh(UUID, true)).rejects.toThrow();
    expect(dbMock().rebuildDossierQuietly).not.toHaveBeenCalled();
  });
});

describe('recalibrateActivityPower', () => {
  test('系数被夹逼到界限内，返回请求值与生效值', async () => {
    const out = await recalibrateActivityPower(UUID, 5, 'zh');
    expect(out.scale_requested).toBe(5);
    expect(out.scale_applied).toBeLessThan(5); // 夹逼到 max_scale
    expect(out.changes).toBeDefined();
    expect(mockRollSnapshot).toHaveBeenCalledTimes(1);
    expect(dbMock().rebuildDossierQuietly).toHaveBeenCalledTimes(1);
  });

  test('不落 summary 的 category/note 列属数据（防空备注复活）', async () => {
    await recalibrateActivityPower(UUID, 1.1, 'zh');
    const written = dbMock().updateActivitySummary.mock.calls[0][1];
    expect(written.activity.category).toBeUndefined();
    expect(written.activity.note).toBeUndefined();
  });

  test.each([
    ['活动不存在', null, null],
    ['无功率数据', { activity: {} }, null],
    ['缺逐秒数据', { activity: {}, power: { avg: 200 } }, 'no-records'],
  ])('%s 抛错且不写库', async (_label, summary, records) => {
    dbMock().getActivitySummary.mockResolvedValue(summary);
    mockLoadRecords.mockResolvedValue(records === 'no-records' ? null : records);
    await expect(recalibrateActivityPower(UUID, 1, 'zh')).rejects.toThrow();
    expect(dbMock().updateActivitySummary).not.toHaveBeenCalled();
    expect(dbMock().rebuildDossierQuietly).not.toHaveBeenCalled();
  });
});

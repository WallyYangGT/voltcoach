/**
 * ftp-apply.test.ts — L4 服务层测试（jest）：AI FTP 更新的快照装配与撤销恢复。
 *
 * 钉住 code-review P1 的回归点与 P2-4 的空白：
 *  - 自选值经夹逼后写入、快照记录 requested_w/区间（披露条据此区分自选与均值）；
 *  - 快照保存 AI 更新前的溯源戳，撤销时一并恢复——撤销回默认 106W 不得被重新
 *    盖戳（否则 isFtpCalibrated 误判为已校准，健康瓦片重新采信默认值算出的 IF）；
 *  - 旧快照（无 old_ftp_* 字段）按「无戳」恢复（保守判未校准）；
 *  - 撤销的 stale 守卫（当前 FTP 已被后续修改）不写库。
 *
 * mock 边界：仅 '@/db'（编排层的数据访问注入点；freshest 估算输入用固定骑行夹具）。
 */
import {
  applyAiFtpUpdate,
  undoAiFtpUpdate,
  type AiFtpUpdateOptions,
} from '@/services/ftp-apply';
import {
  cyclingSummariesSince,
  getAthleteState,
  getAiFtpUpdate,
  getFtpMeta,
  rebuildDossierQuietly,
  setAiFtpUpdate,
  setAthlete,
} from '@/db';

jest.mock('@/db', () => ({
  cyclingSummariesSince: jest.fn(),
  getAthleteState: jest.fn(),
  getFtpMeta: jest.fn(),
  setAthlete: jest.fn(),
  setAiFtpUpdate: jest.fn(),
  getAiFtpUpdate: jest.fn(),
  rebuildDossierQuietly: jest.fn(),
}));

/** 今天/前 N 天的 UTC 日历日（估算器与新鲜度门槛都按 UTC 日差） */
const dayAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** 一次可用骑行（有功率覆盖、心率达到全力阈值：round(195×0.9)=176） */
const ride = (date: string) => ({
  uuid: date.replace(/-/g, '').padEnd(32, 'a').slice(0, 32),
  file_name: `${date}.fit`,
  date,
  duration_sec: 3600,
  summary: {
    power: { peak_curve: { '5min': 150, '20min': 130 }, zone_distribution_pct: { Z5: 5 } },
    heart_rate: { max: 180, zone_distribution_pct: { Z4: 5 }, hr_drift_pct: 2 },
    data_quality: { power_coverage_pct: 100, hr_coverage_pct: 100 },
  },
});

/** 三趟新鲜骑行 → 两法 123/124、均值 124、区间 [123,124]（与 unit.test.mjs 同口径） */
const rides = () => [ride(dayAgo(4)), ride(dayAgo(2)), ride(dayAgo(0))];

const athlete = { ftp_watts: 118, max_hr: 195, weight_kg: 60 };

beforeEach(() => {
  jest.clearAllMocks();
  (cyclingSummariesSince as jest.Mock).mockResolvedValue(rides());
  (getAthleteState as jest.Mock).mockResolvedValue({ athlete, configured: true });
  (getFtpMeta as jest.Mock).mockResolvedValue({ updated_at: null, source: null });
  (setAthlete as jest.Mock).mockImplementation(async (patch: { ftp_watts?: number }) => ({
    ...athlete,
    ...patch,
  }));
  (setAiFtpUpdate as jest.Mock).mockResolvedValue(undefined);
  (getAiFtpUpdate as jest.Mock).mockResolvedValue(null);
});

describe('applyAiFtpUpdate', () => {
  it('缺省取两法均值并写库；快照保存旧溯源戳（撤销恢复用）', async () => {
    (getFtpMeta as jest.Mock)
      .mockResolvedValueOnce({ updated_at: null, source: null })
      .mockResolvedValueOnce({ updated_at: '2026-07-06T10:00:00.000Z', source: 'ai_coach' });
    const res = await applyAiFtpUpdate('zh');
    expect(res.applied).toBe(true);
    expect(res.new_ftp_w).toBe(124);
    expect(res.requested_w).toBeNull();
    expect(res.clamped).toBe(false);
    expect(setAthlete).toHaveBeenCalledWith({ ftp_watts: 124 }, 'zh', { source: 'ai_coach' });
    expect(setAiFtpUpdate).toHaveBeenCalledWith({
      old_ftp_w: 118,
      new_ftp_w: 124,
      updated_at: '2026-07-06T10:00:00.000Z',
      old_ftp_updated_at: null,
      old_ftp_source: null,
    });
    expect(rebuildDossierQuietly).toHaveBeenCalled();
  });

  it('自选区间内值：按自选值写库，快照记录 requested_w 与区间', async () => {
    (getFtpMeta as jest.Mock)
      .mockResolvedValueOnce({ updated_at: null, source: null })
      .mockResolvedValueOnce({ updated_at: '2026-07-06T10:00:00.000Z', source: 'ai_coach' });
    const res = await applyAiFtpUpdate('zh', { ftp_watts: 123 });
    expect(res.new_ftp_w).toBe(123);
    expect(res.requested_w).toBe(123);
    expect(res.clamped).toBe(false);
    expect(setAthlete).toHaveBeenCalledWith({ ftp_watts: 123 }, 'zh', { source: 'ai_coach' });
    expect(setAiFtpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        old_ftp_w: 118,
        new_ftp_w: 123,
        requested_w: 123,
        range_low_w: 123,
        range_high_w: 124,
      }),
    );
  });

  it('自选越界：夹逼到区间边界写入（clamped=true），区间外的值写不进库', async () => {
    (getFtpMeta as jest.Mock)
      .mockResolvedValueOnce({ updated_at: null, source: null })
      .mockResolvedValueOnce({ updated_at: '2026-07-06T10:00:00.000Z', source: 'ai_coach' });
    const res = await applyAiFtpUpdate('zh', { ftp_watts: 300 });
    expect(res.new_ftp_w).toBe(124);
    expect(res.requested_w).toBe(300);
    expect(res.clamped).toBe(true);
    expect(setAthlete).toHaveBeenCalledWith({ ftp_watts: 124 }, 'zh', { source: 'ai_coach' });
    expect(setAiFtpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ requested_w: 300, range_low_w: 123, range_high_w: 124 }),
    );
  });

  it('拒绝路径不写库；带回 clamped/requested 供模型转述', async () => {
    // 当前 FTP 已等于估算均值 124：自选 300 被夹到 124 → 与当前一致 → no_change
    (getAthleteState as jest.Mock).mockResolvedValue({
      athlete: { ...athlete, ftp_watts: 124 },
      configured: true,
    });
    const res = await applyAiFtpUpdate('zh', { ftp_watts: 300 });
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/目标值与当前 FTP 一致/);
    expect(res.requested_w).toBe(300);
    expect(res.clamped).toBe(true);
    expect(setAthlete).not.toHaveBeenCalled();
    expect(setAiFtpUpdate).not.toHaveBeenCalled();
  });
});

describe('undoAiFtpUpdate', () => {
  it('恢复旧值与撤销前的溯源戳（AI 更新前无戳 → 清除，不再判已校准）', async () => {
    (getAiFtpUpdate as jest.Mock).mockResolvedValue({
      old_ftp_w: 106,
      new_ftp_w: 180,
      updated_at: '2026-07-06T10:00:00.000Z',
      old_ftp_updated_at: null,
      old_ftp_source: null,
    });
    (getAthleteState as jest.Mock).mockResolvedValue({ athlete: { ...athlete, ftp_watts: 180 }, configured: true });
    const res = await undoAiFtpUpdate('zh');
    expect(res).toEqual({ undone: true, restored_ftp_w: 106 });
    expect(setAthlete).toHaveBeenCalledWith({ ftp_watts: 106 }, 'zh', {
      source: 'manual',
      stamps: { updated_at: null, source: null },
    });
    expect(setAiFtpUpdate).toHaveBeenCalledWith(null);
  });

  it('恢复撤销前已有的溯源戳（用户先手动设过 FTP 再被 AI 更新）', async () => {
    (getAiFtpUpdate as jest.Mock).mockResolvedValue({
      old_ftp_w: 180,
      new_ftp_w: 200,
      updated_at: '2026-07-06T10:00:00.000Z',
      old_ftp_updated_at: '2026-06-01T08:00:00.000Z',
      old_ftp_source: 'manual',
    });
    (getAthleteState as jest.Mock).mockResolvedValue({ athlete: { ...athlete, ftp_watts: 200 }, configured: true });
    await undoAiFtpUpdate('zh');
    expect(setAthlete).toHaveBeenCalledWith({ ftp_watts: 180 }, 'zh', {
      source: 'manual',
      stamps: { updated_at: '2026-06-01T08:00:00.000Z', source: 'manual' },
    });
  });

  it('旧快照（无 old_ftp_* 字段）：按无戳恢复', async () => {
    (getAiFtpUpdate as jest.Mock).mockResolvedValue({
      old_ftp_w: 106,
      new_ftp_w: 180,
      updated_at: '2026-07-06T10:00:00.000Z',
    });
    (getAthleteState as jest.Mock).mockResolvedValue({ athlete: { ...athlete, ftp_watts: 180 }, configured: true });
    await undoAiFtpUpdate('zh');
    expect(setAthlete).toHaveBeenCalledWith({ ftp_watts: 106 }, 'zh', {
      source: 'manual',
      stamps: { updated_at: null, source: null },
    });
  });

  it('stale（当前 FTP 已被后续修改）：拒绝且不写库', async () => {
    (getAiFtpUpdate as jest.Mock).mockResolvedValue({
      old_ftp_w: 106,
      new_ftp_w: 180,
      updated_at: '2026-07-06T10:00:00.000Z',
    });
    (getAthleteState as jest.Mock).mockResolvedValue({ athlete: { ...athlete, ftp_watts: 190 }, configured: true });
    const res = await undoAiFtpUpdate('zh');
    expect(res).toEqual({ undone: false, reason: 'stale' });
    expect(setAthlete).not.toHaveBeenCalled();
  });
});

// 类型出口：options 形状被服务层导出（供 aiGenerate 绑定处复用）
const _optionsShape: AiFtpUpdateOptions = { ftp_watts: 124 };
void _optionsShape;

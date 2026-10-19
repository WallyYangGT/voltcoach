/**
 * use-ride-date-labels.test.tsx — L4 Hook 测试：useRideDateLabels（双口径统一展示面）。
 *
 * 钉住的中间层行为：records 首帧时刻 → 本地日历日标签的解析与回退（缺首帧的键
 * 不进 Map，调用方以行的原始 date 兜底）、同批多键全量解析、fileNames 变化重解析
 * 时进程内缓存命中（同一文件不重复读盘——与报告标题共用 startCache）。
 *
 * mock 边界：'@/records-store'（首帧读取）与 '@/db'（aiTitle 顶层导入的库查询）、
 * '@/i18n'（aiTitle 顶层导入的 useI18n）整体替换，Hook 不触碰真实设备 IO。
 * 时区无关断言：预期值用 Date 本地分量现算（本机=UTC+8 与 CI=UTC 都绿）。
 * RNTL v14：renderHook 为 async；Hook 的解析在 useEffect 异步续体里 setState
 * （渐进分批），统一用 act(async) 轮询排空微任务，setState 落在 act 窗口内
 * （decisions §18：同步 act 在本仓环境会报 overlapping act）。
 */
import { act, renderHook } from '@testing-library/react-native';
import { invalidateReportTitles, useRideDateLabels } from '@/services/aiTitle';
import { readStoredRecordStart } from '@/records-store';

jest.mock('@/records-store', () => ({
  readStoredRecordStart: jest.fn(),
}));

jest.mock('@/db', () => ({
  listActivityRideKeys: jest.fn(async () => []),
  setLang: jest.fn(),
}));

jest.mock('@/i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, lang: 'zh' }),
}));

const mockedRead = readStoredRecordStart as jest.MockedFunction<typeof readStoredRecordStart>;

const tzDay = (utcText: string) => {
  const d = new Date(Date.parse(utcText));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** act 窗口内轮询微任务队列，直到 Hook 状态出现期望键（或轮空失败） */
async function drainUntil(get: () => Map<string, string>, key: string): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 50 && !get().has(key); i++) await Promise.resolve();
  });
}

/** act 窗口内轮询到指定键的值命中（用于失效后重新解析的断言） */
async function drainUntilValue(get: () => Map<string, string>, key: string, value: string): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 50 && get().get(key) !== value; i++) await Promise.resolve();
  });
}

describe('useRideDateLabels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateReportTitles(); // 清 aiTitle 的进程内首帧缓存，测试互不串味
  });

  it('有首帧的骑行解析为本地日历日；缺首帧不进 Map（调用方回退原值）', async () => {
    mockedRead.mockImplementation(async (name: string) =>
      name === 'a.fit' ? '2026-03-25T20:00:00Z' : null,
    );
    const { result } = await renderHook(() => useRideDateLabels(['a.fit', 'b.fit']));
    await drainUntil(() => result.current, 'a.fit');
    // +8 时 20:00Z 已是次日（03-26）；UTC 的 CI 上仍是 03-25——预期按本地分量现算
    expect(result.current.get('a.fit')).toBe(tzDay('2026-03-25T20:00:00Z'));
    expect(result.current.has('b.fit')).toBe(false);
  });

  it('fileNames 变化重解析；同文件走进程内缓存不重复读盘', async () => {
    mockedRead.mockImplementation(
      async (name: string) => `${name === 'c.fit' ? '2026-03-02' : '2026-03-01'}T05:00:00Z`,
    );
    const { result, rerender } = await renderHook(
      ({ names }: { names: (string | null | undefined)[] }) => useRideDateLabels(names),
      { initialProps: { names: ['a.fit'] as (string | null | undefined)[] } },
    );
    await drainUntil(() => result.current, 'a.fit');
    await act(async () => {
      rerender({ names: ['a.fit', 'c.fit'] });
    });
    await drainUntil(() => result.current, 'c.fit');
    expect(result.current.get('a.fit')).toBe(tzDay('2026-03-01T05:00:00Z'));
    expect(mockedRead.mock.calls.filter((c) => c[0] === 'a.fit')).toHaveLength(1);
  });

  it('invalidateReportTitles 后同一 id 集合重新解析（缓存代际订阅，不展示陈旧标签）', async () => {
    let utc = '2026-03-01T05:00:00Z';
    mockedRead.mockImplementation(async () => utc);
    const { result } = await renderHook(() => useRideDateLabels(['a.fit']));
    await drainUntil(() => result.current, 'a.fit');
    const first = tzDay(utc);
    expect(result.current.get('a.fit')).toBe(first);

    utc = '2026-03-02T05:00:00Z';
    await act(async () => {
      invalidateReportTitles();
    });
    await drainUntilValue(() => result.current, 'a.fit', tzDay(utc));
    expect(result.current.get('a.fit')).toBe(tzDay(utc));
    expect(mockedRead.mock.calls.filter((c) => c[0] === 'a.fit').length).toBeGreaterThan(1);
  });
});

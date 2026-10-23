/**
 * sync-keepalive.test.ts — L4 服务层测试：云同步编排 × 保活壳接线（decisions §17）。
 *
 * 钉住的中间层语义（code-review P2-2：此前只靠一次性冒烟）：
 * 1. 未绑定凭据的 fast-fail 不 acquire（不闪通知）；
 * 2. 拉取正常返回 / 建会话失败早退 / 列表失败早退——release 恰好一次
 *    （finally 覆盖 pullActivities 的全部早退路径）；
 * 3. 并发 runSync 共享同一 promise → 只 acquire 一次（防双跑 × 引用计数交互）；
 * 4. 逐活动鉴权失败终止本轮（记 auth，不再往下拉）；
 * 5. 水位线写进**当前生效平台**的槽位（多平台后状态行按平台分槽）。
 *
 * mock 边界：'@/db'、'@/ai/keepalive' 与平台注册表（'@/services/syncProviders'）
 * 整体替换——被测对象只有 runSyncOnce 的编排与保活配对，平台协议行为由桩 runner
 * 注入（各平台客户端另有 L1 直测）。
 */
import { runSync } from '@/services/sync';
import { acquireGenerationKeepAlive } from '@/ai/keepalive';
import { getSyncState, setSyncState } from '@/db';
import { SyncError } from '@/sync/common';
import { providerById } from '@/services/syncProviders';

jest.mock('@/ai/keepalive', () => ({
  acquireGenerationKeepAlive: jest.fn(),
}));

jest.mock('@/db', () => ({
  getLang: jest.fn(() => Promise.resolve('zh')),
  getSyncState: jest.fn(),
  setSyncState: jest.fn(() => Promise.resolve()),
  listActivityFileNames: jest.fn(() => Promise.resolve([])),
}));

jest.mock('@/services/syncProviders', () => ({
  providerById: jest.fn(),
  allProviders: jest.fn(() => []),
}));

/** 新版状态行（按平台分槽）的空态 */
const EMPTY_STATE = {
  provider: 'onelap' as const,
  auto: false,
  providers: {},
};

/** 平台适配器桩：凭据已绑定，协议行为由 runner 桩注入 */
function stubProvider(over: Partial<Record<string, unknown>> = {}) {
  const runner = {
    start: jest.fn(() => Promise.resolve()),
    listSince: jest.fn(() => Promise.resolve([])),
    getFileRef: jest.fn(() => Promise.resolve({ key: 'geo/mock-ride-1.fit', fileName: 'mock-ride-1.fit' })),
    download: jest.fn(() => Promise.resolve(new Uint8Array([0x0e]))),
    ...over,
  };
  (providerById as jest.Mock).mockReturnValue({
    id: 'onelap',
    labelKey: 'data.sync.provider.onelap',
    authKind: 'password',
    loadCredentials: jest.fn(() => Promise.resolve({ kind: 'password', account: 'smoke@test.local', password: 'pw' })),
    saveCredentials: jest.fn(),
    clearCredentials: jest.fn(),
    createRunner: jest.fn(() => Promise.resolve(runner)),
    probe: jest.fn(() => Promise.resolve([])),
    overrideBase: jest.fn(() => null),
  });
  return runner;
}

beforeEach(() => {
  jest.clearAllMocks();
  (acquireGenerationKeepAlive as jest.Mock).mockResolvedValue({ release: jest.fn(() => Promise.resolve()) });
  (getSyncState as jest.Mock).mockResolvedValue(EMPTY_STATE);
  stubProvider();
});

/** 取本轮 setSyncState 写入的当前平台槽位 */
function writtenSlot() {
  const next = (setSyncState as jest.Mock).mock.calls[0][0] as {
    provider: string;
    providers: Record<string, Record<string, unknown>>;
  };
  return { state: next, slot: next.providers[next.provider] };
}

describe('云同步编排 × 保活壳接线', () => {
  it('未绑定凭据：fast-fail 返回 no_account 且不 acquire（不闪通知）', async () => {
    (providerById as jest.Mock).mockReturnValue({
      id: 'onelap',
      labelKey: 'data.sync.provider.onelap',
      authKind: 'password',
      loadCredentials: jest.fn(() => Promise.resolve(null)),
      createRunner: jest.fn(),
      probe: jest.fn(),
      overrideBase: jest.fn(() => null),
    });
    const outcome = await runSync();
    expect(outcome.error?.code).toBe('no_account');
    expect(acquireGenerationKeepAlive).not.toHaveBeenCalled();
  });

  it('正常同步（空列表）：acquire 一次、release 恰好一次、水位线写 ok', async () => {
    const outcome = await runSync();
    expect(outcome.error).toBeNull();
    expect(acquireGenerationKeepAlive).toHaveBeenCalledTimes(1);
    expect(acquireGenerationKeepAlive).toHaveBeenCalledWith(
      expect.objectContaining({ title: '云端同步进行中', channel: '数据同步' }),
    );
    const release = (acquireGenerationKeepAlive as jest.Mock).mock.results[0].value.then(
      (h: { release: jest.Mock }) => h.release,
    );
    const r = await release;
    expect(r).toHaveBeenCalledTimes(1);
    // 水位线落在当前生效平台（onelap）的槽位里，不是顶层
    const { state, slot } = writtenSlot();
    expect(state.provider).toBe('onelap');
    expect(slot.last_result).toBe('ok');
    expect(typeof slot.last_sync_at).toBe('string');
  });

  it('空窗轮水位线冻结（2026-10 事故防御）：已有水位线 + 列表为空 → last_sync_at 不动、last_run_at 照写', async () => {
    const WATERMARK = '2026-10-16T02:00:00.000Z';
    const slotState = {
      provider: 'onelap' as const,
      auto: false,
      providers: {
        onelap: { last_sync_at: WATERMARK, last_run_at: null, last_result: 'ok', last_error: null, last_counts: null },
      },
    };
    (getSyncState as jest.Mock).mockResolvedValue(slotState);
    stubProvider({ listSince: jest.fn(() => Promise.resolve([])) });
    const outcome = await runSync();
    expect(outcome.error).toBeNull();
    const { slot } = writtenSlot();
    expect(slot.last_sync_at).toBe(WATERMARK); // 冻结：空结果不推进（防列表异常把缺口藏住）
    expect(typeof slot.last_run_at).toBe('string'); // 展示时刻照常更新
    expect(slot.last_result).toBe('ok');
  });

  it('列表非空的正常轮：水位线照常推进到当前时刻', async () => {
    stubProvider({
      listSince: jest.fn(() => Promise.resolve([{ id: '1', startAt: new Date('2026-10-20T08:00:00Z') }])),
      getFileRef: jest.fn(() => Promise.resolve(null)), // 云端无文件 → 计跳过（listed 仍 >0）
    });
    const WATERMARK = '2026-10-16T02:00:00.000Z';
    (getSyncState as jest.Mock).mockResolvedValue({
      provider: 'onelap' as const,
      auto: false,
      providers: {
        onelap: { last_sync_at: WATERMARK, last_run_at: null, last_result: 'ok', last_error: null, last_counts: null },
      },
    });
    await runSync();
    const { slot } = writtenSlot();
    expect(slot.last_sync_at).not.toBe(WATERMARK);
    expect(typeof slot.last_sync_at).toBe('string');
  });

  it('建会话失败早退：release 恰好一次（finally 覆盖），水位线记 error 但不动时间戳', async () => {
    stubProvider({ start: jest.fn(() => Promise.reject(new Error('账号或密码错误'))) });
    const outcome = await runSync();
    expect(outcome.error?.code).toBe('other');
    expect(acquireGenerationKeepAlive).toHaveBeenCalledTimes(1);
    const release = await (acquireGenerationKeepAlive as jest.Mock).mock.results[0].value.then(
      (h: { release: jest.Mock }) => h.release,
    );
    expect(release).toHaveBeenCalledTimes(1);
    // 出错轮：last_result=error、last_error 透出，last_sync_at 保持原值（null），
    // last_run_at 照写（展示「上次实际跑过」）
    const { slot } = writtenSlot();
    expect(slot.last_result).toBe('error');
    expect(slot.last_error).toBe('账号或密码错误');
    expect(slot.last_sync_at).toBeNull();
    expect(typeof slot.last_run_at).toBe('string');
  });

  it('列表失败早退：release 恰好一次', async () => {
    stubProvider({ listSince: jest.fn(() => Promise.reject(new Error('network down'))) });
    const outcome = await runSync();
    expect(outcome.error?.code).toBe('other');
    const release = await (acquireGenerationKeepAlive as jest.Mock).mock.results[0].value.then(
      (h: { release: jest.Mock }) => h.release,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('逐活动鉴权失败：终止本轮并记 auth（不继续拉后续活动）', async () => {
    const runner = stubProvider({
      listSince: jest.fn(() =>
        Promise.resolve([
          { id: '1', startAt: new Date('2026-10-10T08:00:00Z') },
          { id: '2', startAt: new Date('2026-10-09T08:00:00Z') },
        ]),
      ),
      getFileRef: jest.fn(() => Promise.reject(new SyncError('auth', '会话过期'))),
    });
    const outcome = await runSync();
    expect(outcome.error?.code).toBe('auth');
    expect(outcome.failed).toBe(0);
    expect(runner.getFileRef).toHaveBeenCalledTimes(1); // 首个活动即终止
  });

  it('同步途中用户改状态行（切平台/关开关）：收尾按最新行合并，只写目标平台槽位', async () => {
    // 开头读到的状态：生效平台 onelap、自动同步开
    (getSyncState as jest.Mock).mockResolvedValue({ provider: 'onelap', auto: true, providers: {} });
    // 收尾前的重读：用户已把生效平台切成 wahoo、关掉自动同步（首次全量是分钟级，转得完）
    (getSyncState as jest.Mock).mockResolvedValueOnce({ provider: 'onelap', auto: true, providers: {} });
    (getSyncState as jest.Mock).mockResolvedValue({
      provider: 'wahoo',
      auto: false,
      providers: { wahoo: { last_sync_at: null, last_result: null, last_error: null, last_counts: null } },
    });
    await runSync();
    const written = (setSyncState as jest.Mock).mock.calls[0][0] as {
      provider: string;
      auto: boolean;
      providers: Record<string, { last_result: string | null }>;
    };
    // 用户的选择不被同步收尾覆盖回去
    expect(written.provider).toBe('wahoo');
    expect(written.auto).toBe(false);
    expect(written.providers.wahoo).toBeTruthy();
    // 本轮跑的是 onelap，成果写进它的槽位
    expect(written.providers.onelap?.last_result).toBe('ok');
  });

  it('并发调用共享同一 promise：acquire 只发生一次', async () => {
    // listSince 挂起：两个调用在同一 tick 发起（第二个共享 running promise），
    // 之后才放行
    let releaseList: () => void = () => {};
    stubProvider({
      listSince: jest.fn(
        () =>
          new Promise((resolve) => {
            releaseList = () => resolve([]);
          }),
      ),
    });
    const pa = runSync();
    const pb = runSync();
    await new Promise((r) => setTimeout(r, 0));
    releaseList();
    const [a, b] = await Promise.all([pa, pb]);
    expect(a).toBe(b); // 同一 outcome 对象 = 共享同一 promise
    expect(acquireGenerationKeepAlive).toHaveBeenCalledTimes(1);
  });
});

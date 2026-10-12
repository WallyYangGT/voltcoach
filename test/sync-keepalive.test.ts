/**
 * sync-keepalive.test.ts — L4 服务层测试：顽鹿同步 × 保活壳接线（decisions §17）。
 *
 * 钉住的中间层语义（code-review P2-2：此前只靠一次性冒烟）：
 * 1. 未配置账号的 fast-fail 不 acquire（不闪通知）；
 * 2. pull 正常返回 / login 失败早退 / listSince 失败早退——release 恰好一次
 *    （finally 覆盖 pullActivities 的全部早退路径）；
 * 3. 并发 runOnelapSync 共享同一 promise → 只 acquire 一次（防双跑 × 引用计数交互）。
 *
 * mock 边界：'@/db'、'expo-secure-store'、'expo-crypto'、'@/ai/http'、
 * '@/ai/keepalive' 与 '@/sync/onelap' 的 client 工厂整体替换——被测对象只有
 * runSyncOnce 的编排与保活配对，client 行为由桩注入。
 */
import { getOnelapAccount, runOnelapSync } from '@/services/syncOnelap';
import { acquireGenerationKeepAlive } from '@/ai/keepalive';
import { getSyncState, setSyncState } from '@/db';
import * as SecureStore from 'expo-secure-store';
import { createOnelapClient } from '@/sync/onelap';

// 设备侧模块整体 mock（babel-plugin-jest-hoist 会把 jest.mock 提到所有 import 之前）
jest.mock('@/ai/keepalive', () => ({
  acquireGenerationKeepAlive: jest.fn(),
}));

jest.mock('@/db', () => ({
  getLang: jest.fn(() => Promise.resolve('zh')),
  getSyncState: jest.fn(),
  setSyncState: jest.fn(() => Promise.resolve()),
  listActivityFileNames: jest.fn(() => Promise.resolve([])),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn(() => Promise.resolve('md5')),
  getRandomBytes: jest.fn(() => new Uint8Array(16)),
}));

jest.mock('@/ai/http', () => ({
  loadDefaultFetch: jest.fn(() => Promise.resolve(jest.fn())),
}));

jest.mock('@/sync/onelap', () => ({
  createOnelapClient: jest.fn(),
  endpointOrigins: jest.fn(() => []),
  extractFitFileName: jest.fn((_key: string, id: number) => `mock-ride-${id}.fit`),
  jitterDelayMs: jest.fn(() => 0),
  OnelapError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  parseRideTime: jest.fn(() => new Date('2026-10-11T08:00:00Z')),
  probeEndpoint: jest.fn(),
  syncWindowStart: jest.fn(() => new Date('2026-09-01T00:00:00Z')),
}));

const EMPTY_STATE = {
  auto: false,
  last_sync_at: null,
  last_result: null,
  last_error: null,
  last_counts: null,
};

function stubClient(over: Partial<Record<string, unknown>> = {}) {
  (createOnelapClient as jest.Mock).mockReturnValue({
    login: jest.fn(() => Promise.resolve({ token: 't', uid: 'u' })),
    listSince: jest.fn(() => Promise.resolve([])),
    getFitKey: jest.fn(() => Promise.resolve('key')),
    downloadByKey: jest.fn(),
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (acquireGenerationKeepAlive as jest.Mock).mockResolvedValue({ release: jest.fn(() => Promise.resolve()) });
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) =>
    key === 'voltcoach.onelap.account' ? 'smoke@test.local' : 'smoke-pass',
  );
  (getSyncState as jest.Mock).mockResolvedValue(EMPTY_STATE);
  stubClient();
});

describe('顽鹿同步 × 保活壳接线', () => {
  it('未配置账号：fast-fail 返回 no_account 且不 acquire（不闪通知）', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
    const outcome = await runOnelapSync();
    expect(outcome.error?.code).toBe('no_account');
    expect(acquireGenerationKeepAlive).not.toHaveBeenCalled();
  });

  it('正常同步（空列表）：acquire 一次、release 恰好一次、水位线写 ok', async () => {
    const outcome = await runOnelapSync();
    expect(outcome.error).toBeNull();
    expect(acquireGenerationKeepAlive).toHaveBeenCalledTimes(1);
    expect(acquireGenerationKeepAlive).toHaveBeenCalledWith(
      expect.objectContaining({ title: '顽鹿同步进行中', channel: '数据同步' }),
    );
    const release = (acquireGenerationKeepAlive as jest.Mock).mock.results[0].value.then(
      (h: { release: jest.Mock }) => h.release,
    );
    const r = await release;
    expect(r).toHaveBeenCalledTimes(1);
    expect(setSyncState).toHaveBeenCalledWith(expect.objectContaining({ last_result: 'ok' }));
  });

  it('login 失败早退：release 恰好一次（finally 覆盖），水位线记 error 但不动时间戳', async () => {
    stubClient({ login: jest.fn(() => Promise.reject(new Error('账号或密码错误'))) });
    const outcome = await runOnelapSync();
    expect(outcome.error?.code).toBe('other');
    expect(acquireGenerationKeepAlive).toHaveBeenCalledTimes(1);
    const release = await (acquireGenerationKeepAlive as jest.Mock).mock.results[0].value.then(
      (h: { release: jest.Mock }) => h.release,
    );
    expect(release).toHaveBeenCalledTimes(1);
    // 出错轮：last_result=error、last_error 透出，last_sync_at 保持原值（null）
    expect(setSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ last_result: 'error', last_error: '账号或密码错误', last_sync_at: null }),
    );
  });

  it('listSince 失败早退：release 恰好一次', async () => {
    stubClient({ listSince: jest.fn(() => Promise.reject(new Error('network down'))) });
    const outcome = await runOnelapSync();
    expect(outcome.error?.code).toBe('other');
    const release = await (acquireGenerationKeepAlive as jest.Mock).mock.results[0].value.then(
      (h: { release: jest.Mock }) => h.release,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('并发调用共享同一 promise：acquire 只发生一次', async () => {
    // listSince 挂起：两个调用在同一 tick 发起（第二个共享 running promise），
    // 之后才放行
    let releaseList: () => void = () => {};
    stubClient({
      listSince: jest.fn(
        () =>
          new Promise((resolve) => {
            releaseList = () => resolve([]);
          }),
      ),
    });
    const pa = runOnelapSync();
    const pb = runOnelapSync();
    await new Promise((r) => setTimeout(r, 0));
    releaseList();
    const [a, b] = await Promise.all([pa, pb]);
    expect(a).toBe(b); // 同一 outcome 对象 = 共享同一 promise
    expect(acquireGenerationKeepAlive).toHaveBeenCalledTimes(1);
  });

  it('getOnelapAccount：账号与密码齐全才返回', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) =>
      key === 'voltcoach.onelap.account' ? 'u@test' : null,
    );
    expect(await getOnelapAccount()).toBeNull();
  });
});

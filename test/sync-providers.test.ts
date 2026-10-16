/**
 * sync-providers.test.ts — 云同步平台适配层测试（jest，评审 P2-3 补的盲区）
 *
 * `src/services/syncProviders.ts` 是凭据/会话/令牌语义的唯一所在（换号清缓存、401 自愈、
 * 刷新轮换落盘、在途解绑不写回、撤销授权），此前 L1 到不了（import expo）、L4 又整体
 * mock 掉它，等于零覆盖——恰好是「数据安全最容易静默坏掉」的一层。
 *
 * 测试面：直接调平台适配器（ONELAP_PROVIDER / wahoo 注册项），把三个依赖面整体换掉——
 * 协议客户端（@/sync/onelap、@/sync/wahoo 的工厂）、SecureStore、网络。会话自愈在
 * runner 内部（评审 P1-3 的设计），故断言都落在「适配器对存储与网络的调用序列」上。
 */
import * as SecureStore from 'expo-secure-store';
import { SyncError } from '@/sync/common';
import { createOnelapClient } from '@/sync/onelap';
import { createWahooClient } from '@/sync/wahoo';
import { ONELAP_PROVIDER, providerById } from '@/services/syncProviders';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn(() => Promise.resolve('digest')),
  getRandomBytes: jest.fn(() => new Uint8Array(16)),
  CryptoDigestAlgorithm: { MD5: 'MD5', SHA256: 'SHA-256' },
}));

jest.mock('@/ai/http', () => ({
  loadDefaultFetch: jest.fn(() => Promise.resolve(jest.fn())),
}));

jest.mock('@/sync/onelap', () => ({
  ONELAP_LOGIN_URL: 'https://www.onelap.cn/api/login',
  ONELAP_RIDE_RECORD_BASE: 'https://otm.onelap.cn/api/otm/ride_record',
  createOnelapClient: jest.fn(),
}));

// 只换客户端工厂，纯函数（isAccessTokenExpired / WAHOO_API_BASE …）用真实现
jest.mock('@/sync/wahoo', () => ({
  ...jest.requireActual('@/sync/wahoo'),
  createWahooClient: jest.fn(),
}));

const store = SecureStore as jest.Mocked<typeof SecureStore>;

const ONELAP_KEYS = {
  account: 'voltcoach.onelap.account',
  password: 'voltcoach.onelap.password',
  session: 'voltcoach.onelap.session',
};
const WAHOO_KEY = 'voltcoach.wahoo.oauth';

/** 内存版 SecureStore（按键读写，便于断言"写回了什么"） */
let memory: Map<string, string>;
function memoryStore() {
  memory = new Map();
  store.getItemAsync.mockImplementation(async (k: string) => memory.get(k) ?? null);
  store.setItemAsync.mockImplementation(async (k: string, v: string) => {
    memory.set(k, v);
  });
  store.deleteItemAsync.mockImplementation(async (k: string) => {
    memory.delete(k);
  });
}

/** 顽鹿协议客户端桩 */
function stubOnelap(over: Record<string, jest.Mock> = {}) {
  const client = {
    login: jest.fn(async () => ({ token: 'tok', uid: '1' })),
    listSince: jest.fn(async () => []),
    getFileRef: jest.fn(async () => ({ key: 'k', fileName: 'a.fit' })),
    download: jest.fn(async () => new Uint8Array([1])),
    ...over,
  };
  (createOnelapClient as unknown as jest.Mock).mockReturnValue(client);
  return client;
}

/** Wahoo 协议客户端桩 */
function stubWahoo(over: Record<string, jest.Mock> = {}) {
  const client = {
    newPkce: jest.fn(),
    authorizeUrl: jest.fn(),
    exchangeCode: jest.fn(),
    refreshTokens: jest.fn(async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 7200_000 })),
    revoke: jest.fn(async () => {}),
    listSince: jest.fn(async () => []),
    getFileRef: jest.fn(),
    download: jest.fn(),
    ...over,
  };
  (createWahooClient as unknown as jest.Mock).mockReturnValue(client);
  return client;
}

function wahooCreds(over: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'oauth',
    clientId: 'cid',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 7200_000,
    codeVerifier: 'v'.repeat(43),
    redirectUri: 'voltcoach:///wahoo-callback',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  memoryStore();
});

describe('密码型平台（顽鹿）的凭据与会话', () => {
  it('已绑定：401 时清缓存 → 重登 → 重试原请求一次（只重试一次）', async () => {
    memory.set(ONELAP_KEYS.account, 'rider@example.com');
    memory.set(ONELAP_KEYS.password, 'pw');
    const authErr = new SyncError('auth', '鉴权被拒'); // 必须是真的 SyncError：自愈按实例判类型
    const client = stubOnelap({
      listSince: jest.fn().mockRejectedValueOnce(authErr).mockResolvedValueOnce([{ id: '1', startAt: null }]),
    });

    const runner = await ONELAP_PROVIDER.createRunner();
    await runner.start();
    const acts = await runner.listSince(null);

    expect(acts).toHaveLength(1);
    expect(client.login).toHaveBeenCalledTimes(2); // 首次 + 401 后重登
    // 401 时先清缓存再重登
    expect(store.deleteItemAsync).toHaveBeenCalledWith(ONELAP_KEYS.session);
  });

  it('旧版扁平会话缓存（{account, token, uid}）被认下：不触发多余的密码登录', async () => {
    memory.set(ONELAP_KEYS.account, 'rider@example.com');
    memory.set(ONELAP_KEYS.password, 'pw');
    memory.set(ONELAP_KEYS.session, JSON.stringify({ account: 'rider@example.com', token: 'legacy-tok', uid: '9' }));
    const client = stubOnelap();

    const runner = await ONELAP_PROVIDER.createRunner();
    await runner.start();
    await runner.listSince(null);

    expect(client.login).not.toHaveBeenCalled();
    expect(client.listSince).toHaveBeenCalledWith({ token: 'legacy-tok', uid: '9' }, null);
  });

  it('登录取到会话后立刻落盘（缓存形状 {account, session}）', async () => {
    memory.set(ONELAP_KEYS.account, 'rider@example.com');
    memory.set(ONELAP_KEYS.password, 'pw');
    stubOnelap();

    const runner = await ONELAP_PROVIDER.createRunner();
    await runner.start();

    const cached = JSON.parse(memory.get(ONELAP_KEYS.session) ?? '{}');
    expect(cached.account).toBe('rider@example.com');
    expect(cached.session).toEqual({ token: 'tok', uid: '1' });
  });

  it('换号：账号变更即作废旧会话缓存（不拿 A 的 token 读 B 的数据）', async () => {
    memory.set(ONELAP_KEYS.session, JSON.stringify({ account: 'old@example.com', session: { token: 't', uid: '1' } }));
    await ONELAP_PROVIDER.saveCredentials({ kind: 'password', account: 'new@example.com', password: 'pw' });
    expect(store.deleteItemAsync).toHaveBeenCalledWith(ONELAP_KEYS.session);
  });

  it('解绑：三个键全删（账号/密码/会话）', async () => {
    memory.set(ONELAP_KEYS.account, 'rider@example.com');
    memory.set(ONELAP_KEYS.password, 'pw');
    memory.set(ONELAP_KEYS.session, '{}');
    await ONELAP_PROVIDER.clearCredentials();
    expect([...memory.keys()]).toEqual([]);
  });
});

describe('OAuth 型平台（Wahoo）的令牌与自愈', () => {
  it('未授权：createRunner 直接以 reauth 拒绝（界面提示重新授权，不是账号密码错误）', async () => {
    await expect(providerById('wahoo').createRunner()).rejects.toMatchObject({ code: 'reauth' });
  });

  it('到期前 5 分钟内：start 先刷新并**立刻落盘**新令牌（轮换后旧 refresh 必须消失）', async () => {
    memory.set(WAHOO_KEY, JSON.stringify(wahooCreds({ expiresAt: Date.now() + 60_000 })));
    const client = stubWahoo();

    const runner = await providerById('wahoo').createRunner();
    await runner.start();

    expect(client.refreshTokens).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(memory.get(WAHOO_KEY) ?? '{}');
    expect(saved.accessToken).toBe('new-access');
    expect(saved.refreshToken).toBe('new-refresh');
    // 非令牌字段（clientId/verifier/redirectUri）必须保住：刷新后还要用
    expect(saved.clientId).toBe('cid');
    expect(saved.codeVerifier).toBe('v'.repeat(43));
  });

  it('未过期：start 不刷新（只刷不用会攒满「每用户 10 个未吊销 token」）', async () => {
    memory.set(WAHOO_KEY, JSON.stringify(wahooCreds()));
    const client = stubWahoo();
    const runner = await providerById('wahoo').createRunner();
    await runner.start();
    expect(client.refreshTokens).not.toHaveBeenCalled();
  });

  it('中途 401：刷新令牌后重试原请求一次（会话自愈在 runner 内，评审 P1-3）', async () => {
    memory.set(WAHOO_KEY, JSON.stringify(wahooCreds()));
    const authErr = new SyncError('auth', '鉴权被拒（HTTP 401）');
    const client = stubWahoo({
      listSince: jest.fn().mockRejectedValueOnce(authErr).mockResolvedValueOnce([{ id: '7', startAt: null }]),
    });
    const runner = await providerById('wahoo').createRunner();
    await runner.start();
    const acts = await runner.listSince(null);
    expect(acts).toHaveLength(1);
    expect(client.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('刷新被拒（用户已吊销授权）：归 reauth 而不是 auth', async () => {
    memory.set(WAHOO_KEY, JSON.stringify(wahooCreds({ expiresAt: Date.now() - 1 })));
    stubWahoo({
      refreshTokens: jest.fn(async () => {
        throw new SyncError('auth', 'invalid_grant');
      }),
    });
    const runner = await providerById('wahoo').createRunner();
    await expect(runner.start()).rejects.toMatchObject({ code: 'reauth' });
  });

  it('刷新期间被解绑：刷新结果不写回（不把作废令牌写回 Keystore）', async () => {
    memory.set(WAHOO_KEY, JSON.stringify(wahooCreds({ expiresAt: Date.now() - 1 })));
    const client = stubWahoo({
      refreshTokens: jest.fn(async () => {
        memory.delete(WAHOO_KEY); // 模拟刷新在途时用户解绑
        return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 7200_000 };
      }),
    });
    const runner = await providerById('wahoo').createRunner();
    await runner.start();
    expect(client.refreshTokens).toHaveBeenCalledTimes(1);
    expect(memory.has(WAHOO_KEY)).toBe(false);
  });

  it('重新授权：旧令牌被尽力吊销（官方限「每用户 10 个未吊销 token」）', async () => {
    memory.set(WAHOO_KEY, JSON.stringify(wahooCreds()));
    const client = stubWahoo();
    await providerById('wahoo').saveCredentials(wahooCreds({ refreshToken: 'brand-new', accessToken: 'brand-new-access' }) as never);
    expect(client.revoke).toHaveBeenCalledWith('old-access');
  });

  it('解绑：删凭据并撤销授权；撤销失败只警告不阻断', async () => {
    memory.set(WAHOO_KEY, JSON.stringify(wahooCreds()));
    stubWahoo({ revoke: jest.fn(async () => { throw new Error('offline'); }) });
    await expect(providerById('wahoo').clearCredentials()).resolves.toBeUndefined();
    expect(memory.has(WAHOO_KEY)).toBe(false);
  });
});

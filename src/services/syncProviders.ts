/**
 * syncProviders.ts — 云同步平台注册表（设备侧，2026-10-16 多平台化）
 *
 * 一个平台的「接入面」= 凭据怎么存（SecureStore 命名空间）+ 客户端怎么装配（fetch/
 * 加密实现注入）+ 怎么探测端点 + 执行器怎么建（会话缓存与失效自愈）。协议本身在
 * src/sync/<平台>.ts（纯函数层，不碰 RN/Expo）；本文件是两者之间的胶水，因此**设备侧
 * 才能测的那部分（SecureStore/加密/网络绑定）集中于此**，编排层（src/services/sync.ts）
 * 只依赖这里给出的 SyncProvider/SyncRunner 接口，不认识任何具体平台。
 *
 * 会话策略（与顽鹿 M4 定下的口径一致，全部平台沿用）：
 *  - 先复用 SecureStore 里缓存的会话（`{account, session}` JSON），401 才重新登录；
 *  - 会话缓存是纯优化：读写失败只警告不阻断同步；
 *  - 换号/解绑即作废旧会话，避免拿 A 的 token 读 B 的数据。
 * 账号密码/令牌不进训练库（与 AI Key 同级敏感），只存 SecureStore（Android Keystore）。
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { loadDefaultFetch } from '@/ai/http';
import type { DictKey } from '@/i18n/dict'; // 仅类型（编译期擦除），不把词典的运行期依赖带进服务层
import {
  endpointOrigins,
  probeEndpoint,
  SyncError,
  type FileRef,
  type ProbeResult,
  type RemoteActivity,
  type SyncClient,
} from '@/sync/common';
import { createIgpsportClient, IGPSPORT_REGIONS, type IgpsportRegionKey } from '@/sync/igpsport';
import { createOnelapClient, ONELAP_LOGIN_URL, ONELAP_RIDE_RECORD_BASE } from '@/sync/onelap';
import {
  createWahooClient,
  isAccessTokenExpired,
  WAHOO_API_BASE,
  type WahooClient,
  type WahooTokens,
} from '@/sync/wahoo';
import { SYNC_PROVIDER_IDS, type SyncProviderId } from '@/sync/state';

/** 账号密码型凭据（顽鹿 / 迹驰） */
export interface PasswordCredentials {
  kind: 'password';
  account: string;
  password: string;
}

/** OAuth 型凭据（Wahoo）：clientId 是用户自建 sandbox 应用，其余是授权结果 */
export interface OAuthCredentials {
  kind: 'oauth';
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** access token 到期时刻（epoch 毫秒） */
  expiresAt: number;
  /**
   * PKCE code_verifier：官方要求**刷新令牌时一并带上**（PKCE 客户端没有 client_secret），
   * 故必须与令牌一起持久化，不能授权完就丢。
   */
  codeVerifier: string;
  /** 授权时用的回调地址：令牌交换要带，且必须与门户登记的完全一致 */
  redirectUri: string;
}

export type SyncCredentials = PasswordCredentials | OAuthCredentials;

/**
 * 平台执行器：编排层只看到这四个动作。会话（token）封在闭包里，
 * 因此编排层不需要知道各平台的会话形状差异。
 *
 * **会话自愈在 runner 内部**（密码型 401 → 清缓存重登一次；OAuth 401 → 刷新令牌后重试
 * 一次），编排层不感知——早期设计把 recover() 放在接口上让编排层驱动，结果编排层从未
 * 调用它，OAuth 的 401 失去自愈（评审 P1-3 揪出）。自愈失败时抛 SyncError('reauth')
 * 表示「需要用户回设置页重新授权」。
 */
export interface SyncRunner {
  /** 建立/恢复会话（读缓存或登录/刷新）；失败抛 SyncError */
  start(): Promise<void>;
  listSince(since: Date | null): Promise<RemoteActivity[]>;
  /** 活动 → 文件引用；null = 云端无原始文件（按跳过处理） */
  getFileRef(a: RemoteActivity): Promise<FileRef | null>;
  download(ref: FileRef): Promise<Uint8Array>;
}

export interface SyncProvider {
  id: SyncProviderId;
  /** 下拉展示名（dict.ts 双语 key，经 useI18n 的 t() 取文案） */
  labelKey: DictKey;
  /** 认证形态：password = 账号密码表单；oauth = 浏览器授权按钮 */
  authKind: 'password' | 'oauth';
  /** 已绑定凭据（未绑定 null） */
  loadCredentials(): Promise<SyncCredentials | null>;
  /** 保存凭据（整体覆盖；账号变更即作废旧会话） */
  saveCredentials(creds: SyncCredentials): Promise<void>;
  /** 解绑：清凭据 + 作废会话 */
  clearCredentials(): Promise<void>;
  /** 建执行器（凭据未绑定时抛 SyncError('auth')） */
  createRunner(): Promise<SyncRunner>;
  /** 「测试连接」：探测该平台的云端源（不含凭据，纯链路验证） */
  probe(): Promise<ProbeResult[]>;
  /** 联调端点覆盖自曝（EXPO_PUBLIC_* 打包期内联）；null = 未覆盖 */
  overrideBase(): string | null;
}

// ---------------- 账号密码型平台：通用执行器 ----------------

/** 带 login 的客户端（顽鹿 / 迹驰等账号密码型平台都满足） */
type PasswordClient<S extends object> = SyncClient<S> & {
  login(account: string, password: string): Promise<S>;
};

interface PasswordProviderSpec<S extends object> {
  id: SyncProviderId;
  labelKey: DictKey;
  /** SecureStore 键名（账号 / 密码 / 会话缓存） */
  keys: { account: string; password: string; session: string };
  /** 客户端工厂（fetch 与加密实现由服务层注入） */
  createClient(): Promise<PasswordClient<S>>;
  /** 该平台要探测的端点 URL（含联调覆盖） */
  endpointUrls(): string[];
  overrideBase(): string | null;
}

/** 会话缓存的落盘形状（account 用于归属校验，session 是平台自定义的会话对象） */
interface CachedSessionPayload<S> {
  account: string;
  session: S;
}

function createPasswordProvider<S extends object>(spec: PasswordProviderSpec<S>): SyncProvider {
  const { account: accountKey, password: passwordKey, session: sessionKey } = spec.keys;

  const loadCredentials = async (): Promise<PasswordCredentials | null> => {
    const [account, password] = await Promise.all([
      SecureStore.getItemAsync(accountKey),
      SecureStore.getItemAsync(passwordKey),
    ]);
    return account && password ? { kind: 'password', account, password } : null;
  };

  /**
   * 读缓存会话；无缓存/内容损坏/形状不符返回 null（调用方转为密码登录）。
   * 兼容 M4 的**扁平旧形状** `{account, token, uid}`（多平台化前没有 session 包裹层）：
   * 缺 session 键时把 account 之外的字段整体当作会话——否则老用户升级后要多做一次
   * 带密码的登录（无害但没必要）。
   */
  const readCache = async (): Promise<CachedSessionPayload<S> | null> => {
    const raw = await SecureStore.getItemAsync(sessionKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed?.account !== 'string') return null;
      if ('session' in parsed) {
        const session = parsed.session;
        if (!session || typeof session !== 'object') return null;
        return { account: parsed.account, session: session as S };
      }
      const { account: _account, ...rest } = parsed;
      return Object.keys(rest).length > 0 ? { account: parsed.account, session: rest as S } : null;
    } catch {
      return null; // 行内容损坏按无缓存处理
    }
  };

  return {
    id: spec.id,
    labelKey: spec.labelKey,
    authKind: 'password',
    loadCredentials,

    async saveCredentials(creds) {
      if (creds.kind !== 'password') throw new SyncError('auth', '凭据类型不符（需要账号密码）');
      const account = creds.account.trim();
      await Promise.all([
        SecureStore.setItemAsync(accountKey, account),
        SecureStore.setItemAsync(passwordKey, creds.password),
      ]);
      // 账号可能换了人：旧会话即刻作废，避免拿 A 的 token 读 B 的数据
      const cached = await readCache();
      if (cached && cached.account !== account) await SecureStore.deleteItemAsync(sessionKey);
    },

    async clearCredentials() {
      await Promise.all([
        SecureStore.deleteItemAsync(accountKey),
        SecureStore.deleteItemAsync(passwordKey),
        SecureStore.deleteItemAsync(sessionKey),
      ]);
    },

    async createRunner() {
      const creds = await loadCredentials();
      if (!creds) throw new SyncError('auth', '未绑定账号');
      const client = await spec.createClient();
      const account = creds.account.trim();
      let session: S | null = null;

      /** 缓存会话（仅当账号仍绑定且匹配时写入；纯优化，存储异常只警告） */
      async function writeCache(s: S): Promise<void> {
        try {
          const bound = await loadCredentials();
          if (!bound || bound.kind !== 'password' || bound.account.trim() !== account) return;
          await SecureStore.setItemAsync(sessionKey, JSON.stringify({ account, session: s }));
        } catch (e) {
          console.warn(`${spec.id} 会话缓存写入失败（忽略，下次同步重新登录）:`, e);
        }
      }

      async function clearCache(): Promise<void> {
        try {
          await SecureStore.deleteItemAsync(sessionKey);
        } catch (e) {
          console.warn(`${spec.id} 会话缓存清除失败（忽略，交给后续 401 自愈）:`, e);
        }
      }

      const login = async (): Promise<S> => {
        const s = await client.login(account, creds.password);
        await writeCache(s);
        return s;
      };

      /** 取当前会话；未就绪则读缓存或登录 */
      const ensure = async (): Promise<S> => {
        if (session) return session;
        const cached = await readCache();
        if (cached && cached.account === account) {
          session = cached.session;
        } else {
          session = await login();
        }
        return session;
      };

      /** 带一次自动重登的调用：仅 auth 错误时清缓存重登重试，其余原样抛出 */
      const withAuthRetry = async <T>(fn: (s: S) => Promise<T>): Promise<T> => {
        try {
          return await fn(await ensure());
        } catch (e) {
          if (!(e instanceof SyncError) || e.code !== 'auth') throw e;
          console.warn(`${spec.id} 会话失效（401），清缓存并重新登录一次`);
          await clearCache();
          session = await login();
          return fn(session);
        }
      };

      return {
        async start() {
          await ensure();
        },
        listSince: (since) => withAuthRetry((s) => client.listSince(s, since)),
        getFileRef: (a) => withAuthRetry((s) => client.getFileRef(s, a)),
        download: (ref) => withAuthRetry((s) => client.download(s, ref)),
        async recover() {
          // 编排层已判过 auth：这里同样清缓存重登；重登仍失败就把错误抛给用户
          await clearCache();
          session = await login();
        },
      };
    },

    async probe() {
      const [fetchImpl, origins] = await Promise.all([
        loadDefaultFetch(),
        Promise.resolve(endpointOrigins(spec.endpointUrls())),
      ]);
      return Promise.all(origins.map((origin) => probeEndpoint(origin, { fetchImpl })));
    },

    overrideBase: spec.overrideBase,
  };
}

// ---------------- 顽鹿（Onelap） ----------------

/** 联调端点覆盖（EXPO_PUBLIC_ONELAP_BASE 打包期内联；生产构建不设即 undefined） */
function onelapOverrides(): { login: string; rideRecord: string } | undefined {
  const base = process.env.EXPO_PUBLIC_ONELAP_BASE;
  return base ? { login: `${base}/api/login`, rideRecord: `${base}/api/otm/ride_record` } : undefined;
}

export const ONELAP_PROVIDER: SyncProvider = createPasswordProvider({
  id: 'onelap',
  labelKey: 'data.sync.provider.onelap', // dict.ts 双语（迹驰/Wahoo 用 igpsport_cn/igpsport_intl/wahoo）
  keys: {
    account: 'voltcoach.onelap.account',
    password: 'voltcoach.onelap.password',
    session: 'voltcoach.onelap.session',
  },
  async createClient() {
    return createOnelapClient({
      fetchImpl: await loadDefaultFetch(),
      md5Hex: (s) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, s),
      randomBytes: (n) => Crypto.getRandomBytes(n),
      baseUrlOverrides: onelapOverrides(),
    });
  },
  endpointUrls() {
    const o = onelapOverrides();
    return [o?.login ?? ONELAP_LOGIN_URL, o?.rideRecord ?? ONELAP_RIDE_RECORD_BASE];
  },
  overrideBase: () => process.env.EXPO_PUBLIC_ONELAP_BASE || null, // 空串按无覆盖（falsy 判定）
});

// ---------------- 迹驰 iGPSPORT（国内 / 国际是两个独立账号体系，各占一个下拉项） ----------------

/** 联调端点覆盖（EXPO_PUBLIC_IGPSPORT_BASE 打包期内联；两区共用同一变量指向 mock） */
function igpsportOverrideBase(): string | null {
  return process.env.EXPO_PUBLIC_IGPSPORT_BASE || null;
}

function createIgpsportProvider(region: IgpsportRegionKey): SyncProvider {
  const config = IGPSPORT_REGIONS[region];
  return createPasswordProvider({
    id: config.id,
    labelKey: region === 'cn' ? 'data.sync.provider.igpsport_cn' : 'data.sync.provider.igpsport_intl',
    keys: {
      account: `voltcoach.${config.id}.account`,
      password: `voltcoach.${config.id}.password`,
      session: `voltcoach.${config.id}.session`,
    },
    async createClient() {
      const base = igpsportOverrideBase();
      return createIgpsportClient({
        region,
        fetchImpl: await loadDefaultFetch(),
        baseUrlOverrides: base ? { api: base } : undefined,
      });
    },
    endpointUrls() {
      return [igpsportOverrideBase() ?? config.apiBase];
    },
    overrideBase: igpsportOverrideBase,
  });
}

// ---------------- OAuth 型平台：Wahoo（官方通道，BYOK client_id） ----------------

/** 联调端点覆盖（EXPO_PUBLIC_WAHOO_BASE 打包期内联） */
function wahooOverrideBase(): string | null {
  return process.env.EXPO_PUBLIC_WAHOO_BASE || null;
}

/** 设备侧 Wahoo 客户端（fetch/PKCE 加密实现绑定；授权流与同步执行器共用） */
export async function createDeviceWahooClient(): Promise<WahooClient> {
  const base = wahooOverrideBase();
  return createWahooClient({
    fetchImpl: await loadDefaultFetch(),
    sha256Hex: (s) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s),
    randomBytes: (n) => Crypto.getRandomBytes(n),
    baseUrlOverrides: base ? { api: base } : undefined,
  });
}

/** 凭据 JSON（OAuth 型平台的 SecureStore 内容就是它本身） */
function isOAuthCredentials(v: unknown): v is OAuthCredentials {
  const o = v as Partial<OAuthCredentials> | null;
  return (
    !!o &&
    o.kind === 'oauth' &&
    typeof o.clientId === 'string' &&
    typeof o.accessToken === 'string' &&
    typeof o.refreshToken === 'string' &&
    typeof o.expiresAt === 'number' &&
    typeof o.codeVerifier === 'string' &&
    typeof o.redirectUri === 'string'
  );
}

interface OAuthProviderSpec {
  id: SyncProviderId;
  labelKey: DictKey;
  /** SecureStore 键（整块凭据 JSON） */
  credentialKey: string;
  createClient(): Promise<WahooClient>;
  endpointUrls(): string[];
  overrideBase(): string | null;
}

function createOAuthProvider(spec: OAuthProviderSpec): SyncProvider {
  const loadCredentials = async (): Promise<OAuthCredentials | null> => {
    const raw = await SecureStore.getItemAsync(spec.credentialKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isOAuthCredentials(parsed) ? parsed : null;
    } catch {
      return null; // 内容损坏按未绑定处理（重新授权即可覆盖）
    }
  };

  return {
    id: spec.id,
    labelKey: spec.labelKey,
    authKind: 'oauth',
    loadCredentials,

    async saveCredentials(creds) {
      if (creds.kind !== 'oauth') throw new SyncError('reauth', '凭据类型不符（需要 OAuth 授权）');
      const previous = await loadCredentials();
      await SecureStore.setItemAsync(spec.credentialKey, JSON.stringify(creds));
      // 重新授权（换 clientId 或再走一遍授权页）会留下旧的未吊销令牌：官方限「每用户
      // 最多 10 个未吊销 token」，攒满后刷新会被拒——旧的那份尽力吊销，失败只警告
      if (previous && previous.refreshToken !== creds.refreshToken) {
        try {
          const client = await spec.createClient();
          await client.revoke(previous.accessToken);
        } catch (e) {
          console.warn(`${spec.id} 旧授权吊销失败（忽略，令牌会自行过期）:`, e);
        }
      }
    },

    async clearCredentials() {
      const creds = await loadCredentials();
      await SecureStore.deleteItemAsync(spec.credentialKey);
      // 尽力而为地撤销授权：既让用户在门户看到应用已断开，也释放「每用户 10 个未吊销
      // token」配额。解绑必须离线也能成功，故失败只警告（令牌 60 天后自动过期）
      if (creds) {
        try {
          const client = await spec.createClient();
          await client.revoke(creds.accessToken);
        } catch (e) {
          console.warn(`${spec.id} 撤销授权失败（忽略，令牌会自行过期）:`, e);
        }
      }
    },

    async createRunner() {
      const creds = await loadCredentials();
      if (!creds) throw new SyncError('reauth', '未授权（请先完成授权登录）');
      const client = await spec.createClient();
      let tokens: WahooTokens = {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      };

      /** 令牌落盘（轮换后必须立刻写回：旧 refresh token 刷一次就废） */
      const persist = async (next: WahooTokens): Promise<void> => {
        tokens = next;
        try {
          const current = await loadCredentials();
          if (!current) return; // 授权途中被解绑：不要把作废的令牌写回去
          await SecureStore.setItemAsync(
            spec.credentialKey,
            JSON.stringify({ ...current, ...next } satisfies OAuthCredentials),
          );
        } catch (e) {
          console.warn(`${spec.id} 令牌写回失败（忽略，下次同步会重新刷新）:`, e);
        }
      };

      /** 刷新令牌；失败即「授权已失效」，只能回设置页重新授权（reauth 而非 auth） */
      const refresh = async (): Promise<void> => {
        try {
          const next = await client.refreshTokens({
            clientId: creds.clientId,
            refreshToken: tokens.refreshToken,
            codeVerifier: creds.codeVerifier,
          });
          await persist(next);
        } catch (e) {
          if (e instanceof SyncError && e.code === 'network') throw e; // 断网不该让用户重授权
          throw new SyncError('reauth', `授权已失效，请重新授权：${e instanceof Error ? e.message : String(e)}`);
        }
      };

      /**
       * 带一次刷新重试的调用（与密码型的 withAuthRetry 对称）：命中 401 先刷新令牌再重试
       * 原请求一次；刷新本身失败或重试仍 401 ⇒ 授权失效（reauth，提示重新授权）。
       * 令牌被提前吊销（用户在官网断开应用）与跨过 2 小时 TTL 的轮次都靠它兜住。
       */
      const withRecover = async <T>(fn: (t: WahooTokens) => Promise<T>): Promise<T> => {
        try {
          return await fn(tokens);
        } catch (e) {
          if (!(e instanceof SyncError) || e.code !== 'auth') throw e;
          console.warn(`${spec.id} 会话失效（401），刷新令牌后重试一次`);
          await refresh();
          try {
            return await fn(tokens);
          } catch (e2) {
            if (e2 instanceof SyncError && e2.code === 'auth') {
              throw new SyncError('reauth', '授权已失效，请重新授权');
            }
            throw e2;
          }
        }
      };

      return {
        async start() {
          // 到期前 5 分钟先刷新；刷新后紧接着就要拉数据（轮换语义要求刷新即用一次）
          if (isAccessTokenExpired(tokens, Date.now())) {
            await refresh();
          } else {
            // 未过期也必须留痕：轮换语义下「只刷不用」会累积未吊销令牌（上限 10 个）
            console.log(`${spec.id} 复用未过期的 access token（到期 ${new Date(tokens.expiresAt).toISOString()}）`);
          }
        },
        listSince: (since) => withRecover((t) => client.listSince(t, since)),
        getFileRef: (a) => withRecover((t) => client.getFileRef(t, a)),
        download: (ref) => withRecover((t) => client.download(t, ref)),
      };
    },

    async probe() {
      const [fetchImpl, origins] = await Promise.all([
        loadDefaultFetch(),
        Promise.resolve(endpointOrigins(spec.endpointUrls())),
      ]);
      return Promise.all(origins.map((origin) => probeEndpoint(origin, { fetchImpl })));
    },

    overrideBase: spec.overrideBase,
  };
}

// ---------------- 注册表 ----------------

const REGISTRY: Partial<Record<SyncProviderId, SyncProvider>> = {
  onelap: ONELAP_PROVIDER,
  'igpsport-cn': createIgpsportProvider('cn'),
  'igpsport-intl': createIgpsportProvider('intl'),
  wahoo: createOAuthProvider({
    id: 'wahoo',
    labelKey: 'data.sync.provider.wahoo',
    credentialKey: 'voltcoach.wahoo.oauth',
    createClient: createDeviceWahooClient,
    endpointUrls: () => [wahooOverrideBase() ?? WAHOO_API_BASE],
    overrideBase: wahooOverrideBase,
  }),
};

/** 取平台适配器（状态行里出现未实现的 id 说明数据被改坏了——抛出而非静默） */
export function providerById(id: SyncProviderId): SyncProvider {
  const p = REGISTRY[id];
  if (!p) throw new SyncError('api', `平台 ${id} 未实现`);
  return p;
}

/** 所有已接入的平台（UI 下拉数据源，顺序即 SYNC_PROVIDER_IDS） */
export function allProviders(): SyncProvider[] {
  return SYNC_PROVIDER_IDS.map((id) => REGISTRY[id]).filter((p): p is SyncProvider => Boolean(p));
}

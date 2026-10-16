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
import { createOnelapClient, ONELAP_LOGIN_URL, ONELAP_RIDE_RECORD_BASE } from '@/sync/onelap';
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
}

export type SyncCredentials = PasswordCredentials | OAuthCredentials;

/**
 * 平台执行器：编排层只看到这五个动作。会话（token）封在闭包里，
 * 因此编排层不需要知道各平台的会话形状差异。
 */
export interface SyncRunner {
  /** 建立/恢复会话（读缓存或登录/刷新）；失败抛 SyncError */
  start(): Promise<void>;
  listSince(since: Date | null): Promise<RemoteActivity[]>;
  /** 活动 → 文件引用；null = 云端无原始文件（按跳过处理） */
  getFileRef(a: RemoteActivity): Promise<FileRef | null>;
  download(ref: FileRef): Promise<Uint8Array>;
  /**
   * 会话失效自愈：清缓存重登（密码型）/ 刷新令牌（OAuth）。
   * 无法自愈时抛 SyncError('reauth')——那需要用户回到设置页重新授权。
   */
  recover(): Promise<void>;
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

  /** 读缓存会话；无缓存/内容损坏/形状不符返回 null（调用方转为密码登录） */
  const readCache = async (): Promise<CachedSessionPayload<S> | null> => {
    const raw = await SecureStore.getItemAsync(sessionKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<CachedSessionPayload<S>>;
      if (typeof parsed?.account !== 'string' || !parsed.session || typeof parsed.session !== 'object') {
        return null;
      }
      return { account: parsed.account, session: parsed.session };
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

// ---------------- 注册表 ----------------

const REGISTRY: Partial<Record<SyncProviderId, SyncProvider>> = {
  onelap: ONELAP_PROVIDER,
  // 迹驰国内/国际、Wahoo 随各自实现落地后接入（UI 下拉由注册表驱动，天然只列出已实现的）
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

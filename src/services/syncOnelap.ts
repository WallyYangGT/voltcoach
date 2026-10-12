/**
 * syncOnelap.ts — 顽鹿云同步编排（同步说明见 README「顽鹿云同步说明」）
 *
 * 流程：读 SecureStore 账号 → 取会话（缓存的 token 优先，无缓存或失效才用密码登录）
 * → 云端列表（窗口化增量：`syncWindowStart` = 上次同步时间前移 24h 与「最近 90 天」
 * 取较晚者，首次同步 90 天窗口）→ 逐活动查 fileKey 算文件名，本地已有的跳过
 * （按文件名的幂等去重：下载前的省流量预检）→ 未知活动下载 FIT 字节走 importFitBytes
 * 入库（其内部再按内容指纹判一次「异名同趟骑行」，命中计 duplicates）
 * → 回写水位线与结果到 settings.sync。活动之间随机间隔（`jitterDelayMs`）摊平请求突发。
 *
 * 会话策略（2026-09-23 由「每次全新登录」改为令牌缓存）：token/uid 存 SecureStore
 * （`voltcoach.onelap.session`），复用到 401 为止——带密码的登录次数因此大幅下降，
 * 形态更贴近官方 App 的长会话；401 时自动清缓存、重登一次并重试原请求（只重试一次，
 * 避免密码错误时的重试风暴）。账号变更/解绑即作废缓存。
 *
 * 自动同步：前台 AppState 触发（国内 ROM 后台限制多，打开时拉最可靠），
 * 模块级 1h 节流；失败仅警告不中断应用。并发防双跑：进行中的同步共享同一 Promise。
 * 保活：同步期间复用 AI 生成的 dataSync 前台服务壳（src/ai/keepalive 引用计数，
 * 2026-10-13 接入）——首次全量同步是分钟级任务，退后台/锁屏不被进程冻结打断。
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { loadDefaultFetch } from '@/ai/http';
import {
  acquireGenerationKeepAlive,
  type KeepAliveHandle,
} from '@/ai/keepalive';
import { t } from '@/core/i18n';
import {
  getLang,
  getSyncState,
  listActivityFileNames,
  setSyncState,
  type SyncState,
} from '@/db';
import { importFitBytes } from './importFit';
import {
  createOnelapClient,
  endpointOrigins,
  extractFitFileName,
  jitterDelayMs,
  OnelapError,
  parseRideTime,
  probeEndpoint,
  syncWindowStart,
  type OnelapSession,
  type ProbeResult,
} from '@/sync/onelap';

/** 同步节流用的等待（活动之间随机间隔，降低请求突发） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SecureStore 键名（与 dbkey/aikey 同前缀口径）
const ONELAP_ACCOUNT_STORE = 'voltcoach.onelap.account';
const ONELAP_PASSWORD_STORE = 'voltcoach.onelap.password';
/** 会话缓存（token/uid 的 JSON）——401 才重登，见文件头「会话策略」 */
const ONELAP_SESSION_STORE = 'voltcoach.onelap.session';

/** 前台自动同步的最小间隔（手动「立即同步」不受限） */
const AUTO_THROTTLE_MS = 60 * 60 * 1000;

export interface OnelapAccount {
  account: string;
  password: string;
}

/** 已配置账号则返回；未配置返回 null（UI 显示待配置态） */
export async function getOnelapAccount(): Promise<OnelapAccount | null> {
  const [account, password] = await Promise.all([
    SecureStore.getItemAsync(ONELAP_ACCOUNT_STORE),
    SecureStore.getItemAsync(ONELAP_PASSWORD_STORE),
  ]);
  return account && password ? { account, password } : null;
}

/** 保存/更新账号（password 传 null 表示清除整组凭据；此时一并作废缓存会话） */
export async function setOnelapAccount(account: string, password: string | null): Promise<void> {
  if (!account.trim() || !password) {
    await Promise.all([
      SecureStore.deleteItemAsync(ONELAP_ACCOUNT_STORE),
      SecureStore.deleteItemAsync(ONELAP_PASSWORD_STORE),
      SecureStore.deleteItemAsync(ONELAP_SESSION_STORE),
    ]);
    return;
  }
  await SecureStore.setItemAsync(ONELAP_ACCOUNT_STORE, account.trim());
  await SecureStore.setItemAsync(ONELAP_PASSWORD_STORE, password);
  // 账号可能换了人：旧会话即刻作废，避免拿 A 的 token 读 B 的数据
  const cached = await readCachedSession();
  if (cached && cached.account !== account.trim()) {
    await SecureStore.deleteItemAsync(ONELAP_SESSION_STORE);
  }
}

// ---------------- 会话缓存（token/uid 复用至 401，大幅减少带密码登录） ----------------

/** 读缓存会话；无缓存/内容损坏/账号不符返回 null（调用方转为密码登录）。
 *  信任边界：与 AI Key 同级（SecureStore/Keystore 支撑）——bearer token 的固有性质是
 *  持有即可读该账号云端数据，故与密钥同存同管。若登录响应结构变化导致 uid 取空，
 *  缓存会退化为「每轮多一次登录 + 报账号密码错误」，届时按登录响应格式排查。 */
async function readCachedSession(): Promise<(OnelapSession & { account: string }) | null> {
  const raw = await SecureStore.getItemAsync(ONELAP_SESSION_STORE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnelapSession & { account: string }>;
    if (typeof parsed.token !== 'string' || typeof parsed.uid !== 'string' || typeof parsed.account !== 'string') {
      return null;
    }
    return { account: parsed.account, token: parsed.token, uid: parsed.uid };
  } catch {
    return null; // 行内容损坏按无缓存处理
  }
}

/** 缓存会话（仅当账号仍绑定且匹配时写入；会话缓存是纯优化，存储异常只警告不阻断同步） */
async function writeCachedSession(account: string, session: OnelapSession): Promise<void> {
  try {
    // 复核账号仍绑定：解绑/换号发生在同步途中的话，不要把作废的会话写回去
    const bound = await getOnelapAccount();
    if (!bound || bound.account.trim() !== account) return;
    await SecureStore.setItemAsync(
      ONELAP_SESSION_STORE,
      JSON.stringify({ account, token: session.token, uid: session.uid }),
    );
  } catch (e) {
    console.warn('会话缓存写入失败（忽略，下次同步会重新登录）:', e);
  }
}

/** 作废缓存会话（401 后调用；连同解绑路径一并清理）。删除失败只警告——不能阻断重登 */
export async function clearCachedSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(ONELAP_SESSION_STORE);
  } catch (e) {
    console.warn('会话缓存清除失败（忽略，交给后续 401 自愈）:', e);
  }
}

/** 单轮同步结果（UI 展示 imported/skipped/duplicates/failed 四计数；error 按稳定码映射 i18n） */
export type SyncErrorCode = 'no_account' | 'auth' | 'other';

export interface SyncOutcome {
  imported: number;
  /** 文件名命中（云端 fileKey 算出的文件名本地已有）——下载前即跳过，省流量 */
  skipped: number;
  /** 内容指纹命中（文件名不同但库里已有同一趟骑行，多为先前手动导入过的）——下载解析后跳过 */
  duplicates: number;
  failed: number;
  /** null = 正常跑完；code 供 UI 双语化，message 为原始技术信息（存库并透出） */
  error: { code: SyncErrorCode; message: string } | null;
  /**
   * 最旧一条失败活动的起骑时间（ISO）。水位线推进锚点：failed>0 时推进到此时间
   * （而非当前时刻）——下次窗口仍覆盖失败活动重试，成功项按文件名幂等跳过；
   * 也不被永久性脏活动（如 no_file）钉死水位线。
   */
  failureFloor: string | null;
}

/** OnelapError → 稳定码（auth 单列供双语化，其余归 other 透出原始信息） */
function toError(e: unknown): { code: SyncErrorCode; message: string } {
  if (e instanceof OnelapError) {
    return { code: e.code === 'auth' ? 'auth' : 'other', message: e.message };
  }
  return { code: 'other', message: e instanceof Error ? e.message : String(e) };
}

const NO_ACCOUNT = { code: 'no_account', message: '' } as const;

let running: Promise<SyncOutcome> | null = null;

/** 进行中的同步直接复用同一 Promise（前台自动与手动点击撞车时防双跑） */
export function runOnelapSync(): Promise<SyncOutcome> {
  if (!running) {
    running = runSyncOnce().finally(() => {
      running = null;
    });
  }
  return running;
}

async function runSyncOnce(): Promise<SyncOutcome> {
  const account = await getOnelapAccount();
  if (!account) {
    return { imported: 0, skipped: 0, duplicates: 0, failed: 0, error: { ...NO_ACCOUNT }, failureFloor: null };
  }

  // 同步保活（2026-10-13，decisions §15 壳复用）：首次 90 天全量是分钟级任务（逐活动
  // 2 个请求 + 300–800ms jitter），期间 dataSync 前台服务使进程不被 Cached Apps Freezer
  // 冻结，退后台/锁屏同步照常推进。与 AI 生成共用同一 FGS/引用计数：并发时只发一次
  // start、共用一条通知（文案以先到者为准，release 只删自己的令牌不会误停对方）。
  // 15 分钟 wake lock 硬上限只影响 CPU 保活，FGS 本身无时限（Android 15 dataSync
  // 6h/天额度远够），超长同步仍受冻结保护。放在账号校验之后——fast-fail 不闪通知。
  let keepAlive: KeepAliveHandle | null = null;
  try {
    const lang = await getLang();
    keepAlive = await acquireGenerationKeepAlive({
      title: t(lang, 'sync.keepalive_title'),
      body: t(lang, 'sync.keepalive_body'),
      channel: t(lang, 'sync.keepalive_channel'),
    });

    const state = await getSyncState();
    const outcome = await pullActivities(account, state);
    const err = outcome.error;
    // 水位线推进锚点：正常→当前时刻；有失败活动→最旧失败活动时间（下次窗口重试，
    // 成功项按文件名幂等跳过）；本轮出错（未拉到列表）→不动
    const nextSyncAt = err
      ? state.last_sync_at
      : outcome.failureFloor ?? new Date().toISOString();
    const next: SyncState = {
      ...state,
      last_sync_at: nextSyncAt,
      last_result: err ? 'error' : 'ok',
      last_error: err?.message || null,
      last_counts: err
        ? state.last_counts
        : {
            imported: outcome.imported,
            skipped: outcome.skipped,
            duplicates: outcome.duplicates,
            failed: outcome.failed,
          },
    };
    await setSyncState(next);
    return outcome;
  } finally {
    await keepAlive?.release();
  }
}

/** 联调端点覆盖（EXPO_PUBLIC_ONELAP_BASE 打包期内联；生产构建不设即为 undefined） */
function endpointOverrides(): { login: string; rideRecord: string } | undefined {
  const base = process.env.EXPO_PUBLIC_ONELAP_BASE;
  return base ? { login: `${base}/api/login`, rideRecord: `${base}/api/otm/ride_record` } : undefined;
}

/** 当前生效的联调端点（无覆盖返回 null）——UI 据此显式提示，防止把联调包当生产包用 */
export function onelapOverrideBase(): string | null {
  return process.env.EXPO_PUBLIC_ONELAP_BASE || null; // 空串按无覆盖（与 endpointOverrides 同为 falsy 判定）
}

/** 应用侧客户端工厂（fetch/md5/随机数绑定 expo 实现；端点与超时口径集中在此） */
async function buildClient() {
  return createOnelapClient({
    fetchImpl: await loadDefaultFetch(),
    md5Hex: (s) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, s),
    randomBytes: (n) => Crypto.getRandomBytes(n),
    baseUrlOverrides: endpointOverrides(),
  });
}

/** 「测试连接」：探测登录域与数据域的可达性（不含凭据，纯链路验证） */
export async function probeOnelapEndpoints(): Promise<ProbeResult[]> {
  const [fetchImpl, origins] = await Promise.all([
    loadDefaultFetch(),
    Promise.resolve(endpointOrigins(endpointOverrides())),
  ]);
  return Promise.all(origins.map((origin) => probeEndpoint(origin, { fetchImpl })));
}

/**
 * 登录 + 拉取 + 入库；逐活动失败仅计数不中断（口径），鉴权失败终止本轮。
 * 会话：优先复用缓存 token，401 时清缓存→重登一次→重试原请求（只重试一次）。
 */
async function pullActivities(account: OnelapAccount, state: SyncState): Promise<SyncOutcome> {
  const client = await buildClient();

  // 会话就绪：先用缓存 token（无则密码登录）
  let session: OnelapSession;
  try {
    const cached = await readCachedSession();
    if (cached && cached.account === account.account.trim()) {
      session = { token: cached.token, uid: cached.uid };
      console.log('顽鹿同步：复用缓存会话（无需密码登录）');
    } else {
      session = await client.login(account.account, account.password);
      await writeCachedSession(account.account.trim(), session);
    }
  } catch (e) {
    return { imported: 0, skipped: 0, duplicates: 0, failed: 0, error: toError(e), failureFloor: null };
  }

  /** 带一次自动重登的调用：仅在 auth 错误时清缓存重登重试，其余错误原样抛出 */
  const withAuthRetry = async <T>(fn: (s: OnelapSession) => Promise<T>): Promise<T> => {
    try {
      return await fn(session);
    } catch (e) {
      if (!(e instanceof OnelapError) || e.code !== 'auth') throw e;
      console.warn('顽鹿会话失效（401），清缓存并重新登录一次');
      await clearCachedSession();
      session = await client.login(account.account, account.password);
      await writeCachedSession(account.account.trim(), session);
      return fn(session);
    }
  };

  // 窗口起点：水位线前移 24h 缓冲，但不早于「最近 SYNC_WINDOW_DAYS 天」（首次同步
  // 与长期未同步都截断——只回溯 3 个月，降低抓取观感，见 onelap.syncWindowStart）
  const since = syncWindowStart(state.last_sync_at);

  let cloudList;
  try {
    cloudList = await withAuthRetry((s) => client.listSince(s, since));
  } catch (e) {
    return { imported: 0, skipped: 0, duplicates: 0, failed: 0, error: toError(e), failureFloor: null };
  }

  const existing = new Set(await listActivityFileNames());
  const outcome: SyncOutcome = { imported: 0, skipped: 0, duplicates: 0, failed: 0, error: null, failureFloor: null };
  for (const [i, act] of cloudList.entries()) {
    // 活动之间随机等待 300–800ms：摊平请求突发（每个活动要发 2 个请求）
    if (i > 0) await sleep(jitterDelayMs());
    try {
      const key = await withAuthRetry((s) => client.getFitKey(s, act.id));
      const fileName = extractFitFileName(key, act.id);
      if (existing.has(fileName)) {
        // 文件名预检命中即跳过（省下载）：绝大多数情况下就是本活动的历史副本。
        // 已知边界：若「本地同名的其实是另一趟骑行」（云 fileKey 与手动命名的碰撞，
        // 真实 fileKey 自带日期时间戳故概率极低），该云活动会被静默跳过——打日志留痕，
        // 不做自动改名的导入（同名入库会 upsert 覆盖掉本地那条，宁可漏也不毁数据）。
        console.warn(`顽鹿活动 ${act.id}：文件名 ${fileName} 本地已存在，按重复跳过（未校验内容）`);
        outcome.skipped += 1;
        continue;
      }
      const { bytes, fileName: normalized } = await withAuthRetry((s) => client.downloadByKey(s, key, act.id));
      const { duplicateOf } = await importFitBytes(bytes, normalized);
      if (duplicateOf) {
        // 内容指纹命中（多为先前手动导入过同一趟骑行）：计重复。注意 existing 是每轮从库里
        // 重建的，这里不能 add——那个名字并没有入库，add 到本轮集合只会让**同一轮里**
        // 后续算出同名文件的另一个活动被上面那条预检静默跳过（跨轮去重只能靠内容指纹，
        // 代价是该活动每次同步都重新下载 + 解析一次，换取不丢活动）
        outcome.duplicates += 1;
        continue;
      }
      existing.add(normalized);
      outcome.imported += 1;
    } catch (e) {
      if (e instanceof OnelapError && e.code === 'auth') {
        return { ...outcome, error: toError(e) };
      }
      outcome.failed += 1;
      // 记录最旧失败活动时间，作为本轮水位线锚点（下次窗口覆盖重试）
      const failedAt = parseRideTime(act.start_riding_time);
      if (failedAt && (!outcome.failureFloor || failedAt < new Date(outcome.failureFloor))) {
        outcome.failureFloor = failedAt.toISOString();
      }
      console.warn(`顽鹿活动 ${act.id} 同步失败（跳过继续）:`, e);
    }
  }
  return outcome;
}

let lastAutoAttempt = 0;

/**
 * 前台自动同步（根布局 AppState active 时调用）：已配置账号 + 开关开启 + 距上次
 * 尝试 ≥1h 才拉；一切失败静默（console.warn），不影响应用使用。
 */
export async function maybeAutoSync(): Promise<void> {
  try {
    const [account, state] = await Promise.all([getOnelapAccount(), getSyncState()]);
    if (!account || !state.auto) return;
    if (state.last_sync_at && Date.now() - new Date(state.last_sync_at).getTime() < AUTO_THROTTLE_MS) return;
    if (Date.now() - lastAutoAttempt < AUTO_THROTTLE_MS) return;
    lastAutoAttempt = Date.now();
    await runOnelapSync();
  } catch (e) {
    console.warn('顽鹿自动同步失败（忽略）:', e);
  }
}

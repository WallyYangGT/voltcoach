/**
 * syncOnelap.ts — 顽鹿云同步编排（MIGRATION_PLAN §10.4）
 *
 * 流程：读 SecureStore 账号 → 登录 → 云端列表（水位线增量：上次同步时间前移 24h
 * 防边界漏拉，首次全量）→ 逐活动查 fileKey 算文件名，本地已有的跳过（upsert 幂等
 * 去重口径的下载省略版）→ 未知活动下载 FIT 字节走 importFitBytes 入库 → 回写水位线
 * 与结果到 settings.sync。
 *
 * 取舍：token 不做持久缓存（§10.4「令牌缓存」的简化）——低频个人同步每次全新登录
 * 成本可忽略，免去 token 过期/失效分支；会话中途 401 视为账号失效终止本轮。
 * 自动同步：前台 AppState 触发（国内 ROM 后台限制多，打开时拉最可靠，§10.4），
 * 模块级 1h 节流；失败仅警告不中断应用。并发防双跑：进行中的同步共享同一 Promise。
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { loadDefaultFetch } from '@/ai/http';
import {
  getSyncState,
  listActivityFileNames,
  setSyncState,
  type SyncState,
} from '@/db';
import { importFitBytes } from './importFit';
import { createOnelapClient, extractFitFileName, OnelapError, parseRideTime, type OnelapSession } from '@/sync/onelap';

// SecureStore 键名（与 dbkey/aikey 同前缀口径）
const ONELAP_ACCOUNT_STORE = 'voltcoach.onelap.account';
const ONELAP_PASSWORD_STORE = 'voltcoach.onelap.password';

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

/** 保存/更新账号（password 传 null 表示清除整组凭据） */
export async function setOnelapAccount(account: string, password: string | null): Promise<void> {
  if (!account.trim() || !password) {
    await Promise.all([
      SecureStore.deleteItemAsync(ONELAP_ACCOUNT_STORE),
      SecureStore.deleteItemAsync(ONELAP_PASSWORD_STORE),
    ]);
    return;
  }
  await SecureStore.setItemAsync(ONELAP_ACCOUNT_STORE, account.trim());
  await SecureStore.setItemAsync(ONELAP_PASSWORD_STORE, password);
}

/** 单轮同步结果（UI 展示 imported/skipped/failed 三计数；error 按稳定码映射 i18n） */
export type SyncErrorCode = 'no_account' | 'auth' | 'other';

export interface SyncOutcome {
  imported: number;
  skipped: number;
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
    return { imported: 0, skipped: 0, failed: 0, error: { ...NO_ACCOUNT }, failureFloor: null };
  }

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
    last_counts: err ? state.last_counts : { imported: outcome.imported, skipped: outcome.skipped, failed: outcome.failed },
  };
  await setSyncState(next);
  return outcome;
}

/** 登录 + 拉取 + 入库；逐活动失败仅计数不中断（§10.4 口径），鉴权失败终止本轮 */
async function pullActivities(account: OnelapAccount, state: SyncState): Promise<SyncOutcome> {
  const client = createOnelapClient({
    fetchImpl: await loadDefaultFetch(),
    md5Hex: (s) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, s),
    randomBytes: (n) => Crypto.getRandomBytes(n),
  });

  let session: OnelapSession;
  try {
    session = await client.login(account.account, account.password);
  } catch (e) {
    return { imported: 0, skipped: 0, failed: 0, error: toError(e), failureFloor: null };
  }

  // 水位线：上次同步时间前移 24h（跨设备时区/时钟偏差缓冲）；首次同步全量
  const since = state.last_sync_at
    ? new Date(new Date(state.last_sync_at).getTime() - 24 * 3600 * 1000)
    : null;

  let cloudList;
  try {
    cloudList = await client.listSince(session, since);
  } catch (e) {
    return { imported: 0, skipped: 0, failed: 0, error: toError(e), failureFloor: null };
  }

  const existing = new Set(await listActivityFileNames());
  const outcome: SyncOutcome = { imported: 0, skipped: 0, failed: 0, error: null, failureFloor: null };
  for (const act of cloudList) {
    try {
      const key = await client.getFitKey(session, act.id);
      const fileName = extractFitFileName(key, act.id);
      if (existing.has(fileName)) {
        outcome.skipped += 1;
        continue;
      }
      const { bytes, fileName: normalized } = await client.downloadByKey(session, key, act.id);
      await importFitBytes(bytes, normalized);
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

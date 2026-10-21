/**
 * prefs.ts — 轻量偏好域（settings 表离散键行）
 *
 * 界面语言（lang，AI 提示词缺省取此值）、云同步状态（sync，M4；2026-10-16 多平台化）、
 * AI 调整披露条已读锚（adjust_notice_seen:<kind>）。账号密码/令牌不进库（与 AI Key
 * 同级敏感），存 SecureStore 由服务层管理；sync 行形状（当前生效平台 + 各平台分槽的
 * 水位线/计数）与旧行兼容归一化都在 src/sync/state.ts——M4 的单平台扁平行会被自动
 * 读成顽鹿的槽位，老用户水位线不丢。
 */

import { getDb } from './client';
import type { Lang } from '@/core/i18n';
import {
  DEFAULT_SYNC_STATE,
  normalizeSyncState,
  type ProviderSyncState,
  type SyncCounts,
  type SyncProviderId,
  type SyncState,
} from '@/sync/state';

// ---------------- 界面语言（settings 表 lang 键，AI 提示词缺省取此值） ----------------

/** 当前界面语言（zh/en；无配置回落 zh）。前端 AsyncStorage 为先，库值供 AI 提示词缺省 */
export async function getLang(): Promise<Lang> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'lang'`,
  );
  return row ? (row.value === 'en' ? 'en' : 'zh') : 'zh';
}

/** 保存界面语言（仅认 zh/en，非法值抛 Error） */
export async function setLang(lang: Lang): Promise<Lang> {
  // 开发者向 invariant：lang 本身无效时词典不可用，只能用非本地化文案（勿改走 i18n）
  if (lang !== 'zh' && lang !== 'en') throw new Error(`Unsupported lang: ${lang} (zh/en only)`);
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('lang', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    lang,
  );
  return lang;
}

// ---------------- 云同步状态（settings 表 sync 键，M4；2026-10-16 多平台化） ----------------

/** 单平台同步进度 / 最近计数 / 平台标识（形状与归一化定义在 src/sync/state.ts，此处转发出口） */
export type { ProviderSyncState, SyncCounts, SyncState, SyncProviderId };
export { DEFAULT_SYNC_STATE };

/** 当前同步状态（无行/行损坏回落默认值；旧版扁平行自动归一化） */
export async function getSyncState(): Promise<SyncState> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'sync'`,
  );
  if (!row) return { ...DEFAULT_SYNC_STATE };
  try {
    return normalizeSyncState(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_SYNC_STATE };
  }
}

/** 保存同步状态（调用方整行覆盖写） */
export async function setSyncState(state: SyncState): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('sync', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(state),
  );
}

// ---------------- AI 调整披露条已读锚（settings 松散 KV 行，一次性披露） ----------------
//
// 计划/FTP 的调整披露条带撤销入口；用户看过且未撤销后不应永久常驻。锚 = 该次调整的
// 稳定身份（计划版 StoredPlan.created_at / FTP 快照 updated_at）：新调整 → 新锚 →
// 重新披露一次；每类只保留最近一次，不随历史增长。锚只存最近一次：连续调整后撤销
// 回更早的调整版时可能再披露一次——与「撤销可换回」的既有语义一致（严格每版只披露
// 一次需存有界 seen 集合，当前不做）。沿 ai_ftp_update 快照先例走 settings JSON 行
// ——不加列、不动 SCHEMA_VERSION，备份整库拷贝透明携带。

/** 一次性披露条类型（与组件 useAdjustNoticeVisible 的 kind 对应） */
export type AdjustNoticeKind = 'plan_adjust' | 'ftp_update';

const ADJUST_NOTICE_SEEN_PREFIX = 'adjust_notice_seen:';

/** 读某类披露条的已读锚（等于当前调整身份即不再展示；无行/损坏返回 null） */
export async function getAdjustNoticeSeen(kind: AdjustNoticeKind): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    ADJUST_NOTICE_SEEN_PREFIX + kind,
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { identity?: unknown };
    return typeof parsed?.identity === 'string' ? parsed.identity : null;
  } catch {
    return null; // 行损坏按未读处理，下次展示后覆盖写入自愈
  }
}

/** 记某类披露条已读锚（单行 upsert，两类各一行，无读改写竞态；空锚不写） */
export async function markAdjustNoticeSeen(
  kind: AdjustNoticeKind,
  identity: string,
): Promise<void> {
  if (!identity) return; // 损坏版本的空身份不标记，避免把异常态误判成已读
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ADJUST_NOTICE_SEEN_PREFIX + kind,
    JSON.stringify({ identity, seen_at: new Date().toISOString() }),
  );
}

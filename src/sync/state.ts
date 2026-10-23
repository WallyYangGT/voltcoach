/**
 * state.ts — 云同步状态（settings 表 'sync' 行的形状与归一化，2026-10-16 多平台化）
 *
 * 单平台时期（M4）该行是扁平的：{ auto, last_sync_at, last_result, last_error,
 * last_counts }。多平台化后升级为「按平台分槽」：
 *
 *   { provider: <当前生效平台>, auto, providers: { <id>: { last_sync_at, ... } } }
 *
 * 分槽的理由：水位线（last_sync_at）必须按平台各存一份——切换生效平台再切回来时
 * 不该重新拉 90 天。`provider` 是「当前生效平台」（单账户互斥），`auto` 是全局开关。
 *
 * **兼容**：旧版本写的扁平行由 normalizeSyncState 归一化成 onelap 的槽位（老用户
 * 升级后水位线与计数不丢）；反向（新行被旧版本读到）旧代码只会看到「从未同步」，
 * 无破坏。本模块是纯函数（不 import RN/Expo/db），node:test 直接覆盖。
 */

/** 云同步平台标识（凭据命名空间 / 状态槽位 / UI 下拉 都用它） */
export type SyncProviderId = 'onelap' | 'igpsport-cn' | 'igpsport-intl' | 'wahoo';

/** 全部平台（顺序即 UI 下拉顺序；默认项在最前） */
export const SYNC_PROVIDER_IDS: readonly SyncProviderId[] = [
  'onelap',
  'igpsport-cn',
  'igpsport-intl',
  'wahoo',
];

/** 默认生效平台（出厂 / 旧数据迁移的落点） */
export const DEFAULT_SYNC_PROVIDER: SyncProviderId = 'onelap';

/** 最近一轮同步计数（duplicates 可选：M5 前的旧行没有该字段，读侧按 ??0 兜底） */
export interface SyncCounts {
  imported: number;
  skipped: number;
  failed: number;
  duplicates?: number;
}

/** 单平台的同步进度（水位线 + 最近结果） */
export interface ProviderSyncState {
  /**
   * 水位线：增量拉取的窗口边界（上次拉到**非空**窗口的时刻，ISO）；null = 从未同步。
   * 空窗轮冻结不推进、失败轮保位（decisions §37）——「上次同步时间」的展示职责已移交
   * last_run_at，本字段只反映增量边界。
   */
  last_sync_at: string | null;
  /**
   * 展示用：上次**实际跑过**同步的时刻（ISO）。
   * 与水位线分叉的场景：空窗轮水位线冻结（2026-10 顽鹿增量失效事故的防御——列表异常
   * 回空时推进水位线会把缺口永久藏住）、失败轮水位线保位。可选：本字段引入（2026-10-23）
   * 之前的行都没有该字段，读侧回退 last_sync_at。
   */
  last_run_at?: string | null;
  last_result: 'ok' | 'error' | null;
  last_error: string | null;
  last_counts: SyncCounts | null;
}

/** 同步配置与最近结果（settings 表 'sync' 单行 JSON） */
export interface SyncState {
  /** 当前生效平台（单账户互斥：只有它会自动同步） */
  provider: SyncProviderId;
  /** 前台自动同步开关（全局，不分平台） */
  auto: boolean;
  /** 各平台独立的水位线与最近结果（未同步过的平台没有槽位） */
  providers: Partial<Record<SyncProviderId, ProviderSyncState>>;
}

/** 共享空态（冻结：读侧会直接把它当返回值发出去，别让某处手滑就地改到） */
export const EMPTY_PROVIDER_STATE: ProviderSyncState = Object.freeze({
  last_sync_at: null,
  last_run_at: null,
  last_result: null,
  last_error: null,
  last_counts: null,
});

export const DEFAULT_SYNC_STATE: SyncState = Object.freeze({
  provider: DEFAULT_SYNC_PROVIDER,
  auto: true,
  // 冻结 + 读侧一律浅拷贝：providers 是共享引用，别让某处就地写进去
  providers: Object.freeze({}) as SyncState['providers'],
});

function isProviderId(v: unknown): v is SyncProviderId {
  return typeof v === 'string' && (SYNC_PROVIDER_IDS as readonly string[]).includes(v);
}

/** 非负整数（脏数据/负数/NaN 一律归 0） */
function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 单个平台槽位的宽容读（字段缺失/类型不对走空值） */
function normalizeSlot(raw: Record<string, unknown>): ProviderSyncState {
  const slot: ProviderSyncState = { ...EMPTY_PROVIDER_STATE };
  if (typeof raw.last_sync_at === 'string') slot.last_sync_at = raw.last_sync_at;
  if (typeof raw.last_run_at === 'string') slot.last_run_at = raw.last_run_at;
  if (raw.last_result === 'ok' || raw.last_result === 'error') slot.last_result = raw.last_result;
  if (typeof raw.last_error === 'string') slot.last_error = raw.last_error;
  const c = raw.last_counts;
  if (c && typeof c === 'object') {
    const src = c as Record<string, unknown>;
    slot.last_counts = {
      imported: count(src.imported),
      skipped: count(src.skipped),
      failed: count(src.failed),
      ...(src.duplicates === undefined ? {} : { duplicates: count(src.duplicates) }),
    };
  }
  return slot;
}

/**
 * settings 行 → SyncState（唯一读入口）。三种输入都有确定行为：
 *  - 新版行（有 providers 对象）：逐槽位归一化，未知平台 id 丢弃；
 *  - 旧扁平行（无 providers）：顶层字段即 onelap 的槽位（水位线不丢）；
 *  - 空/损坏/非对象：出厂默认。
 */
export function normalizeSyncState(raw: unknown): SyncState {
  const out: SyncState = { provider: DEFAULT_SYNC_PROVIDER, auto: true, providers: {} };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.auto === 'boolean') out.auto = obj.auto;
  if (isProviderId(obj.provider)) out.provider = obj.provider;
  const providers = obj.providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const map = providers as Record<string, unknown>;
    for (const id of SYNC_PROVIDER_IDS) {
      const slot = map[id];
      if (slot && typeof slot === 'object') out.providers[id] = normalizeSlot(slot as Record<string, unknown>);
    }
    return out;
  }
  // 旧扁平行：顶层即 onelap 槽位。仅当行里真有同步痕迹才落槽，避免把全新默认行也写成槽位
  if (
    obj.last_sync_at !== undefined ||
    obj.last_result !== undefined ||
    obj.last_error !== undefined ||
    obj.last_counts !== undefined
  ) {
    out.providers[DEFAULT_SYNC_PROVIDER] = normalizeSlot(obj);
  }
  return out;
}

/** 读某平台的槽位（无槽位返回空态，不写库） */
export function providerState(state: SyncState, id: SyncProviderId): ProviderSyncState {
  return state.providers[id] ?? EMPTY_PROVIDER_STATE;
}

/** 写某平台的槽位（返回新对象，原对象不动） */
export function withProviderState(
  state: SyncState,
  id: SyncProviderId,
  patch: Partial<ProviderSyncState>,
): SyncState {
  return { ...state, providers: { ...state.providers, [id]: { ...providerState(state, id), ...patch } } };
}

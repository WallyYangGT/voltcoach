/**
 * notify.ts — 数据失效事件总线（架构评审 A3：写后发事件，取代「每个入口都记得重查」）
 *
 * 背景：拆分前 UI 一致性全靠「回焦点全量重查」（17 处 useFocusEffect + 3 处 1.5s
 * 轮询）维持，任何写入口漏了约定就停在旧值——已确认的漏刷路径：云同步后台批量
 * 导入（首页可能正停在屏幕上）、设置页改 FTP（首页 hero 瓦片）、AI 对话内写工具
 * （set_power_flag/reanalyze/ftp_apply 后详情页主 summary 不随 focus 重查）、
 * 备份导入整库替换。
 *
 * 机制：db 域写函数在成功路径发域事件（`invalidateDb(domain, uuid?)`），页面订阅
 * 关心的域，收到即重取。**既有刷新路径全部保留作兜底**——本机制是叠加而非替换，
 * 最坏情形只是多查一次本地 SQLite（毫秒级），无数据风险。
 *
 * 三条纪律：
 *  1. **listener 不得写库**——否则 A 写发事件 → B 重取 → B 写库 → 死循环。需要
 *     写库的响应放编排层（service），不要在订阅回调里做。
 *  2. 通知是**合并式**的：同一 tick 内多次写只冲刷一轮（批量导入 N 条不通知 N 次），
 *     payload 里累积受影响的活动 uuid 供 aiTitle 这类按行失效的订阅方使用。
 *  3. listener 抛错被吞掉并告警——一个页面的重取失败不能拖垮其他订阅方与写路径。
 *
 * 无平台/React 依赖（纯 JS），node:test 可直测；React 侧装配见
 * src/components/useDbInvalidation.ts。
 */

/** 受影响的业务域（与 src/db 下的域文件一一对应） */
export type DbDomain =
  | 'activities'
  | 'athlete'
  | 'profile'
  | 'reports'
  | 'chats'
  | 'memories'
  | 'dossier'
  | 'plans'
  | 'prefs'
  | 'aiconfig';

/** 全部域（invalidateAllDb 遍历用；新增域时在此追加） */
const ALL_DOMAINS: readonly DbDomain[] = [
  'activities',
  'athlete',
  'profile',
  'reports',
  'chats',
  'memories',
  'dossier',
  'plans',
  'prefs',
  'aiconfig',
];

/** 一次冲刷交付给订阅方的失效事实 */
export interface DbInvalidation {
  /** 本批受影响的域（已去重） */
  domains: ReadonlySet<DbDomain>;
  /**
   * 受影响的单个活动 uuid（行级失效用：标题/起骑时刻缓存按行清）。
   * **空数组 = 域级/整库级变更**，订阅方必须放弃按行过滤、做全量重取。
   * 整库失效（备份导入换库）与行级写同批合并时，这里一律清空（见 pendingAll）。
   */
  activityUuids: readonly string[];
}

type Listener = (ev: DbInvalidation) => void;

const listeners = new Set<Listener>();

/** 待冲刷的累积状态（queueMicrotask 合并同一 tick 的多次写） */
let pendingDomains = new Set<DbDomain>();
let pendingUuids = new Set<string>();
/**
 * 本批含整库失效（备份导入换库）。**与行级写同批合并时必须压掉 uuid**：
 * 否则 (a) 按 uuid 过滤的订阅方（详情页）会把整库变更误判成「别的骑行变了」而跳过重取；
 * (b) aiTitle 只清那几个 uuid 的起骑时刻，其余活动继续用旧库的缓存（标题/本地日错误）。
 */
let pendingAll = false;
let flushScheduled = false;

const EMPTY_INVALIDATION: DbInvalidation = {
  domains: new Set(),
  activityUuids: [],
};

function flush(): void {
  flushScheduled = false;
  if (!pendingDomains.size && !pendingUuids.size) return;
  const ev: DbInvalidation = {
    domains: pendingDomains,
    activityUuids: pendingAll ? [] : [...pendingUuids],
  };
  pendingDomains = new Set();
  pendingUuids = new Set();
  pendingAll = false;
  // listener 抛错不影响其他订阅方，更不影响调用方的写操作结果
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch (e) {
      console.warn('db 失效订阅回调失败（已忽略，不影响写入）:', e);
    }
  }
}

/**
 * 发失效事件（db 写函数的成功路径调用）。
 * @param domain 受影响的域
 * @param activityUuid 行级变更时传（标题缓存等按行失效的订阅方用）；域级变更省略
 */
export function invalidateDb(domain: DbDomain, activityUuid?: string): void {
  pendingDomains.add(domain);
  if (activityUuid) pendingUuids.add(activityUuid);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/** 全部域失效（备份导入整库替换：数据全换，任何缓存都不可信） */
export function invalidateAllDb(): void {
  for (const d of ALL_DOMAINS) pendingDomains.add(d);
  pendingAll = true;
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

/**
 * 订阅失效事件，返回退订函数（React 侧在 effect cleanup 调用）。
 * 通知在微任务里合并冲刷——订阅后同一 tick 内的写会在本 tick 末交付一次。
 */
export function subscribeDbInvalidation(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 清空订阅与待冲刷状态（仅供测试：模块级单例，测试间需重置防串味）。
 * 生产代码不得调用——清订阅会让已挂载页面失去通知。
 */
export function resetDbInvalidationForTesting(): void {
  listeners.clear();
  pendingDomains = new Set();
  pendingUuids = new Set();
  pendingAll = false;
  flushScheduled = false;
}

/** 空失效事件（订阅方可作为「无匹配域」的安全默认值） */
export const EMPTY_DB_INVALIDATION = EMPTY_INVALIDATION;

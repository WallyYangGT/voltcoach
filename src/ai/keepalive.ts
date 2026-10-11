/**
 * keepalive.ts — AI 生成期间的前台服务保活壳（令牌制引用计数 + 操作队列）。
 *
 * 为什么需要（2026-10-11 推翻决策「不做前台服务保活」，见 docs-private/decisions.md）：
 * App 退后台后进程进入 Android「cached」桶，Android 12+ 的 Cached Apps Freezer 会
 * 冻结整个进程——JS 线程与网络全部停摆，LLM 的 SSE 流式响应收不到。生成期间启动
 * dataSync 前台服务使进程脱离 cached 桶不被冻结，流式请求继续跑在主 JS runtime，
 * UI state 全程连续，回前台即见结果。
 *
 * 设计：
 * - **令牌制引用计数**：acquire 返回释放句柄（release 只删自己的令牌）——未配对/
 *   重复 release 是 no-op，不可能偷走其它任务的引用（code-review P1-2：全局计数器
 *   下 fast-fail 任务的 finally release 会把并发任务的保活停掉）。
 * - **操作队列串行化**（`opChain = opChain.then(op)`）：start/stop 全部入队按序执行，
 *   「是否还有人持有」的判断在队列内做——release 的 await 窗口里新 acquire 不会被
 *   旧 release 的 stop 误杀（code-review P1-3：全局 pendingStart 串行化存在交错窗口）。
 *   start 只在「队列内看到自己是唯一持有者」时发（N 任务共用一次启动、一条通知）。
 * - 失败一律降级不抛错：保活是增强能力，任何失败退回「前台等待」现状行为，
 *   生成任务本身不受影响。
 * - impl 可注入（node:test），默认经惰性动态 import 取本地原生模块
 *   modules/generation-keepalive——node 环境或 iOS 上解析失败整体 no-op（同
 *   src/ai/http.ts loadDefaultFetch 口径；**缓存 promise 而非值**，装载在途的并发
 *   调用共享同一结果，不会拿到假 null，code-review P2-1）。本文件不设任何 RN/Expo
 *   顶层依赖，可被 node:test 直测。
 */

/** 保活实现形状（modules/generation-keepalive 默认导出的投影；node:test 注入 spy 用） */
export interface KeepAliveImpl {
  start(title: string, body: string, channelName: string): Promise<boolean> | boolean;
  stop(): Promise<boolean> | boolean;
  /** Android 13+ 通知权限申请（fire-and-forget，模块内部自带 once 口径），可缺省 */
  ensureNotificationPermission?: () => Promise<void>;
  /** 是否已在电池优化白名单内（同步），可缺省 */
  isIgnoringBatteryOptimizations?: () => boolean;
  /** 弹系统框申请电池白名单，可缺省 */
  requestIgnoreBatteryOptimizations?: () => Promise<boolean>;
  /** 通知权限是否已授予（设置页状态行用），可缺省 */
  areNotificationsEnabled?: () => boolean;
}

/** 启动保活所需的文案（调用方按语言取好：通知标题/正文 + 通知渠道名） */
export interface KeepAliveText {
  title: string;
  body: string;
  channel: string;
}

/** 释放句柄：acquire 的配对产物，release 只作用于自己的那次 acquire */
export interface KeepAliveHandle {
  release(): Promise<void>;
}

/** 持有者令牌集合（队列内读写）与 start/stop 串行化链 */
const holders = new Set<symbol>();
let opChain: Promise<void> = Promise.resolve();
let implPromise: Promise<KeepAliveImpl | null> | null = null;

/** 原生模块装载：iOS（未链接）与 node:test 环境下 import 抛错 → 永久 no-null。
 *  缓存 promise：装载在途时并发调用共享同一结果（不会拿到假 null） */
function loadImpl(): Promise<KeepAliveImpl | null> {
  implPromise ??= (async (): Promise<KeepAliveImpl | null> => {
    try {
      const mod = (await import('../../modules/generation-keepalive/src/index.ts')) as {
        default?: KeepAliveImpl;
      };
      return mod?.default ?? null;
    } catch {
      return null;
    }
  })();
  return implPromise;
}

/** 入队一个串行化操作；链上任何异常都不中断后续操作（降级口径） */
function enqueue(op: () => Promise<void>): Promise<void> {
  const run = opChain.then(op, op); // 前序失败也继续执行本操作
  opChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * 进入一段生成任务：返回配对的释放句柄。首个入队的 acquire 在队列内看到自己是
 * 唯一持有者时启动前台服务；后续并发 acquire 仅记令牌。永不抛错（含 impl 缺失/
 * 启动失败——都只是不保活）。text 传 i18n 后的文案。
 */
export async function acquireGenerationKeepAlive(text: KeepAliveText): Promise<KeepAliveHandle> {
  const token = Symbol('keepalive-holder');
  await enqueue(async () => {
    holders.add(token);
    if (holders.size > 1) return; // 已有任务在保活，共用同一条通知
    const i = await loadImpl();
    if (!i) return;
    // 通知权限（Android 13+）：fire-and-forget，拒绝不影响 FGS 运行，绝不阻塞生成
    void i.ensureNotificationPermission?.().catch(() => {});
    try {
      const ok = await i.start(text.title, text.body, text.channel);
      if (!ok) console.warn('[keepalive] 前台服务启动未成功，本次生成退回「前台等待」行为');
    } catch (e) {
      console.warn('[keepalive] 前台服务启动失败，本次生成退回「前台等待」行为:', e);
    }
  });
  return {
    release: () =>
      enqueue(async () => {
        if (!holders.delete(token)) return; // 未配对/重复 release：no-op（不偷别人的引用）
        if (holders.size > 0) return; // 还有其它任务持有着
        const i = await loadImpl();
        if (!i) return;
        try {
          await i.stop();
        } catch (e) {
          console.warn('[keepalive] 前台服务停止失败:', e);
        }
      }),
  };
}

/** 是否已在电池优化白名单内（设置页状态行用；impl 不可用/查询失败一律 false） */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  const i = await loadImpl();
  if (!i?.isIgnoringBatteryOptimizations) return false;
  try {
    return i.isIgnoringBatteryOptimizations() === true;
  } catch {
    return false;
  }
}

/** 弹系统确认框申请电池优化白名单；false = 已在内/无法弹窗（部分 ROM 不支持） */
export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  const i = await loadImpl();
  if (!i?.requestIgnoreBatteryOptimizations) return false;
  try {
    return (await i.requestIgnoreBatteryOptimizations()) === true;
  } catch {
    return false;
  }
}

/** 通知权限是否已授予（设置页状态行用；impl 不可用/查询失败一律 false） */
export async function areNotificationsEnabled(): Promise<boolean> {
  const i = await loadImpl();
  if (!i?.areNotificationsEnabled) return false;
  try {
    return i.areNotificationsEnabled() === true;
  } catch {
    return false;
  }
}

/**
 * 测试钩子：重置全部模块级状态并直接注入 impl（null = 模拟「原生模块不可用」）。
 * opts.loaderUnresolved = true 时把装载器也退回未解析态——下一次 acquire 会走
 * 真实动态 import 路径（node:test 里必然失败，用于覆盖 loadImpl 的兜底分支）。
 */
export function resetKeepAliveForTests(
  nextImpl: KeepAliveImpl | null,
  opts?: { loaderUnresolved?: boolean },
): void {
  holders.clear();
  opChain = Promise.resolve();
  if (opts?.loaderUnresolved) {
    implPromise = null;
  } else {
    implPromise = Promise.resolve(nextImpl);
  }
}

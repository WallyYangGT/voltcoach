/**
 * keepalive.ts — AI 生成期间的前台服务保活壳（引用计数）。
 *
 * 为什么需要（2026-10-11 推翻决策「不做前台服务保活」，见 docs-private/decisions.md）：
 * App 退后台后进程进入 Android「cached」桶，Android 12+ 的 Cached Apps Freezer 会
 * 冻结整个进程——JS 线程与网络全部停摆，LLM 的 SSE 流式响应收不到。生成期间启动
 * dataSync 前台服务使进程脱离 cached 桶不被冻结，流式请求继续跑在主 JS runtime，
 * UI state 全程连续，回前台即见结果。
 *
 * 设计：
 * - 纯引用计数壳：start/stop 只在首个 acquire / 最后一个 release 发生（并发多个
 *   报告/对话任务共用同一条通知）；impl 可注入（node:test），默认经惰性动态
 *   import 取本地原生模块 modules/generation-keepalive——node 环境或 iOS 上解析
 *   失败整体 no-op（同 src/ai/http.ts loadDefaultFetch 口径，本文件因此不设任何
 *   RN/Expo 顶层依赖，可被 node:test 直测）。
 * - 失败一律降级不抛错：保活是增强能力，任何失败退回「前台等待」现状行为，
 *   生成任务本身不受影响。
 * - start 与 stop 串行化：极短任务在 start 落定前 release 时，等 start 结束再
 *   stop——避免 Android 上「startForegroundService 已排队、stopService 先到」
 *   导致服务未及 startForeground 的崩溃面。
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
}

/** 启动保活所需的文案（调用方按语言取好：通知标题/正文 + 通知渠道名） */
export interface KeepAliveText {
  title: string;
  body: string;
  channel: string;
}

let refs = 0;
let pendingStart: Promise<void> | null = null;
let impl: KeepAliveImpl | null = null;
let implResolved = false;

/** 原生模块装载：iOS（未链接）与 node:test 环境下 import 抛错 → 永久 no-op */
async function loadImpl(): Promise<KeepAliveImpl | null> {
  if (implResolved) return impl;
  implResolved = true;
  try {
    const mod = (await import('../../modules/generation-keepalive/src/index.ts')) as {
      default?: KeepAliveImpl;
    };
    impl = mod?.default ?? null;
  } catch {
    impl = null;
  }
  return impl;
}

/**
 * 进入一段生成任务：首个 acquire 启动保活前台服务；后续并发 acquire 仅计数。
 * 永不抛错（含 impl 缺失/启动失败——都只是不保活）。text 传 i18n 后的文案。
 */
export async function acquireGenerationKeepAlive(text: KeepAliveText): Promise<void> {
  refs += 1;
  if (refs > 1) return;
  const run = async (): Promise<void> => {
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
  };
  pendingStart = run();
  await pendingStart;
}

/**
 * 离开一段生成任务（成功/失败/超时都必须调用，一般放 finally）：最后一个
 * release 停止前台服务。refs 为 0 时调用是 no-op（防御：acquire 前的 fast-fail
 * 路径统一走 finally 时不会误停）。永不抛错。
 */
export async function releaseGenerationKeepAlive(): Promise<void> {
  if (refs === 0) return;
  refs -= 1;
  if (refs > 0) return;
  // start 尚未落定就 release：等它结束再停（串行化，见文件头注释）
  if (pendingStart) {
    await pendingStart.catch(() => {});
    pendingStart = null;
  }
  const i = await loadImpl();
  if (!i) return;
  try {
    await i.stop();
  } catch (e) {
    console.warn('[keepalive] 前台服务停止失败:', e);
  }
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

/**
 * 测试钩子：重置全部模块级状态并直接注入 impl（null = 模拟「原生模块不可用」）。
 * opts.loaderUnresolved = true 时把装载器也退回未解析态——下一次 acquire 会走
 * 真实动态 import 路径（node:test 里必然失败，用于覆盖 loadImpl 的兜底分支）。
 */
export function resetKeepAliveForTests(
  nextImpl: KeepAliveImpl | null,
  opts?: { loaderUnresolved?: boolean },
): void {
  refs = 0;
  pendingStart = null;
  if (opts?.loaderUnresolved) {
    impl = null;
    implResolved = false;
  } else {
    impl = nextImpl;
    implResolved = true;
  }
}

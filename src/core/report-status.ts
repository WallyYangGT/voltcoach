/**
 * report-status.ts — AI 报告/对话生成状态的纯判定（node:test 直测）。
 *
 * 1) 是否继续轮询（shouldPollReport）——2026-09-22 真机回归的形状：轮询条件只认
 *    `status === 'pending'`，于是「失败 → 点重试 → 重试成功写回 completed」这条
 *    路径上界面永不刷新——用户必须退出报告页再进来才能看到报告。追问/对话消息的
 *    "失败气泡 → 重试"是同一个坑（库状态仍是 failed、消息内容稍后才回写），故一并纳入。
 * 2) 残留生成是否落在自动续跑窗口内（withinResumeWindow）——M5：切后台进程被杀留下
 *    pending 占位，回前台时只自动补跑「刚被打断」的（窗口内），更早的维持进页面补跑
 *    的现状，避免为用户早已放弃的任务重复消耗 token。
 */
export interface ReportPollInput {
  /** 库里的报告状态（pending / failed / completed；无报告传 null） */
  status: string | null | undefined;
  /** 手动重试 / 重新生成已发起，任务尚未回写状态（此时库里仍是 failed） */
  retrying: boolean;
  /** 本报告有进程内生成任务在跑（含 pending 残留补跑） */
  taskRunning: boolean;
  /** 追问/对话线程里有生成中的消息（库状态 pending） */
  chatPending: boolean;
  /** 追问/对话线程里有重试中的消息（库状态仍是 failed，进程内有任务） */
  chatRunning: boolean;
}

/** 是否需要以 1.5s 节奏继续轮询本地 db 刷新界面 */
export function shouldPollReport({
  status,
  retrying,
  taskRunning,
  chatPending,
  chatRunning,
}: ReportPollInput): boolean {
  return status === 'pending' || retrying || taskRunning || chatPending || chatRunning;
}

/**
 * 解析 SQLite `datetime('now')` 产出的 UTC 无时区时间串（'YYYY-MM-DD HH:MM:SS'，
 * 补 Z 才能按 UTC 解析，口径同 useAiReport 的已等待时长）；ISO 带时间原样兼容。
 * 非法/空值返回 null。
 */
export function parseDbUtcTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 残留生成（pending 占位）是否落在自动续跑窗口内：age ∈ [0, maxAgeMs]。
 * created_at 在未来（设备时钟回拨等）视为不在窗口内，宁可让用户手动重试。
 */
export function withinResumeWindow(
  createdAt: string | null | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  const started = parseDbUtcTimestamp(createdAt);
  if (started == null) return false;
  const age = now - started;
  return age >= 0 && age <= maxAgeMs;
}

// ---------------- 增量落库节流（2026-10 SSE 增量落库） ----------------

/** 距上次落库至少新增这么多字才值得写一次 db（避免逐 token 打库） */
export const STREAM_FLUSH_MIN_CHARS = 200;
/** 距上次落库至少间隔这么久才写（生成中的 db 写频率上限 ≈ 每 2s 一次） */
export const STREAM_FLUSH_MIN_MS = 2000;

/**
 * 流式增量落库的节流判定：自上次落库以来新增字数与间隔同时过线才写。
 * 纯函数便于单测；完成/取消时的最终回写不走此判定（无条件全量落库）。
 */
export function shouldFlushPartial(charsSinceFlush: number, msSinceFlush: number): boolean {
  return charsSinceFlush >= STREAM_FLUSH_MIN_CHARS && msSinceFlush >= STREAM_FLUSH_MIN_MS;
}

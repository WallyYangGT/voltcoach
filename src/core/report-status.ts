/**
 * report-status.ts — AI 报告/对话"是否继续轮询"的判定（纯谓词，node:test 直测）。
 *
 * 2026-09-22 真机回归的形状：轮询条件只认 `status === 'pending'`，于是
 * 「失败 → 点重试 → 重试成功写回 completed」这条路径上界面永不刷新——用户必须退出
 * 报告页再进来才能看到报告。追问/对话消息的"失败气泡 → 重试"是同一个坑（库状态仍是
 * failed、消息内容稍后才回写），故一并纳入判定。判定属纯函数，放 core 里由单测守住。
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

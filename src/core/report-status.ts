/**
 * report-status.ts — AI 报告"是否继续轮询"的判定（纯谓词，node:test 直测）。
 *
 * 2026-09-22 真机回归的形状：轮询条件只认 `status === 'pending'`，于是
 * 「失败 → 点重试 → 重试成功写回 completed」这条路径上界面永不刷新——用户必须退出
 * 报告页再进来才能看到报告。判定条件属纯函数，放 core 里由单测守住，同名回归不再来。
 */
export interface ReportPollInput {
  /** 库里的报告状态（pending / failed / completed；无报告传 null） */
  status: string | null | undefined;
  /** 手动重试 / 重新生成已发起，任务尚未回写状态（此时库里仍是 failed） */
  retrying: boolean;
  /** 本报告有进程内生成任务在跑（含 pending 残留补跑） */
  taskRunning: boolean;
  /** 追问线程里还有生成中的消息 */
  chatPending: boolean;
}

/** 是否需要以 1.5s 节奏继续轮询本地 db 刷新界面 */
export function shouldPollReport({ status, retrying, taskRunning, chatPending }: ReportPollInput): boolean {
  return status === 'pending' || retrying || taskRunning || chatPending;
}

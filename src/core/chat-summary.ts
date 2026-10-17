/**
 * chat-summary.ts — 对话滚动摘要的纯逻辑（架构评审 E1：对话窗口化 + 滚动摘要）
 *
 * 持久化形状（settings 表 `chat_summary:<chatId>` JSON 行，无 schema 迁移，随备份迁移）：
 *   { shape, up_to_message_id, summary }
 *   - up_to_message_id：已被摘要覆盖的最后一条消息 id——下轮只把此 id 之后的
 *     增量消息与既有摘要一起送模型（滚动摘要，不重复概括全部历史）；
 *   - summary：模型生成的摘要正文（截到 CONTEXT_BUDGET.chat_summary_output_max_chars）。
 *
 * 触发与降级口径（编排层执行）：
 *   - 被窗口挤出的消息体量 ≥ chat_summary_trigger_chars 才值得调一次模型摘要，
 *     否则直接用 windowChatHistory 的确定性 digest（零 token）；
 *   - 模型调用失败/超时/空正文 → 回落 digest，主生成不受影响；
 *   - 摘要请求的输入逐条截 1500 字、总量截 chat_summary_input_max_chars。
 *
 * 纯函数、无 IO、无 i18n 依赖；node:test 直测。
 */

import { CONTEXT_BUDGET } from './settings.ts';

/** 摘要行的输入消息（db 行直接传入） */
export interface SummaryInputMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

/** settings 行的持久化形状 */
export interface ChatSummaryRecord {
  shape: number;
  /** 已被摘要覆盖的最后一条消息 id */
  up_to_message_id: number;
  summary: string;
}

export const CHAT_SUMMARY_SHAPE = 1;

/** 校验并归一 settings 行（损坏按无摘要处理，自愈路径：下次成功摘要会覆盖写入） */
export function parseChatSummary(raw: string | null | undefined): ChatSummaryRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ChatSummaryRecord;
    if (
      parsed?.shape === CHAT_SUMMARY_SHAPE &&
      Number.isInteger(parsed.up_to_message_id) &&
      parsed.up_to_message_id > 0 &&
      typeof parsed.summary === 'string' &&
      parsed.summary.trim()
    ) {
      return parsed;
    }
  } catch {
    // 行损坏按无摘要处理
  }
  return null;
}

/**
 * 是否值得为被挤出的消息调一次模型摘要：体量达到触发阈值。
 * omitted 消息须带 id（含 pending/failed 已被调用方过滤）。
 */
export function shouldSummarize(omitted: { content: string }[]): boolean {
  return omitted.reduce((n, m) => n + m.content.length, 0) >= CONTEXT_BUDGET.chat_summary_trigger_chars;
}

/**
 * 组装摘要请求的增量输入：只取 up_to 之后的消息，逐条截 1500 字，按**从最早未
 * 概括的消息开始连续装入**到 chat_summary_input_max_chars。
 *
 * ⚠️ 不能从最新往回保：水位线（up_to_message_id）只能推进到「实际送入摘要的最后
 * 一条」，若优先装最新的，较早的积压消息会被水位线永久跨过、再也不进摘要。
 * 连续前缀保证每次调用都推进一小段，多轮下来完整覆盖历史（积压大时下次继续）。
 */
export function buildSummaryInput(
  history: SummaryInputMessage[],
  upToMessageId: number,
): SummaryInputMessage[] {
  const delta = history.filter((m) => m.id > upToMessageId && m.content);
  const perMessage = 1500;
  const clipped = delta.map((m) => ({
    ...m,
    content: m.content.length > perMessage ? m.content.slice(0, perMessage) + '…' : m.content,
  }));
  let total = 0;
  const kept: SummaryInputMessage[] = [];
  for (const m of clipped) {
    // 首条即使超上限也收下（单条已截到 1500，保证每次调用至少推进一条，避免死循环）
    if (kept.length && total + m.content.length > CONTEXT_BUDGET.chat_summary_input_max_chars) break;
    kept.push(m);
    total += m.content.length;
  }
  return kept;
}

/** 模型摘要输出归一：截到输出上限、压首尾空白；空正文返回 null（走 digest 兜底） */
export function normalizeSummaryOutput(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  return trimmed.length > CONTEXT_BUDGET.chat_summary_output_max_chars
    ? trimmed.slice(0, CONTEXT_BUDGET.chat_summary_output_max_chars) + '…'
    : trimmed;
}

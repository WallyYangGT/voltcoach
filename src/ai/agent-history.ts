/**
 * agent-history.ts — agent 循环请求体的历史压缩（架构评审 E1：8 轮 × 16k 字符工具结果全量重发的复利治理）
 *
 * runAgentLoop 的完整 history（含 tool_calls 配对结构）保持不动——它是协议正确性的
 * 依据；每次请求前用本函数生成一个**发送副本**：更旧轮的 role:"tool" 结果替换为
 * 占位 JSON（{_compacted,_note,_original_chars,_preview}），仍超限再压更旧的
 * user/assistant 正文。不删除消息、不动 tool_call_id 配对——占位只是告诉模型
 * 「这里曾有结果，需要细节就重新调工具（换更窄的时间窗）」。
 *
 * 保留规则：
 *  - messages[0]（系统段/主提示词）永远原样，且**不计入 32k 历史预算**——系统段
 *    本身就是常量成本（英文 skills 段约 40k），若计入会让英文对话首个请求就把正常
 *    窗口历史压成 200 字预览（code-review P1-1）；
 *  - 最后 keepRecent 条消息永远原样（模型正在处理的现场）；
 *  - 同一轮的 assistant tool_calls 与其 tool 结果**要么都压要么都不压**——只压结果
 *    不压请求参数会让模型误以为还能读到全文。实现上以「assistant tool_calls 消息 +
 *    其后连续的 tool 消息」为一组，从旧到新整组压缩（占位时清空 arguments、保留
 *    id/name 以维持配对结构）。
 *
 * 纯函数、无 IO；node:test 直测。
 */

import type { AgentMessage } from './http.ts';

export interface CompactAgentHistoryOptions {
  /** 请求体字符预算（AGENTIC.agent_history_max_chars） */
  maxChars: number;
  /** 占位里的降级说明（按语言由调用方传入） */
  note: string;
  /** 末尾原样保留的消息条数（默认 3：最后一组现场 + 余量） */
  keepRecent?: number;
  /** 占位 preview 的字符数（给模型一点「这曾是什么」的线索） */
  previewChars?: number;
}

/** 单条消息的体积：content + tool_calls 的 arguments（计划/记忆等工具参数可能数 KB） */
function messageChars(m: AgentMessage): number {
  const content = m.content?.length ?? 0;
  // 畸形 tool_call（模型/代理缺 function）按 0 计，不能让体积统计抛错把整次生成标 failed
  const args =
    m.tool_calls?.reduce((n, tc) => n + (tc.function?.arguments?.length ?? 0), 0) ?? 0;
  return content + args;
}

/** 消息组的形状：一条带 tool_calls 的 assistant + 其后连续的 tool 消息；或单条普通消息 */
interface MessageGroup {
  start: number;
  end: number; // 含
  hasToolResult: boolean;
}

function groupMessages(messages: AgentMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') j++;
      groups.push({ start: i, end: j - 1, hasToolResult: true });
      i = j;
    } else {
      groups.push({ start: i, end: i, hasToolResult: false });
      i++;
    }
  }
  return groups;
}

const previewOf = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * 生成发送副本：总长不超预算时原样返回（快路径，零拷贝成本可忽略）；
 * 超预算时从最旧的**带工具结果的消息组**开始整组压缩（assistant.tool_calls 清空、
 * tool 结果替换为占位），仍超再压更旧的普通 user/assistant 正文；
 * messages[0] 与末尾 keepRecent 条永远原样。预算实在不可达（单条就超）时尽力压缩后返回。
 */
export function compactAgentHistory(
  messages: AgentMessage[],
  opts: CompactAgentHistoryOptions,
): AgentMessage[] {
  const total = messages.slice(1).reduce((n, m) => n + messageChars(m), 0);
  if (total <= opts.maxChars) return messages;

  const keepFrom = Math.max(1, messages.length - (opts.keepRecent ?? 3));
  const groups = groupMessages(messages);
  const compacted = new Set<number>(); // 组索引
  const preview = opts.previewChars ?? 200;

  const build = (): AgentMessage[] =>
    messages.map((m, idx) => {
      if (idx === 0 || idx >= keepFrom) return m;
      const g = groups.find((gr) => idx >= gr.start && idx <= gr.end);
      if (g && compacted.has(groups.indexOf(g))) {
        if (m.role === 'tool') {
          const original = m.content ?? '';
          return {
            ...m,
            content: JSON.stringify({
              _compacted: true,
              _note: opts.note,
              _original_chars: original.length,
              _preview: previewOf(original, preview),
            }),
          };
        }
        // 组内的 assistant tool_calls 消息：保留 id/name 配对结构（协议要求），
        // 清空 arguments 与正文——模型把占位结果当作「已消费、需重取」而不是可引用全文
        return {
          ...m,
          content: m.content ? previewOf(m.content, preview) : m.content,
          ...(m.tool_calls?.length
            ? {
                tool_calls: m.tool_calls.map((tc) => ({
                  ...tc,
                  function: { ...(tc.function ?? {}), arguments: '{}' },
                })),
              }
            : {}),
        };
      }
      return m;
    });

  // 预算只统计 messages[1..]：首条系统段是常量成本，不参与 32k 历史预算（P1-1）
  const measure = (msgs: AgentMessage[]) =>
    msgs.slice(1).reduce((n, m) => n + messageChars(m), 0);

  // 从旧到新逐组压缩带工具结果的组
  for (let gi = 0; gi < groups.length; gi++) {
    if (measure(build()) <= opts.maxChars) return build();
    const g = groups[gi];
    if (!g.hasToolResult || g.start < 1 || g.end >= keepFrom) continue;
    compacted.add(gi);
  }
  // 仍超：压缩更旧的普通消息正文（同样从旧到新，末尾与首条不动）
  for (let gi = 0; gi < groups.length; gi++) {
    if (measure(build()) <= opts.maxChars) return build();
    const g = groups[gi];
    if (g.hasToolResult || g.start < 1 || g.end >= keepFrom) continue;
    compacted.add(gi);
  }
  return build();
}

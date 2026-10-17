/**
 * history.ts — 对话历史窗口化（架构评审 E1：历史每轮全量重发是无上限成本的第一构成）
 *
 * 把会话消息按「轮」切分（1 轮 = 一条用户提问 + 一条教练回答，以 assistant 消息收尾），
 * 保留最近的窗口：轮数与字符双上限取更严者，最新一轮永远保留（哪怕自己超字符预算——
 * 丢掉当前问题就答非所问了）。被挤出的旧消息以确定性 digest 概括（模型摘要失败时的
 * 兜底，也用于「体量不足、不值得调模型摘要」的常态路径）。
 *
 * 输入是 db 层的 completed 消息（role/content），纯函数、无 IO，node:test 直测。
 */

/** 窗口化输入消息（只取两字段，db 行可直接传入） */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface WindowOptions {
  /** 保留的最近轮数上限（CONTEXT_BUDGET.history_recent_turns） */
  recentTurns: number;
  /** 保留的最近历史字符上限（CONTEXT_BUDGET.history_recent_chars） */
  recentChars: number;
  /** digest 概括每条消息的最大字符数（防单条超长正文撑爆兜底摘要） */
  digestPerMessageChars?: number;
  /** digest 总字符上限 */
  digestMaxChars?: number;
}

export interface WindowedHistory<T extends HistoryMessage = HistoryMessage> {
  /** 保留在请求里的最近消息（可能为空数组——首条消息就超预算时也保留最新一轮，见实现） */
  recent: T[];
  /** 被挤出窗口的旧消息（模型滚动摘要 / digest 的输入；按时间正序） */
  omitted: T[];
  /** 确定性兜底摘要：旧消息的逐条要点（每条截断 + 全局截断），omitted 为空时为 null */
  digest: string | null;
}

/** 单条消息的确定性概括行 */
function digestLine(m: HistoryMessage, perMessageChars: number): string {
  const who = m.role === 'user' ? '用户' : '教练';
  const body = m.content.length > perMessageChars
    ? m.content.slice(0, perMessageChars) + '…'
    : m.content;
  // 压成单行：换行会破坏「逐条要点」的行结构
  return `- ${who}: ${body.replace(/\s+/g, ' ').trim()}`;
}

/**
 * 消息 → 轮列表：以 assistant 消息收尾的连续段为 1 轮。上一轮已收尾（末条是
 * assistant）后又出现 user → 起新轮；未收尾就出现 user（异常序列）→ 并入上一轮。
 */
function toTurns(messages: HistoryMessage[]): HistoryMessage[][] {
  const turns: HistoryMessage[][] = [];
  let lastClosed = true; // 上一轮是否已以 assistant 收尾（初始视为已收尾 → 首条 user 起新轮）
  for (const m of messages) {
    if (m.role === 'user' && lastClosed) {
      turns.push([m]);
      lastClosed = false;
    } else {
      if (!turns.length) turns.push([m]);
      else turns[turns.length - 1].push(m);
      if (m.role === 'assistant') lastClosed = true;
    }
  }
  return turns;
}

/**
 * 窗口化对话历史：保留最近 recentTurns 轮且总量 ≤ recentChars（超限从最旧轮起丢，
 * 至少保留最后一轮）。omitted 非空时生成确定性 digest（首条用户消息=会话锚点必含）。
 */
export function windowChatHistory<T extends HistoryMessage>(
  messages: T[],
  opts: WindowOptions,
): WindowedHistory<T> {
  const perMessage = opts.digestPerMessageChars ?? 200;
  const digestMax = opts.digestMaxChars ?? 2000;
  const turns = toTurns(messages);

  // 从最后一轮向前收集，直到轮数或字符超限；最后一轮强制保留
  const keptTurns: HistoryMessage[][] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const turnChars = turn.reduce((n, m) => n + m.content.length, 0);
    const isLastTurn = keptTurns.length === 0;
    if (!isLastTurn && (keptTurns.length >= opts.recentTurns || chars + turnChars > opts.recentChars)) break;
    keptTurns.unshift(turn);
    chars += turnChars;
  }

  const keptCount = keptTurns.reduce((n, t) => n + t.length, 0);
  const recent = messages.slice(messages.length - keptCount);
  const omitted = messages.slice(0, messages.length - keptCount);

  let digest: string | null = null;
  if (omitted.length) {
    const lines = omitted.map((m) => digestLine(m, perMessage));
    let body = lines.join('\n');
    if (body.length > digestMax) {
      body = body.slice(0, digestMax) + '…';
    }
    digest = body;
  }
  return { recent, omitted, digest };
}

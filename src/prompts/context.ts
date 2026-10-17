/**
 * context.ts — 上下文预算装配器（架构评审 E1 完整解的预算分配层，2026-10-17）
 *
 * 把提示词显式建模为「段」的列表：每段声明 id / 优先级 / 可丢性 / 降级函数，
 * 装配时若总量超预算——先整段丢弃优先级最低且 optional 的段（如档案段、记忆段），
 * 仍超再对声明了 degrade() 的段按内容边界截断（附省略说明）。
 * 数据 JSON 段不声明 degrade 即不可截断：截在 JSON 中间对模型是噪声（评审原文），
 * 宁可超预算也不破坏结构。
 *
 * 全部纯函数、无 IO、无 i18n 依赖（省略说明文案由调用方传入），node:test 可直测。
 */

/** 预算内的一段提示词 */
export interface PromptSection {
  /** 稳定标识（测试与日志用；如 'skills' / 'dossier' / 'memory' / 'report'） */
  id: string;
  /** 段文本 */
  text: string;
  /** 优先级：数值越小越重要；同预算下先丢数值大的段 */
  priority: number;
  /**
   * 超预算时是否允许**整段丢弃**（如档案/记忆这类可再生的补充信息）。
   * false 的段（角色/口径/数据 JSON/问题清单）永远保留。
   */
  optional?: boolean;
  /**
   * 允许**截断保留**的段提供降级函数：入参是允许保留的字符预算，
   * 返回截断后的文本（调用方保证文案带省略说明）。未提供则该段不可截。
   */
  degrade?: (maxChars: number) => string;
}

/** 装配结果：拼好的文本 + 丢弃/截断台账（日志与测试断言用） */
export interface AssembleResult {
  text: string;
  /** 被整段丢弃的段 id（按丢弃顺序） */
  dropped: string[];
  /** 被降级截断的段 id（按截断顺序） */
  trimmed: string[];
  /** 最终文本长度（字符） */
  chars: number;
}

/**
 * 按内容边界截断文本块：优先在预算内的段落边界（\n\n）或行边界（\n）断开，
 * 都找不到（超长无换行的极端情况）才硬切字符；结尾追加省略说明。
 * 供技能/报告类 degrade() 复用。
 */
export function truncateTextBlock(text: string, maxChars: number, omissionNote: string): string {
  if (maxChars <= 0) return omissionNote;
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - omissionNote.length - 1);
  if (budget === 0) return omissionNote;
  const cut = text.slice(0, budget);
  // 断点优先级：段落边界 > 行边界 > 硬切；断点不能离预算太远（至少保留 60% 预算）
  const paraBreak = cut.lastIndexOf('\n\n');
  if (paraBreak >= Math.floor(budget * 0.6)) return cut.slice(0, paraBreak) + '\n' + omissionNote;
  const lineBreak = cut.lastIndexOf('\n');
  if (lineBreak >= Math.floor(budget * 0.6)) return cut.slice(0, lineBreak) + '\n' + omissionNote;
  return cut + '\n' + omissionNote;
}

/**
 * 把段列表装配为预算内的单一文本。
 *
 * 算法（确定性，三轮）：
 * 1. 全量拼接后不超预算 → 原样 join 返回（零损耗快路径）；
 * 2. 仍超：按 priority 降序（同分按 id）依次整段丢弃 optional 段，直到不超或无可丢；
 * 3. 仍超：对声明了 degrade() 的非 optional 段按同一顺序逐个降级——
 *    每段允许的预算 = 当前总预算 - 其余段（含已降级段）的当前长度，
 *    降级后重算总量；无 degrade 可降则接受超预算（数据 JSON 宁超不破）。
 *
 * 返回文本**保持传入顺序**（提示词段落有固有的阅读顺序：角色→口径→数据→问题）；
 * priority 只决定丢弃/降级的先后，不参与输出排序。
 */
export function assembleBudgetedSections(
  sections: PromptSection[],
  totalMaxChars: number,
  omissionNote: string,
): AssembleResult {
  // 输出顺序 = 传入顺序；丢弃/降级按 priority 决定（见下方 byDropOrder/byTrimOrder）
  const order = [...sections];
  const join = (texts: (string | null)[]) => texts.filter((t) => t != null).join('\n\n');

  // 快路径：全量不超预算
  const full = join(order.map((s) => s.text));
  if (full.length <= totalMaxChars) {
    return { text: full, dropped: [], trimmed: [], chars: full.length };
  }

  // 第 2 轮：丢 optional 段（priority 降序 = 最不重要先丢）
  const dropped: string[] = [];
  const droppedIds = new Set<string>();
  const byDropOrder = [...order]
    .filter((s) => s.optional)
    .sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.id < b.id ? -1 : 1));
  let current = full;
  for (const s of byDropOrder) {
    if (current.length <= totalMaxChars) break;
    droppedIds.add(s.id);
    dropped.push(s.id);
    current = join(order.map((x) => (droppedIds.has(x.id) ? null : x.text)));
  }

  // 第 3 轮：降级可截段（同样最不重要先降）
  const trimmed: string[] = [];
  const texts = new Map(order.map((s) => [s.id, s.text]));
  const byTrimOrder = [...order]
    .filter((s) => !droppedIds.has(s.id) && s.degrade)
    .sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.id < b.id ? -1 : 1));
  for (const s of byTrimOrder) {
    if (current.length <= totalMaxChars) break;
    const others = order
      .filter((x) => x.id !== s.id && !droppedIds.has(x.id))
      .reduce((sum, x) => sum + (texts.get(x.id)?.length ?? 0) + 2, 0);
    const allowance = Math.max(0, totalMaxChars - others);
    const degraded = s.degrade!(allowance);
    if (degraded.length >= (texts.get(s.id)?.length ?? Infinity)) continue; // 降级无收益则跳过
    texts.set(s.id, degraded);
    trimmed.push(s.id);
    current = join(order.map((x) => (droppedIds.has(x.id) ? null : texts.get(x.id) ?? null)));
  }

  return { text: current, dropped, trimmed, chars: current.length };
}

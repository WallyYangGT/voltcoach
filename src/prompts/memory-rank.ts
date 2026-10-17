/**
 * memory-rank.ts — 记忆按相关度挑选（架构评审 E1：top-k 替代「最近 30 条」全量注入）
 *
 * 确定性打分（零 token、可测、可复现）：
 *  - strategy 类记忆进权威段，永远入选（+1000）——商定策略被当问题批评的治理依赖它置顶；
 *  - 类别与场景亲和：计划会话偏日程/目标/伤病，追问偏伤病/偏好，复盘偏目标/伤病；
 *  - 短期记忆（scope='short'）本就是「近期上下文」，小幅加分；
 *  - 时间衰减：越新越相关（<7 天 +3 / <30 天 +2 / <90 天 +1）；
 *  - 与当前问题/报告正文的内容重叠：中文 2-gram + 英文词命中（带停用词表），最多 +8；
 *  - 同分按 id 大者优先（更新的记忆先注入）。
 *
 * 挑选口径：strategy 全收（权威段不可缺），其余按分数从高到低补齐，受 topK 与
 * maxChars 双预算约束。返回顺序保持入参的 id DESC 约定——buildMemorySection 内部
 * 反转为时间正序展示，打分层不改变这个契约。
 *
 * 纯函数、无 IO、无 i18n 依赖；node:test 直测。
 */

import type { PromptMemory } from './prompts.ts';

export interface RankOptions {
  /** 注入场景：报告四场景（review/plan/taper/compare）、追问 follow_up、计划会话 plan、对话 chat */
  mode?: string;
  /** 相关度参照文本（当前问题 / 报告正文 / 系统段），可空 */
  query?: string | null;
  /** 当前时刻（ms），时间衰减基准；缺省取真实时钟 */
  nowMs?: number;
  /** 最多注入条数（CONTEXT_BUDGET.memory_top_k） */
  topK?: number;
  /** 注入内容总字符预算（CONTEXT_BUDGET.memory_max_chars） */
  maxChars?: number;
}

/** 类别 × 场景亲和表：命中的类别按表内加分（缺省类别与未列场景不加分） */
const MODE_CATEGORY_AFFINITY: Record<string, Partial<Record<string, number>>> = {
  plan: { schedule: 4, goal: 3, injury: 2, preference: 1 },
  follow_up: { injury: 3, preference: 2, goal: 1 },
  review: { goal: 3, injury: 2 },
  taper: { goal: 3, injury: 2, schedule: 2 },
  compare: { goal: 2 },
};

/** 内容重叠的英文停用词（中文按 2-gram 统计天然稀释虚词，英文需要此表） */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
  'be', 'been', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'my', 'me', 'i', 'we', 'you',
]);

/** 判定用的记忆特征（timeMs 为解析后的时间戳，无法解析为 null） */
interface RankedMemory {
  mem: PromptMemory;
  score: number;
  timeMs: number | null;
}

/** 中文 2-gram 集合（长度 ≥2 的连续 CJK 片段）；英文走词集合 */
function tokenSet(text: string): { bigrams: Set<string>; words: Set<string> } {
  const bigrams = new Set<string>();
  const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) bigrams.add(run.slice(i, i + 2));
  }
  const words = new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) ?? []).filter((w) => !STOPWORDS.has(w)),
  );
  return { bigrams, words };
}

/** 查询侧分词结果（整份 query 只算一次，避免每条记忆重复分词长报告） */
type TokenBag = ReturnType<typeof tokenSet>;

/** 打分单个记忆（确定性；created_at 缺失/非法时时间分与重叠时延分不生效） */
function scoreMemory(
  mem: PromptMemory,
  opts: Required<Pick<RankOptions, 'mode' | 'nowMs'>>,
  queryTokens: TokenBag | null,
): RankedMemory {
  let score = 0;
  if (mem.category === 'strategy') score += 1000;
  const affinity = MODE_CATEGORY_AFFINITY[opts.mode];
  if (affinity && mem.category && affinity[mem.category]) score += affinity[mem.category]!;
  if (mem.scope === 'short') score += 2;

  const timeMs = mem.created_at ? Date.parse(mem.created_at.replace(' ', 'T') + (mem.created_at.includes('Z') || mem.created_at.includes('+') ? '' : 'Z')) : null;
  const ageMs = timeMs != null && Number.isFinite(timeMs) ? opts.nowMs - timeMs : null;
  if (ageMs != null) {
    const ageDays = ageMs / 86_400_000;
    if (ageDays < 7) score += 3;
    else if (ageDays < 30) score += 2;
    else if (ageDays < 90) score += 1;
  }

  if (queryTokens) {
    const { bigrams, words } = tokenSet(mem.content);
    let hits = 0;
    for (const g of queryTokens.bigrams) if (bigrams.has(g)) hits++;
    for (const w of queryTokens.words) if (words.has(w)) hits++;
    score += Math.min(8, hits);
  }
  return { mem, score, timeMs: timeMs != null && Number.isFinite(timeMs) ? timeMs : null };
}

/**
 * 从有效记忆清单里挑选注入集合：strategy 全收，其余按分补齐 topK / maxChars。
 * 返回顺序 = 入参顺序过滤（调用方约定 id DESC），空 query/无记忆时退化为
 * 「strategy + 新近 topK」的原行为。
 */
export function rankMemories(
  memories: PromptMemory[] | null,
  opts: RankOptions = {},
): PromptMemory[] {
  const all = memories ?? [];
  if (!all.length) return [];
  const full: Required<Pick<RankOptions, 'mode' | 'nowMs'>> & Pick<RankOptions, 'topK' | 'maxChars'> = {
    mode: opts.mode ?? '',
    nowMs: opts.nowMs ?? Date.now(),
    topK: opts.topK,
    maxChars: opts.maxChars,
  };
  // 相关度参照文本可能是一整份报告 prompt（最长 ~56k）：只取前 2000 字分词，
  // 且整份 query 只分词一次（逐记忆重复分词会让长报告场景退化成 O(n×m)）
  const queryText = (opts.query ?? '').slice(0, 2000);
  const queryTokens = queryText ? tokenSet(queryText) : null;
  const ranked = all.map((m) => scoreMemory(m, full, queryTokens));

  const strategies = ranked.filter((r) => r.mem.category === 'strategy');
  const rest = ranked
    .filter((r) => r.mem.category !== 'strategy')
    // 同分按 timeMs 新者优先（null 视为最旧），再按 id 大者优先——稳定且符合直觉
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : (b.timeMs ?? -Infinity) !== (a.timeMs ?? -Infinity)
          ? (b.timeMs ?? -Infinity) - (a.timeMs ?? -Infinity)
          : b.mem.id - a.mem.id,
    );

  const cap = full.topK ?? all.length;
  const charBudget = full.maxChars;
  const picked: RankedMemory[] = [...strategies];
  let usedChars = picked.reduce((n, r) => n + r.mem.content.length, 0);
  for (const r of rest) {
    if (picked.length >= cap) break;
    if (charBudget != null && usedChars + r.mem.content.length > charBudget) continue;
    picked.push(r);
    usedChars += r.mem.content.length;
  }
  const pickedIds = new Set(picked.map((r) => r.mem.id));
  return all.filter((m) => pickedIds.has(m.id));
}

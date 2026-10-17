/**
 * compact.ts — 工具结果的结构化降级（架构评审 E1：超限降级为结构化摘要而非尾部硬切）
 *
 * 旧口径 toResult 是裸 JSON 字符串的 slice(0, 16k)：截在 JSON 中间对模型是噪声，
 * 且截断后的文本不再可解析。新口径分级降级、**任何一级都返回合法 JSON**：
 *  1. 超长字符串值截短（附省略标记）；
 *  2. 超长数组均匀抽样（保留首尾），以 { "__omitted__": n } 哨兵交代省略条数；
 *  3. 仍超限则丢弃更深的对象层级（深度 > maxDepth 的子树替换为省略说明）；
 *  4. 最后兜底：只保留 { _compacted, note, original_chars, top_keys }。
 * 顶层始终注入 _truncated 元信息（原字符数与降级说明），模型可据此缩小查询窗口重取
 * （如 get_activity_records 的 start_sec/end_sec）。
 *
 * 纯函数、无 IO、无 i18n 依赖（note 由调用方传入）；node:test 直测。
 */

/** 数组抽样时每段保留的条数（头部与尾部各一） */
const KEEP_HEAD = 20;
const KEEP_TAIL = 20;
/** 字符串值截短后的保留长度 */
const STRING_KEEP = 400;

export interface CompactOptions {
  maxChars: number;
  /** 降级说明（按语言由调用方传入；进入 _truncated.note 与兜底结构的 note） */
  note: string;
}

/** 递归降级的内部状态（避免参数表膨胀） */
interface Ctx {
  maxChars: number;
  note: string;
  originalChars: number;
}

function truncateStringValue(s: string): string {
  return s.length > STRING_KEEP ? s.slice(0, STRING_KEEP) + `…(+${s.length - STRING_KEEP} chars)` : s;
}

/** 深度裁剪：超过 maxDepth 的子树替换为省略说明 */
function clipDepth(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return { __omitted__: 'depth' };
  if (typeof value === 'string') return truncateStringValue(value);
  if (Array.isArray(value)) return value.map((v) => clipDepth(v, depth + 1, maxDepth));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = clipDepth(v, depth + 1, maxDepth);
    }
    return out;
  }
  return value;
}

/** 数组抽样：保留首尾 KEEP_HEAD/KEEP_TAIL 条，中间以哨兵交代省略条数 */
function sampleArray(arr: unknown[]): unknown[] {
  if (arr.length <= KEEP_HEAD + KEEP_TAIL + 2) return arr;
  const omitted = arr.length - KEEP_HEAD - KEEP_TAIL;
  return [
    ...arr.slice(0, KEEP_HEAD),
    { __omitted__: omitted },
    ...arr.slice(arr.length - KEEP_TAIL),
  ];
}

/** 单遍降级：字符串截短 + 数组抽样（不动结构层级） */
function compactPass(value: unknown): unknown {
  if (typeof value === 'string') return truncateStringValue(value);
  if (Array.isArray(value)) {
    const sampled = sampleArray(value);
    return sampled.map((v) => (typeof v === 'string' ? truncateStringValue(v) : compactPass(v)));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = compactPass(v);
    return out;
  }
  return value;
}

/** 最后兜底：丢弃整个载荷，只交代原体积与顶层键 */
function fallbackSkeleton(value: unknown, ctx: Ctx): Record<string, unknown> {
  const topKeys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).slice(0, 20)
    : undefined;
  const skel: Record<string, unknown> = {
    _compacted: true,
    note: ctx.note,
    original_chars: ctx.originalChars,
  };
  if (topKeys) skel.top_keys = topKeys;
  return skel;
}

/**
 * 把任意工具结果压到 maxChars 内、保证 JSON.stringify 恒可解析。
 * 分级降级（字符串截短 → 数组抽样 → 深度裁剪逐级收紧 → 兜底骨架），
 * 每级之间检查长度，达到预算立即返回；顶层注入 _truncated 元信息。
 */
export function compactJsonToLimit(value: unknown, opts: CompactOptions): string {
  const ctx: Ctx = { maxChars: Math.max(200, opts.maxChars), note: opts.note, originalChars: 0 };
  const meta = () => ({
    _truncated: { original_chars: ctx.originalChars, note: ctx.note },
  });
  const inject = (body: unknown): string => {
    const merged =
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>), _truncated: meta()._truncated }
        : { data: body, _truncated: meta()._truncated };
    return JSON.stringify(merged);
  };

  const full = JSON.stringify(value);
  ctx.originalChars = full.length;
  if (full.length <= ctx.maxChars) return full; // 未超限原样返回（不带 _truncated）

  // 降级梯子：字符串截短+数组抽样 → 深度 6 → 4 → 3 → 2 → 兜底骨架
  let current: unknown = compactPass(value);
  let out = inject(current);
  for (const depth of [6, 4, 3, 2]) {
    if (out.length <= ctx.maxChars) return out;
    current = clipDepth(current, 0, depth);
    out = inject(current);
  }
  if (out.length <= ctx.maxChars) return out;
  return JSON.stringify(fallbackSkeleton(value, ctx));
}

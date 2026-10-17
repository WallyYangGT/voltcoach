/**
 * http.ts — chat/completions 请求层（自 fit-reader Web 版 src/ai.js requestChatCompletion 平移，
 * 传输层从 node:http/https 换成标准 fetch：App 内用 expo/fetch，node:test 注入 mock fetch）。
 *
 * 旧版弃用全局 fetch 的原因是 undici 内置 300s 超时静默掐断长报告；expo/fetch 是
 * WinterCG 合规实现（无该隐藏超时，response.body 可流式读），总超时/流式空闲超时
 * 由本模块经 AbortController 自管（AI_CONFIG.timeout_ms / stall_ms），口径不变。
 *
 * SSE 解析：expo/fetch 的 body 是字节流，这里在字节级按 \n 切分、逐完整行做 UTF-8
 * 解码——不依赖 TextDecoder（Hermes 环境兼容性），且多字节字符跨块断开也安全。
 */

import { t, type Lang } from '../core/i18n.ts';

/** fetch 形状（expo/fetch 与 globalThis.fetch 皆可） */
export type FetchLike = typeof globalThis.fetch;

/**
 * 传输级失败（与"模型/接口明确报错"区分）：响应体为空或不是完整 JSON（网关/代理
 * 断连、移动网络切换、长请求被中间层掐断都会长这样）、连接中断、429/5xx 等。
 * 这类失败**重试有意义**，故带上 retryable 标记供自动重试与调用方区分。
 *
 * 成因背景（2026-09-22 真机事故）：非流式的长报告请求等待数分钟后，Hermes 在
 * `res.json()` 里抛「JSON Parse error: Unexpected end of input」——expo/fetch 的
 * json() 就是 `JSON.parse(await text())`，正文被中断/为空时即此错误。原实现把它
 * 包成一句干巴巴的"响应解析失败"，既看不出原因也无法自动恢复。
 */
export class AiTransportError extends Error {
  readonly retryable: boolean;
  /** 非 2xx 响应的状态码；非 HTTP 错误（网络断连/空正文/解析失败）为 undefined */
  readonly httpStatus?: number;

  constructor(message: string, retryable = true, httpStatus?: number) {
    super(message);
    this.name = 'AiTransportError';
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

/**
 * 用户主动取消（非错误）：编排层 abort 时以本类实例为 signal.reason，供
 * agent 层超时分类与编排层回写（cancelled 而非 failed）区分——不能走
 * `/aborted|timeout/` 文案匹配（会把取消误报成总超时，T1 的同型坑）。
 */
export class AiCancelledError extends Error {
  constructor(message = 'generation cancelled by user') {
    super(message);
    this.name = 'AiCancelledError';
  }
}

/** 传输级自动重试次数（首次 + 1 次重试）；总超时预算由调用方 signal 统一约束，不重置 */
const MAX_ATTEMPTS = 2;
/** 重试前的等待：多数断连是瞬时的，稍等即可；同时避免立刻二次冲击网关 */
const RETRY_DELAY_MS = 1200;
/** 模型返回的单个工具调用 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** chat/completions 返回的 message 对象（含可选 tool_calls） */
export interface ChatMessage {
  role?: string;
  content: string | null;
  tool_calls?: ToolCall[];
}

/** 多轮消息（agent 循环历史用） */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatMessage['tool_calls'];
  tool_call_id?: string;
}

/**
 * 默认 fetch：RN 环境用 expo/fetch（response.body 为可读流，SSE 必需）；
 * 非 RN 环境（node:test 直连本模块时）回落 globalThis.fetch。
 * 惰性动态 import——node:test 载入本模块时不能存在对 expo 的静态依赖。
 */
export async function loadDefaultFetch(): Promise<FetchLike> {
  try {
    const mod = (await import('expo/fetch')) as { fetch?: FetchLike };
    if (typeof mod?.fetch === 'function') return mod.fetch.bind(mod) as FetchLike;
  } catch {
    // 非 RN 环境回落
  }
  return globalThis.fetch;
}

/** 手写 UTF-8 解码（仅用于完整行：调用方保证字节序列不含跨行断开的多字节字符）。
 *  续字节不合法（b & 0xc0 !== 0x80）时输出替换符 U+FFFD 并按 1 字节推进，不抛错 */
function decodeUtf8(bytes: number[]): string {
  let out = '';
  let i = 0;
  const cont = (k: number) => k < bytes.length && (bytes[k] & 0xc0) === 0x80;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if ((b & 0xe0) === 0xc0 && cont(i + 1)) {
      cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if ((b & 0xf0) === 0xe0 && cont(i + 1) && cont(i + 2)) {
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
    } else if ((b & 0xf8) === 0xf0 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      i += 4;
    } else {
      out += '\uFFFD'; // 畸形序列：替换符 + 单字节推进
      i += 1;
      continue;
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

/** 响应正文片段（诊断用）：截断到 120 字，换行折叠成空格 */
function snippet(text: string, n = 120): string {
  return text.slice(0, n).replace(/\s+/g, ' ');
}

/** 响应体不是完整 JSON 时的统一报错（空正文与破损正文分开描述，便于定位中间层） */
function badBodyError(status: number, text: string, lang: Lang): AiTransportError {
  if (!text.trim()) {
    return new AiTransportError(
      `${t(lang, 'ai.empty_body', { status })}${t(lang, 'ai.empty_body_hint')}`,
    );
  }
  return new AiTransportError(
    t(lang, 'ai.bad_json', { status, chars: text.length, head: snippet(text) }),
  );
}

/**
 * 发起一次 chat/completions 请求。
 * 非流式（onStreamChunk 缺省）resolve 完整 message 对象（{content, tool_calls?}）；
 * 流式逐 chunk 回调 onStreamChunk 后 resolve 拼接的完整文本。
 * 非 2xx 抛 `AI API 返回 {status}: {body 前 300 字}`，错误对象带 httpStatus 字段
 * （agent 循环的 tools 降级按 `e instanceof AiTransportError && e.httpStatus === 400`
 * 类型化判定，不再依赖消息文案——文案可随措辞调整）。
 *
 * 传输级失败（连接建立失败、空/破损正文、正文读取中断、429/5xx）自动重试一次：
 * 长报告请求可能已经等了数分钟，不重试就等于让用户手动再来一遍。
 * - **重试改用流式**（仅限不带 tools 的请求）：非流式长请求中途一行字节都不流动，
 *   最容易撞上网关/NAT 的空闲超时——真机"等半天后 JSON 解析失败"的现场形态；
 *   流式让字节持续流动，正文边收边攒。（2026-10 增量落库起，生成链路的请求本身
 *   已一律流式且支持 tool_calls 增量帧聚合——见 requestOnce；此处的重试切换仅
 *   服务于"调用方未流式"的旧形态请求。）
 * - 已吐过字的流式响应不重试（正文已交给调用方，重来会造成重复内容）。
 * - 共用调用方的 signal：总超时预算不重置（首次失败若已耗掉大半预算，重试可能来不及）；
 *   等待期间被 abort 则不再补发。
 * 重试前经 onRetry 告知调用方（UI 进度）。
 * 流式收尾校验终止标记（[DONE] 或 finish_reason，2026-10）：缺失即视为被中间层
 * 截断，抛不可重试错误——非流式时代空/破损正文由 parseMessageBody 兜住，流式化后
 * 同等完整性由该检查保证（防止截断正文静默落成 completed）。
 *
 * 推理模型（2026-10，生成过程可视化）：部分 OpenAI 兼容端点（DeepSeek/Kimi 等）在
 * 正文前先流式下发 `delta.reasoning_content`（OpenRouter 系为 `delta.reasoning` 字符串）。
 * 这里只做旁路透传（onStreamReasoning），**不拼入正文、不写入返回值**——思考过程是
 * UI 的瞬态展示数据，不进报告/对话落库。`onStreamToolCall` 在流式 tool_calls 首现
 * 工具名时提前通知一次，让 UI 在模型生成参数阶段就能显示「正在调用 X…」。
 */
export async function requestChatCompletion(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string,
  requestBody: object,
  {
    signal,
    onStreamChunk,
    onStreamReasoning,
    onStreamToolCall,
    onRetry,
    lang = 'zh',
    retryDelayMs = RETRY_DELAY_MS,
  }: {
    signal?: AbortSignal;
    onStreamChunk?: (delta: string) => void;
    /** 流式推理增量（reasoning_content / reasoning 字符串形态）；不属于正文 */
    onStreamReasoning?: (delta: string) => void;
    /** 流式 tool_calls 首次拿到非空工具名时回调（UI 提前切工具调用态） */
    onStreamToolCall?: (name: string) => void;
    /** 即将自动重试（nextAttempt 为下一次的序号，从 2 起） */
    onRetry?: (nextAttempt: number, errMsg: string) => void;
    lang?: Lang;
    /** 重试等待时长（毫秒）；仅测试注入用，默认 RETRY_DELAY_MS */
    retryDelayMs?: number;
  } = {},
): Promise<ChatMessage | string> {
  // tools 请求不切换流式（见上方说明）；无 tools 的第二次尝试改走 SSE
  const canStreamRetry = !(requestBody as { tools?: unknown[] }).tools?.length;
  let lastErr: unknown;
  let retried = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce(fetchImpl, baseUrl, apiKey, requestBody, {
        signal,
        onStreamChunk,
        onStreamReasoning,
        onStreamToolCall,
        lang,
        forceStream: attempt > 1 && canStreamRetry,
      });
    } catch (e) {
      lastErr = e;
      // 已 abort（总超时/调用方取消）或不是传输级失败或已吐字 → 收尾抛出，不重试
      const canRetry =
        e instanceof AiTransportError && e.retryable && !signal?.aborted && attempt < MAX_ATTEMPTS;
      if (!canRetry) {
        // 重试过仍失败：消息里标明，避免用户以为是首次尝试（也便于回看定位网关/网络问题）
        if (retried > 0 && e instanceof Error)
          throw new AiTransportError(
            e.message + t(lang, 'ai.retried_note', { n: retried }),
            false,
            e instanceof AiTransportError ? e.httpStatus : undefined,
          );
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      retried += 1;
      onRetry?.(attempt + 1, msg);
      await new Promise((r) => setTimeout(r, retryDelayMs));
      // 等待期间超时/取消：不再补发。取消时必须抛 signal.reason（AiCancelledError）而非
      // 原传输错误——否则编排层会把取消误判成失败（failed 而非 cancelled）
      if (signal?.aborted) throw signal.reason ?? e;
    }
  }
  // 理论不可达（循环体内要么 return 要么 throw），保留兜底
  throw lastErr;
}

/** 单次请求（重试循环体内的实际收发与解析） */
async function requestOnce(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string,
  requestBody: object,
  {
    signal,
    onStreamChunk,
    onStreamReasoning,
    onStreamToolCall,
    lang,
    forceStream = false,
  }: {
    signal?: AbortSignal;
    onStreamChunk?: (delta: string) => void;
    onStreamReasoning?: (delta: string) => void;
    onStreamToolCall?: (name: string) => void;
    lang: Lang;
    /** 强制走流式（传输级重试时打开：见 requestChatCompletion 的说明） */
    forceStream?: boolean;
  },
): Promise<ChatMessage | string> {
  const streamMode = !!onStreamChunk || forceStream;
  const body = streamMode && !onStreamChunk
    ? { ...requestBody, stream: true } // 降级重试：改成流式请求，保持字节流动
    : requestBody;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // 连接建立就失败（DNS/连接被拒/被网关掐断 → expo 抛 FetchError）：同样属传输级
    if (signal?.aborted) throw signal.reason ?? e;
    throw new AiTransportError(
      t(lang, 'ai.network_failed', { msg: e instanceof Error ? e.message : String(e) }),
    );
  }

  if (!res.ok) {
    let errBody = '';
    try {
      errBody = await res.text();
    } catch {
      // 读错误体失败时只报状态码
    }
    // 429/5xx 属瞬时（限流、网关抖动），可重试；4xx 是请求本身的问题，重试无意义
    const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    throw new AiTransportError(`AI API 返回 ${res.status}: ${errBody.slice(0, 300)}`, retryable, res.status);
  }

  if (!streamMode) {
    // 非流式：先取正文再解析——正文为空/被截断时给出可定位的报错（而非裸的 JSON 语法错误）
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e; // 超时中断：交回调用方按超时口径报错
      throw new AiTransportError(
        t(lang, 'ai.read_failed', { msg: e instanceof Error ? e.message : String(e) }),
      );
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    return parseMessageBody(text, res.status, lang);
  }

  // 流式：SSE 字节流按 \n 切行，逐行解析 data: 帧，delta 回调并拼接
  const reader = res.body?.getReader();
  if (!reader) throw new AiTransportError(t(lang, 'ai.stream_empty'), true);
  let buffer: number[] = [];
  let fullText = '';
  let rawText = ''; // 原始正文（无 data: 帧时按普通 JSON 响应兜底）
  let sawFrame = false;
  let sawDelta = false; // 是否已收到增量帧（与整段 message 帧互斥，防正文重复）
  let sawDone = false; // 终止标记：[DONE] 帧或任一帧 finish_reason 非空——流式化后
  // 「正文写完但连接被中间层静默掐断」（干净 EOF，无 [DONE]/finish_reason）只有靠它
  // 才能检出，否则截断正文会以 completed 静默落库（非流式时代 badBodyError 的等价防线）
  // tool_calls 增量帧聚合（agent 循环流式化，2026-10）：按 index 分桶，id/name/arguments
  // 均为增量字段按分片拼接（OpenAI 兼容口径；name 通常首帧给全，拼接幂等）
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  // 工具名首现只通知一次（UI 提前显示「正在调用 X…」）；整段 message 兜底也复用该标志
  let toolNameNotified = false;
  const notifyToolName = (name: string | undefined) => {
    if (toolNameNotified || !name) return;
    toolNameNotified = true;
    onStreamToolCall?.(name);
  };
  const emit = (delta: string) => {
    fullText += delta;
    onStreamChunk?.(delta);
  };
  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    sawFrame = true;
    if (!data) return; // 空 data 帧是部分网关的心跳，非错误
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    let obj: {
      error?: { message?: string };
      choices?: {
        delta?: {
          content?: string;
          /** DeepSeek/Kimi 等推理模型：思考过程增量（与 content 并行、不属正文） */
          reasoning_content?: string;
          /** OpenRouter 系：reasoning 为字符串时才接（对象/数组形态忽略） */
          reasoning?: unknown;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        message?: ChatMessage;
        finish_reason?: string;
      }[];
    };
    try {
      obj = JSON.parse(data);
    } catch {
      // 帧被截断（连接中断）→ 归为可重试的传输级错误
      throw new AiTransportError(t(lang, 'ai.bad_sse', { head: snippet(data) }));
    }
    if (obj.error) throw new AiTransportError(obj.error.message || JSON.stringify(obj.error), false);
    const choice = obj.choices?.[0];
    if (choice?.finish_reason) sawDone = true;
    // 推理增量：只旁路回调，不拼正文、不置 sawDelta——部分端点会先发 reasoning 帧，
    // 最后补一帧整段 message.content；置 sawDelta 会让上面的整段兜底被跳过（正文丢失）
    const deltaReasoning =
      typeof choice?.delta?.reasoning_content === 'string'
        ? choice.delta.reasoning_content
        : typeof choice?.delta?.reasoning === 'string'
          ? choice.delta.reasoning
          : '';
    if (deltaReasoning) onStreamReasoning?.(deltaReasoning);
    // 兼容两种形态：增量 delta（标准流式）与整段 message（部分账号不真正流式）。
    // ⚠️ 两种形态互斥：见过增量就不再认整段帧——部分网关会在 delta 流末尾补一帧带
    // message 的收尾帧，若无条件取 message.content，正文会被拼成两遍（静默污染落库正文）。
    const deltaContent = choice?.delta?.content;
    if (deltaContent) {
      sawDelta = true;
      emit(deltaContent);
      return;
    }
    const deltaTools = choice?.delta?.tool_calls;
    if (deltaTools?.length) {
      sawDelta = true; // 工具增量帧同样是"流式形态"证据，收尾的整段 message 帧不得再覆盖
      for (const tc of deltaTools) {
        const slot = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id += tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        toolAcc.set(tc.index, slot);
      }
      // 名字可能跨帧拼出：拿到首个非空名称即通知（partial name 也会被后续执行阶段纠正）
      for (const slot of toolAcc.values()) notifyToolName(slot.name);
      return;
    }
    // 整段 message 帧携带 tool_calls（无 delta 形态，与正文侧 wholeContent 同款兜底）：
    // 部分端点收到 stream:true 仍一次性回完整 message——不接住会丢工具调用并误报空响应
    const wholeTools = !sawDelta ? choice?.message?.tool_calls : undefined;
    if (wholeTools?.length) {
      sawDelta = true;
      notifyToolName(wholeTools.find((tc) => tc.function?.name)?.function?.name);
      // 整段帧的 tool_calls 是完整有序数组（无增量 index 语义），按下标分桶
      wholeTools.forEach((tc, i) =>
        toolAcc.set(i, {
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          args: tc.function?.arguments ?? '',
        }),
      );
      const wholeContent = choice?.message?.content;
      if (wholeContent) emit(wholeContent);
      return;
    }
    const wholeContent = choice?.message?.content;
    if (wholeContent && !sawDelta) emit(wholeContent);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const b of value) {
        if (b === 10) {
          const line = decodeUtf8(buffer);
          buffer = [];
          rawText += line + '\n';
          handleLine(line);
        } else if (b !== 13) {
          buffer.push(b); // 忽略 \r（CRLF 兼容）
        }
      }
    }
  } catch (e) {
    if (e instanceof AiTransportError) {
      // 已吐字的流不重试（重来会重复正文）；服务端明确报错本身已是 retryable=false
      throw fullText ? new AiTransportError(e.message, false) : e;
    }
    if (signal?.aborted) throw signal.reason ?? e;
    // 连接中途断掉（read 抛原生错误）：归传输级，未吐字时可重试
    throw new AiTransportError(
      t(lang, 'ai.read_failed', { msg: e instanceof Error ? e.message : String(e) }),
      !fullText,
    );
  } finally {
    // 解析出错/abort 中断时主动释放底层连接（未消费完的 body 不留挂起）
    try {
      await reader.cancel();
    } catch {
      // 已结束的流 cancel 会拒绝，忽略
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  if (!sawFrame) {
    // 服务端无视 stream 直接回了整段 JSON：按非流式格式解析（否则会被误判成空响应）
    const msg = parseMessageBody(rawText + decodeUtf8(buffer), res.status, lang);
    const content = msg.content ?? '';
    if (!content && !msg.tool_calls?.length)
      throw new AiTransportError(t(lang, 'ai.empty'), true); // 不回空正文给调用方
    if (content) emit(content);
    // 带工具调用的整段兜底必须回原 message 对象——agent 循环依赖 tool_calls 结构，
    // 降级成纯字符串会丢掉工具调用（2026-10 流式化后：循环请求也走流式，会落到本分支）
    if (msg.tool_calls?.length) {
      notifyToolName(msg.tool_calls.find((tc) => tc.function?.name)?.function?.name);
      return msg;
    }
    return onStreamChunk ? content : msg;
  }
  if (toolAcc.size > 0) {
    // 有产出但无终止标记：正文/工具调用可能被中间层静默掐断（干净 EOF）。
    // retryable=false——已产出的内容不可重发（口径同"已吐字的流不重试"），宁可失败让
    // 编排层落 failed/cancelled（部分正文已在行内），也不把截断结果当 completed 静默落库
    if (!sawDone) throw new AiTransportError(t(lang, 'ai.stream_truncated'), false);
    // 流式带工具：按 message 对象返回（与调用方传 stream:false 的预期一致），正文可空
    const tool_calls: ToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, type: 'function' as const, function: { name: v.name, arguments: v.args } }));
    return { role: 'assistant', content: fullText || null, tool_calls };
  }
  if (!fullText) throw new AiTransportError(t(lang, 'ai.empty'), true);
  if (!sawDone) throw new AiTransportError(t(lang, 'ai.stream_truncated'), false);
  // 调用方未要求增量（本次是降级重试）：按 message 对象返回，与它传 stream:false 的预期一致
  return onStreamChunk ? fullText : { role: 'assistant', content: fullText };
}

/** 正文 → message 对象（非流式与非 SSE 兜底共用）：空/破损正文给出可定位的传输级报错 */
function parseMessageBody(text: string, status: number, lang: Lang): ChatMessage {
  let msg: ChatMessage | undefined;
  try {
    msg = (JSON.parse(text) as { choices?: { message?: ChatMessage }[] })?.choices?.[0]?.message;
  } catch {
    throw badBodyError(status, text, lang);
  }
  if (!msg || (msg.content == null && !msg.tool_calls?.length))
    // 服务端给的是完整 JSON 但内容为空：属模型侧行为（非传输中断），重试无意义
    throw new AiTransportError(t(lang, 'ai.empty'), false);
  return msg;
}

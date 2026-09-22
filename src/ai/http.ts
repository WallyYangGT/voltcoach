/**
 * http.ts — chat/completions 请求层（自 reference/src/ai.js requestChatCompletion 平移，
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

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'AiTransportError';
    this.retryable = retryable;
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
 * 非 2xx 抛 `AI API 返回 {status}: {body 前 300 字}`（agent 循环的 tools 降级
 * 依据该格式识别 400，格式不可改）。
 *
 * 传输级失败（连接建立失败、空/破损正文、正文读取中断、429/5xx）自动重试一次：
 * 长报告请求可能已经等了数分钟，不重试就等于让用户手动再来一遍。
 * - **重试改用流式**（仅限不带 tools 的请求）：非流式长请求中途一行字节都不流动，
 *   最容易撞上网关/NAT 的空闲超时——真机"等半天后 JSON 解析失败"的现场形态；
 *   流式让字节持续流动，正文边收边攒。带 tools 的请求不切换（tool_calls 的增量帧
 *   与 SSE 组合解析复杂，保持非流式）。
 * - 已吐过字的流式响应不重试（正文已交给调用方，重来会造成重复内容）。
 * - 共用调用方的 signal：总超时预算不重置（首次失败若已耗掉大半预算，重试可能来不及）；
 *   等待期间被 abort 则不再补发。
 * 重试前经 onRetry 告知调用方（UI 进度）。
 */
export async function requestChatCompletion(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string,
  requestBody: object,
  { signal, onStreamChunk, onRetry, lang = 'zh', retryDelayMs = RETRY_DELAY_MS }: {
    signal?: AbortSignal;
    onStreamChunk?: (delta: string) => void;
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
          throw new AiTransportError(e.message + t(lang, 'ai.retried_note', { n: retried }), false);
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      retried += 1;
      onRetry?.(attempt + 1, msg);
      await new Promise((r) => setTimeout(r, retryDelayMs));
      // 等待期间超时/取消：不再补发（否则白发一次请求，错误还更晦涩）
      if (signal?.aborted) throw e;
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
  { signal, onStreamChunk, lang, forceStream = false }: {
    signal?: AbortSignal;
    onStreamChunk?: (delta: string) => void;
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
    throw new AiTransportError(`AI API 返回 ${res.status}: ${errBody.slice(0, 300)}`, retryable);
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
  const emit = (delta: string) => {
    fullText += delta;
    onStreamChunk?.(delta);
  };
  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    sawFrame = true;
    if (!data || data === '[DONE]') return; // 空 data 帧是部分网关的心跳，非错误
    let obj: {
      error?: { message?: string };
      choices?: { delta?: { content?: string }; message?: ChatMessage }[];
    };
    try {
      obj = JSON.parse(data);
    } catch {
      // 帧被截断（连接中断）→ 归为可重试的传输级错误
      throw new AiTransportError(t(lang, 'ai.bad_sse', { head: snippet(data) }));
    }
    if (obj.error) throw new AiTransportError(obj.error.message || JSON.stringify(obj.error), false);
    const choice = obj.choices?.[0];
    // 兼容两种形态：增量 delta（标准流式）与整段 message（部分账号不真正流式）。
    // ⚠️ 两种形态互斥：见过增量就不再认整段帧——部分网关会在 delta 流末尾补一帧带
    // message 的收尾帧，若无条件取 message.content，正文会被拼成两遍（静默污染落库正文）。
    const deltaContent = choice?.delta?.content;
    if (deltaContent) {
      sawDelta = true;
      emit(deltaContent);
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
    if (!content) throw new AiTransportError(t(lang, 'ai.empty'), true); // 不回空正文给调用方
    emit(content);
    return onStreamChunk ? content : msg;
  }
  if (!fullText) throw new AiTransportError(t(lang, 'ai.empty'), true);
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

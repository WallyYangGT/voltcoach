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

/** 手写 UTF-8 解码（仅用于完整行：调用方保证字节序列不含跨行断开的多字节字符） */
function decodeUtf8(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
    } else {
      cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      i += 4;
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

/**
 * 发起一次 chat/completions 请求。
 * 非流式（onStreamChunk 缺省）resolve 完整 message 对象（{content, tool_calls?}）；
 * 流式逐 chunk 回调 onStreamChunk 后 resolve 拼接的完整文本。
 * 非 2xx 抛 `AI API 返回 {status}: {body 前 300 字}`（agent 循环的 tools 降级
 * 依据该格式识别 400，格式不可改）。
 */
export async function requestChatCompletion(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string,
  requestBody: object,
  { signal, onStreamChunk }: { signal?: AbortSignal; onStreamChunk?: (delta: string) => void } = {},
): Promise<ChatMessage | string> {
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // 读错误体失败时只报状态码
    }
    throw new Error(`AI API 返回 ${res.status}: ${body.slice(0, 300)}`);
  }

  if (!onStreamChunk) {
    // 非流式：一次性收取完整 JSON 响应，resolve 完整 message 对象
    // （含 content 与可选的 tool_calls，供 runAgentLoop 的 function calling 使用）
    let msg: ChatMessage | undefined;
    try {
      msg = (await res.json())?.choices?.[0]?.message;
    } catch (e) {
      throw new Error(`AI API 响应解析失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!msg || (msg.content == null && !msg.tool_calls?.length))
      throw new Error(t('zh', 'ai.empty'));
    return msg;
  }

  // 流式：SSE 字节流按 \n 切行，逐行解析 data: 帧，delta 回调并拼接
  const reader = res.body?.getReader();
  if (!reader) throw new Error('AI API 流返回为空');
  let buffer: number[] = [];
  let fullText = '';
  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (data === '[DONE]') return;
    let obj: {
      error?: { message?: string };
      choices?: { delta?: { content?: string } }[];
    };
    try {
      obj = JSON.parse(data);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
    if (obj.error) throw new Error(obj.error.message || JSON.stringify(obj.error));
    const delta = obj.choices?.[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      onStreamChunk(delta);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const b of value) {
      if (b === 10) {
        const line = decodeUtf8(buffer);
        buffer = [];
        handleLine(line);
      } else if (b !== 13) {
        buffer.push(b); // 忽略 \r（CRLF 兼容）
      }
    }
  }
  if (!fullText) throw new Error(t('zh', 'ai.empty'));
  return fullText;
}

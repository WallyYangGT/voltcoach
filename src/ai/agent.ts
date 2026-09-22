/**
 * agent.ts — 单轮调用与 agentic 多轮循环（自 reference/src/ai.js callAI / runAgentLoop
 * 平移，逻辑不动只补类型；配置从全局 AI_CONFIG 改为参数注入——App 版生效配置由
 * db 层 getAiConfig() 取出后传入，node:test 注入 mock 配置即可全量断言）。
 *
 * callAI：调用 chat/completions 返回完整文本。默认非流式（长提示词在部分 API 上会
 * 整体生成后再下发，此时流式不吐字，非流式更稳）；AI_CONFIG.stream 只影响本函数。
 *
 * runAgentLoop（function calling）：循环 ≤ AGENTIC.max_rounds 轮，模型返回 tool_calls
 * 时逐个经 executeTool 执行并把结果以 role:"tool" 消息回填，直到模型返回普通正文。
 * 设计要点（与旧版一致）：
 * - 全部轮次走非流式（tool_calls 与 SSE 增量解析组合复杂、用户看不到中间轮）；
 * - 整个循环共享一个总超时预算（timeout_ms，不逐轮重置）+ 30 秒心跳；
 * - 模型/代理不支持 tools（带 tools 的首轮请求 HTTP 400）→ 自动降级为无 tools
 *   单轮调用并经 onDegrade 回调告知调用方（agentic 总开关由编排层决定：
 *   关闭时编排层直接走 callAI，不进本循环）；
 * - executeTool 抛出的异常被兜底为 {error} JSON 回填，循环不中断；
 * - 依赖注入：本函数不 import db / tools，fetch、配置、工具定义与执行器均由调用方传入。
 */

import { AGENTIC } from '../core/settings.ts';
import { t, type Lang } from '../core/i18n.ts';
import {
  requestChatCompletion,
  type AgentMessage,
  type ChatMessage,
  type FetchLike,
  type ToolCall,
} from './http.ts';

/** 运行时生效的 AI 配置（db 层 getAiConfig() 输出的形状，api_key 必已配置） */
export interface AiRuntimeConfig {
  base_url: string;
  api_key: string;
  model: string;
  temperature?: number | null;
  timeout_ms: number;
  stall_ms: number;
  stream: boolean;
}

/**
 * 调用 chat/completions，返回完整文本。
 * 支持两种调用方式：传入单条字符串 prompt（单条 user 消息），或 messages 数组
 * （直接作为 chat/completions 的 messages 参数，用于追问多轮对话）。
 * onRetry：传输级失败（空/破损正文、断连、429/5xx）触发自动重试时回调（UI 进度）。
 */
export async function callAI(
  fetchImpl: FetchLike,
  cfg: AiRuntimeConfig,
  promptOrMessages: string | AgentMessage[],
  { onChunk, onHeartbeat, onRetry, timeoutMs, lang = 'zh' }: {
    onChunk?: (delta: string) => void;
    onHeartbeat?: () => void;
    onRetry?: (nextAttempt: number, errMsg: string) => void;
    timeoutMs?: number;
    lang?: Lang;
  } = {},
): Promise<string> {
  if (!cfg.api_key) throw new Error(t(lang, 'ai.no_key'));
  const effectiveTimeoutMs = timeoutMs ?? cfg.timeout_ms;
  const useStream = cfg.stream;

  const messages: AgentMessage[] = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: 'user', content: promptOrMessages }];
  const request: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: useStream,
  };
  if (cfg.temperature != null) request.temperature = Number(cfg.temperature);

  const ctrl = new AbortController();
  const totalTimer = setTimeout(() => ctrl.abort(new Error('total timeout')), effectiveTimeoutMs);
  // 无论流式/非流式，都每 30 秒回调一次心跳，给调用方一个"还在等"的反馈
  const heartbeat = setInterval(() => onHeartbeat?.(), 30000);
  // 流式空闲超时：每收到一个内容 chunk 重置
  const stallMs = cfg.stall_ms;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(new Error('stall timeout')), stallMs);
  };

  try {
    const result = await requestChatCompletion(fetchImpl, cfg.base_url, cfg.api_key, request, {
      signal: ctrl.signal,
      onRetry,
      lang,
      onStreamChunk: useStream
        ? (delta) => {
            resetStall();
            onChunk?.(delta);
          }
        : undefined,
    });
    // 非流式 resolve 的是完整 message 对象，此处只取正文（callAI 不挂 tools）
    if (useStream) return result as string;
    if (!(result as ChatMessage).content) throw new Error(t(lang, 'ai.empty'));
    return (result as ChatMessage).content as string;
  } catch (e) {
    const reason = (ctrl.signal.reason as Error | undefined)?.message || (e instanceof Error ? e.message : '');
    if (reason === 'stall timeout') {
      throw new Error(t(lang, 'ai.stall', { sec: stallMs / 1000 }));
    }
    if (reason === 'total timeout' || (e as Error)?.name === 'AbortError' || /aborted|timeout/i.test(reason)) {
      throw new Error(t(lang, 'ai.total_timeout', { sec: effectiveTimeoutMs / 1000 }));
    }
    throw e;
  } finally {
    clearTimeout(totalTimer);
    if (stallTimer) clearTimeout(stallTimer);
    clearInterval(heartbeat);
  }
}

/** runAgentLoop 的可选项 */
export interface AgentLoopOpts {
  onHeartbeat?: () => void;
  onToolCall?: (name: string, args: object, result: string) => void;
  onDegrade?: (errMsg: string) => void;
  /** 传输级失败触发自动重试时回调（nextAttempt 从 2 起），供 UI 展示进度 */
  onRetry?: (nextAttempt: number, errMsg: string) => void;
  timeoutMs?: number;
  lang?: Lang;
}

/**
 * Agentic 多轮调用（function calling）：返回模型最终正文（各轮 assistant 正文取
 * 最长者，防中间轮写报告末轮只剩收尾片段）。tools 为空数组时等价单轮调用
 * （编排层 agentic 总开关关闭时直接走 callAI，与旧版 callAiMaybeAgentic 分工一致）。
 */
export async function runAgentLoop(
  fetchImpl: FetchLike,
  cfg: AiRuntimeConfig,
  messages: AgentMessage[],
  tools: object[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string> | string,
  { onHeartbeat, onToolCall, onDegrade, onRetry, timeoutMs, lang = 'zh' }: AgentLoopOpts = {},
): Promise<string> {
  if (!cfg.api_key) throw new Error(t(lang, 'ai.no_key'));
  const effectiveTimeoutMs = timeoutMs ?? cfg.timeout_ms;
  const maxRounds = AGENTIC.max_rounds;
  const useTools = Array.isArray(tools) && tools.length > 0;

  const ctrl = new AbortController();
  const totalTimer = setTimeout(() => ctrl.abort(new Error('total timeout')), effectiveTimeoutMs);
  // 每 30 秒回调一次心跳，给调用方一个"还在等"的反馈
  const heartbeat = setInterval(() => onHeartbeat?.(), 30000);

  const buildRequest = (msgs: AgentMessage[], toolDefs?: object[]) => {
    const req: Record<string, unknown> = { model: cfg.model, messages: msgs, stream: false };
    if (cfg.temperature != null) req.temperature = Number(cfg.temperature);
    if (toolDefs?.length) {
      req.tools = toolDefs;
      req.tool_choice = 'auto';
    }
    return req;
  };
  const callOnce = (msgs: AgentMessage[], toolDefs?: object[]) =>
    requestChatCompletion(fetchImpl, cfg.base_url, cfg.api_key, buildRequest(msgs, toolDefs), {
      signal: ctrl.signal,
      onRetry,
      lang,
    });

  try {
    const history: AgentMessage[] = [...messages];
    let toolsActive = useTools;
    // 各轮 assistant 正文中最长的一份。模型偶尔会把完整报告写在带 tool_calls 的
    // 中间轮、最后一轮只剩"分析已完成，如需……"式收尾片段——只取末轮正文会让
    // 报告整体丢失，故以最长正文为准（中间轮通常是简短过渡语，不影响正常场景）。
    let bestContent: string | null = null;
    for (let round = 0; round < maxRounds; round++) {
      let msg: ChatMessage;
      try {
        msg = (await callOnce(history, toolsActive ? tools : undefined)) as ChatMessage;
      } catch (e) {
        // 带 tools 的首轮请求被 400 拒绝 → 模型/代理不支持 tools，降级单轮
        if (toolsActive && round === 0 && /返回 400/.test(e instanceof Error ? e.message : '')) {
          onDegrade?.(e instanceof Error ? e.message : String(e));
          toolsActive = false;
          msg = (await callOnce(history, undefined)) as ChatMessage;
        } else {
          throw e;
        }
      }
      if (msg?.content && (bestContent == null || msg.content.length > bestContent.length))
        bestContent = msg.content;
      const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      if (!toolCalls.length) {
        if (bestContent) return bestContent;
        throw new Error(t(lang, 'ai.empty'));
      }
      // assistant 消息原样回填（含 tool_calls），再逐个执行并回填 tool 结果
      history.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        const name = tc?.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc?.function?.arguments || '{}');
        } catch {
          // arguments 不是合法 JSON 时按空参数处理，由工具侧校验报错
        }
        let result: string;
        try {
          result = await executeTool(name, args);
        } catch (e) {
          result = JSON.stringify({ error: `工具执行失败: ${e instanceof Error ? e.message : String(e)}` });
        }
        onToolCall?.(name, args, result);
        history.push({
          role: 'tool',
          tool_call_id: (tc as ToolCall).id,
          content: String(result),
        });
      }
    }
    // 轮数耗尽：去掉 tools 强制模型基于已获得的信息直接作答
    history.push({
      role: 'user',
      content: t(lang, 'ai.rounds_exhausted'),
    });
    const finalMsg = (await callOnce(history, undefined)) as ChatMessage;
    if (finalMsg?.content) {
      // 强制作答轮同样参与最长正文比较
      if (bestContent == null || finalMsg.content.length > bestContent.length)
        bestContent = finalMsg.content;
      return bestContent;
    }
    throw new Error(t(lang, 'ai.empty'));
  } catch (e) {
    const reason = (ctrl.signal.reason as Error | undefined)?.message || (e instanceof Error ? e.message : '');
    if (
      reason === 'total timeout' ||
      (e as Error)?.name === 'AbortError' ||
      /aborted|timeout/i.test(reason)
    ) {
      throw new Error(t(lang, 'ai.total_timeout', { sec: effectiveTimeoutMs / 1000 }));
    }
    throw e;
  } finally {
    clearTimeout(totalTimer);
    clearInterval(heartbeat);
  }
}

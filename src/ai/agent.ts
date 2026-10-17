/**
 * agent.ts — 单轮调用与 agentic 多轮循环（自 fit-reader Web 版 src/ai.js callAI / runAgentLoop
 * 平移，逻辑不动只补类型；配置从全局 AI_CONFIG 改为参数注入——App 版生效配置由
 * db 层 getAiConfig() 取出后传入，node:test 注入 mock 配置即可全量断言）。
 *
 * callAI：调用 chat/completions 返回完整文本。默认非流式（长提示词在部分 API 上会
 * 整体生成后再下发，此时流式不吐字，非流式更稳）；AI_CONFIG.stream 只影响本函数。
 *
 * runAgentLoop（function calling）：循环 ≤ AGENTIC.max_rounds 轮，模型返回 tool_calls
 * 时逐个经 executeTool 执行并把结果以 role:"tool" 消息回填，直到模型返回普通正文。
 * 设计要点：
 * - 轮次默认非流式（tool_calls 与 SSE 增量解析组合复杂、用户看不到中间轮）；
 *   incremental 选项（2026-10 SSE 增量落库）打开后轮次走流式、最优正文经 onProgress
 *   上抛，流式轮失败自动降非流式重试（降级梯子，兼容不支持 stream+tools 的端点）；
 * - 整个循环共享一个总超时预算（timeout_ms，不逐轮重置）+ 30 秒心跳；
 * - 模型/代理不支持 tools（带 tools 的首轮请求 HTTP 400）→ 自动降级为无 tools
 *   单轮调用并经 onDegrade 回调告知调用方（agentic 总开关由编排层决定：
 *   关闭时编排层直接走 callAI，不进本循环）；
 * - executeTool 抛出的异常被兜底为 {error} JSON 回填，循环不中断；
 * - signal：外部取消信号（编排层「取消生成」），以 AiCancelledError 为 abort reason，
 *   取消必须先于超时分类抛出（否则会被误报成总超时）；
 * - 依赖注入：本函数不 import db / tools，fetch、配置、工具定义与执行器均由调用方传入。
 */

import { AGENTIC } from '../core/settings.ts';
import { t, type Lang } from '../core/i18n.ts';
import { compactAgentHistory } from './agent-history.ts';
import {
  AiCancelledError,
  AiTransportError,
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
 * signal：外部取消信号（编排层"取消生成"按钮），abort 即中断请求与重试链；
 * forceStream：强制走流式传输（2026-10 增量落库：生成链路的传输一律流式，
 * 与 cfg.stream 的用户设置解耦——流式失败有整段 JSON 兜底与非流式重试梯子）。
 */
export async function callAI(
  fetchImpl: FetchLike,
  cfg: AiRuntimeConfig,
  promptOrMessages: string | AgentMessage[],
  { onChunk, onReasoningChunk, onHeartbeat, onRetry, timeoutMs, lang = 'zh', signal, forceStream }: {
    onChunk?: (delta: string) => void;
    /** 流式 reasoning 增量（推理模型思考过程；不进入返回值） */
    onReasoningChunk?: (delta: string) => void;
    onHeartbeat?: () => void;
    onRetry?: (nextAttempt: number, errMsg: string) => void;
    timeoutMs?: number;
    lang?: Lang;
    signal?: AbortSignal;
    forceStream?: boolean;
  } = {},
): Promise<string> {
  if (!cfg.api_key) throw new Error(t(lang, 'ai.no_key'));
  const effectiveTimeoutMs = timeoutMs ?? cfg.timeout_ms;
  const useStream = cfg.stream || forceStream === true;

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
  // 外部取消信号 → 内部 ctrl。⚠️ 取消身份不依赖 signal.reason——RN 的
  // AbortController polyfill 对 abort(reason) 的 reason 支持不可靠（冒烟实证：
  // reason 退化为默认 AbortError，消息含 "Aborted"，会被超时分类误报成总超时），
  // 故用闭包标志位做取消身份，agent 层把它转成 AiCancelledError 再上抛
  let externallyCancelled = false;
  const forwardAbort = () => {
    externallyCancelled = true;
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort);
  }
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
      // 思考帧同样证明连接在流动：长思考模型（reasoning 阶段可能远久于 stall_ms）
      // 不能因为还没吐正文就被空闲超时误杀（2026-10 生成过程可视化）
      onStreamReasoning: useStream
        ? (delta) => {
            resetStall();
            onReasoningChunk?.(delta);
          }
        : undefined,
    });
    // 非流式 resolve 的是完整 message 对象，此处只取正文（callAI 不挂 tools）
    if (useStream) return result as string;
    if (!(result as ChatMessage).content) throw new Error(t(lang, 'ai.empty'));
    return (result as ChatMessage).content as string;
  } catch (e) {
    // 用户取消必须先于超时分类抛出——否则会被下面的 /aborted|timeout/ 正则
    // 误报成"总超时"（取消不是故障，编排层要据此回写 cancelled 而非 failed）
    if (externallyCancelled || e instanceof AiCancelledError) throw new AiCancelledError();
    // 降级梯子（code-review P2-1）：forceStream 打开的流式失败（编排层强制流式，
    // 端点可能不支持 stream）→ 降非流式重试一次。仅限系统强制的流式——用户在设置里
    // 显式开启的 stream 失败时不静默改行为。agent 循环的梯子在 runAgentLoop 内。
    if (useStream && forceStream && e instanceof AiTransportError) {
      try {
        const fallback = (await requestChatCompletion(
          fetchImpl,
          cfg.base_url,
          cfg.api_key,
          { ...request, stream: false },
          { signal: ctrl.signal, onRetry, lang },
        )) as ChatMessage;
        if (!fallback.content) throw new Error(t(lang, 'ai.empty'));
        return fallback.content;
      } catch (e2) {
        // 降级请求在飞时被取消：此处已是 catch 体内，抛错不会再被本 catch 分类——
        // 必须就地恢复取消身份（否则裸 AbortError 逃出，RN 形态落 failed 而非
        // cancelled，code-review 二轮 P2 实证），其余错误原样上抛走既有分类
        if (externallyCancelled || e2 instanceof AiCancelledError) throw new AiCancelledError();
        throw e2;
      }
    }
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
    signal?.removeEventListener('abort', forwardAbort);
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
  /** 外部取消信号（编排层「取消生成」）：abort 即中断当前请求/工具轮与重试链 */
  signal?: AbortSignal;
  /**
   * 增量模式（2026-10 SSE 增量落库）：轮次走流式，最优正文一有增长即经 onProgress
   * 上抛（编排层节流落库 + UI 实时预览）。工具轮的短过渡语也会短暂成为最优正文，
   * 随最终报告轮被更长正文自然取代；进程死亡残留的中间文本会在补跑时被完整报告
   * 覆盖，可接受。记忆回顾轮等静默内部任务不开启（流式无收益，行为与旧版一致）。
   */
  incremental?: boolean;
  /** 增量模式下最优正文增长时回调（参数为当前累计正文，非增量分片） */
  onProgress?: (partial: string) => void;
  /** 工具开始执行时回调（UI「正在调用 X…」动态）；onToolCall 仍是完成时回调 */
  onToolStart?: (name: string) => void;
  /**
   * 每轮模型请求发出前回调（1 起，含降级重试与轮数耗尽强制作答轮）：
   * UI 据此切回「模型思考中」——填上「工具执行完 → 下一轮正文到达」之间原本
   * 完全静默的间隔（2026-10 生成过程可视化）。
   */
  onRoundStart?: (round: number) => void;
  /** 本轮首个正文分片到达（流式；不受 bestContent 长度门控）→ UI 切「生成中」 */
  onContentStart?: (round: number) => void;
  /**
   * 本轮累计 reasoning 文本（仅流式推理模型；agent 侧只保留尾部防无界增长）。
   * 供 UI 单行滚动展示思考过程；不进入返回值、不落库。
   */
  onReasoning?: (thinking: string) => void;
  /** 流式 tool_calls 首次拿到工具名（早于本地工具执行）→ UI 提前显示工具调用态 */
  onToolCallStream?: (name: string) => void;
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
  {
    onHeartbeat,
    onToolCall,
    onDegrade,
    onRetry,
    timeoutMs,
    lang = 'zh',
    signal,
    incremental,
    onProgress,
    onToolStart,
    onRoundStart,
    onContentStart,
    onReasoning,
    onToolCallStream,
  }: AgentLoopOpts = {},
): Promise<string> {
  if (!cfg.api_key) throw new Error(t(lang, 'ai.no_key'));
  const effectiveTimeoutMs = timeoutMs ?? cfg.timeout_ms;
  const maxRounds = AGENTIC.max_rounds;
  const useTools = Array.isArray(tools) && tools.length > 0;

  const ctrl = new AbortController();
  // 外部取消信号 → 内部 ctrl。⚠️ 取消身份不依赖 signal.reason（RN polyfill 对
  // abort(reason) 的 reason 支持不可靠，冒烟实证会退化为默认 AbortError 被误报
  // 成总超时），用闭包标志位做取消身份，agent 层转成 AiCancelledError 上抛
  let externallyCancelled = false;
  const forwardAbort = () => {
    externallyCancelled = true;
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort);
  }
  const totalTimer = setTimeout(() => ctrl.abort(new Error('total timeout')), effectiveTimeoutMs);
  // 每 30 秒回调一次心跳，给调用方一个"还在等"的反馈
  const heartbeat = setInterval(() => onHeartbeat?.(), 30000);

  // 增量模式走流式轮；一旦流式轮失败立即降级非流式（catch 的降级梯子），后续轮保持非流式
  let streaming = incremental === true;
  // 各轮 assistant 正文中最长的一份。模型偶尔会把完整报告写在带 tool_calls 的
  // 中间轮、最后一轮只剩"分析已完成，如需……"式收尾片段——只取末轮正文会让
  // 报告整体丢失，故以最长正文为准（中间轮通常是简短过渡语，不影响正常场景）。
  // 流式轮的累计正文一旦超过既有最优即上抛 onProgress（增量落库/实时预览的数据源）。
  let bestContent: string | null = null;
  // 本轮流式累计正文（非流式轮恒为空串）；callOnce 闭包引用，每轮开头重置
  let roundContent = '';
  // 本轮累计 reasoning（仅推理模型流式；只留尾部，UI 滚动展示用，不进入返回值）
  let roundReasoning = '';
  const REASONING_TAIL_CHARS = 2000;

  const buildRequest = (msgs: AgentMessage[], toolDefs?: object[]) => {
    const req: Record<string, unknown> = { model: cfg.model, messages: msgs, stream: streaming };
    if (cfg.temperature != null) req.temperature = Number(cfg.temperature);
    if (toolDefs?.length) {
      req.tools = toolDefs;
      req.tool_choice = 'auto';
    }
    return req;
  };
  const callOnce = (msgs: AgentMessage[], toolDefs: object[] | undefined, roundNo: number) =>
    // E1：请求体发送副本经 compactAgentHistory 压更旧的工具结果（history 本身不动，
    // tool_calls/tool_call_id 配对完整），防 8 轮 × 16k 结果的全量重发复利
    requestChatCompletion(
      fetchImpl,
      cfg.base_url,
      cfg.api_key,
      buildRequest(compactAgentHistory(msgs, {
        maxChars: AGENTIC.agent_history_max_chars,
        note: t(lang, 'ai.history_compacted'),
      }), toolDefs),
      {
        signal: ctrl.signal,
        // 传输级自动重试是同一轮的新请求：清掉旧尝试累计，防 reasoning 把旧思考带回来
        // （请求层只在未吐正文时重试，roundContent 理论为空，重置是防御性口径）
        onRetry: (attempt, errMsg) => {
          roundContent = '';
          roundReasoning = '';
          onRetry?.(attempt, errMsg);
        },
        lang,
        onStreamChunk: streaming
          ? (delta) => {
              // 首个正文分片就切「生成中」：onProgress 只在超过 bestContent 时上抛，
              // 若复用它会漏掉「最终轮开头已有字但还没超过中间轮过渡语」的窗口
              if (roundContent === '') onContentStart?.(roundNo);
              roundContent += delta;
              if (bestContent == null || roundContent.length > bestContent.length) {
                bestContent = roundContent;
                onProgress?.(bestContent);
              }
            }
          : undefined,
        onStreamReasoning: streaming
          ? (delta) => {
              roundReasoning = (roundReasoning + delta).slice(-REASONING_TAIL_CHARS);
              // 正文一旦开始就不再回退到思考态（少数端点会交错下发 reasoning）
              if (roundContent === '') onReasoning?.(roundReasoning);
            }
          : undefined,
        onStreamToolCall: streaming ? (name) => onToolCallStream?.(name) : undefined,
      },
    );
  // 轮边界统一入口：清空本轮累计并通知 UI 进入「模型思考中」（含降级重试/强制作答轮）
  const beginRound = (roundNo: number) => {
    roundContent = '';
    roundReasoning = '';
    onRoundStart?.(roundNo);
  };

  try {
    const history: AgentMessage[] = [...messages];
    let toolsActive = useTools;
    for (let round = 0; round < maxRounds; round++) {
      // 轮边界检查取消：abort 落在工具执行/轮间时，不必等下一次 fetch 拒绝才停
      if (externallyCancelled) throw new AiCancelledError();
      beginRound(round + 1);
      let msg: ChatMessage;
      try {
        msg = (await callOnce(history, toolsActive ? tools : undefined, round + 1)) as ChatMessage;
      } catch (e) {
        if (externallyCancelled || e instanceof AiCancelledError) throw new AiCancelledError();
        if (toolsActive && streaming) {
          // 降级梯子第一级：流式轮失败（传输级或 4xx）→ 本轮降非流式重试（保工具），
          // 兼容不支持 stream+tools 组合的端点；streaming 已置 false，后续轮保持非流式
          streaming = false;
          beginRound(round + 1);
          try {
            msg = (await callOnce(history, toolsActive ? tools : undefined, round + 1)) as ChatMessage;
          } catch (e2) {
            if (toolsActive && round === 0 && e2 instanceof AiTransportError && e2.httpStatus === 400) {
              // 第二级：非流式仍被 400 拒 → 模型/代理不支持 tools，弃工具降级单轮。
              // 先 beginRound 再 onDegrade：轮次事件会把状态切回「模型思考中」，顺序反了
              // 会把降级文案覆盖掉（1.5s 轮询下用户永远看不到提示）
              toolsActive = false;
              beginRound(round + 1);
              onDegrade?.(e2 instanceof Error ? e2.message : String(e2));
              msg = (await callOnce(history, undefined, round + 1)) as ChatMessage;
            } else {
              throw e2;
            }
          }
        } else if (
          toolsActive &&
          round === 0 &&
          e instanceof AiTransportError &&
          e.httpStatus === 400
        ) {
          // 非 incremental（或已降非流式）路径的既有降级：带 tools 首轮被 400 拒绝
          // → 模型/代理不支持 tools，降级单轮（类型化判定，不依赖错误消息文案）。
          // 同样先 beginRound 再写降级文案（防轮次事件覆盖提示）
          toolsActive = false;
          beginRound(round + 1);
          onDegrade?.(e instanceof Error ? e.message : String(e));
          msg = (await callOnce(history, undefined, round + 1)) as ChatMessage;
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
        onToolStart?.(name);
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
    beginRound(maxRounds + 1);
    const finalMsg = (await callOnce(history, undefined, maxRounds + 1)) as ChatMessage;
    if (finalMsg?.content) {
      // 强制作答轮同样参与最长正文比较
      if (bestContent == null || finalMsg.content.length > bestContent.length)
        bestContent = finalMsg.content;
      return bestContent;
    }
    throw new Error(t(lang, 'ai.empty'));
  } catch (e) {
    // 用户取消必须先于超时分类抛出（同 callAI——取消不是故障，编排层据此回写 cancelled）
    if (externallyCancelled || e instanceof AiCancelledError) throw new AiCancelledError();
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
    signal?.removeEventListener('abort', forwardAbort);
  }
}

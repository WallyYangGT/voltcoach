/**
 * aiGenerate.ts — AI 报告与对话的本地编排层（对标 reference/server.js 的
 * /api/ai 与 /api/ai/chat 端点：Web 版"202 + 轮询 + 服务端后台任务"改为
 * App 内 fire-and-forget 异步任务 + 落库状态，UI 轮询本地 db 看进度）。
 *
 * 流程口径与旧版一致：
 * - 报告：buildReportPrompt 组装基础提示词（含 skills，不含工具/记忆段）→
 *   createPendingAiReport 占位 → 后台任务在 agentic 开启时于提示词末尾追加
 *   工具指引与记忆段 → callAiMaybeAgentic 分流（runAgentLoop / 单轮 callAI）→
 *   回写 completed/failed；未配置密钥时 UI 用基础提示词走"复制提示词"兜底
 *   （与旧 Web 版返回 prompt 的形态一致，工具/记忆段只在真实调用时注入）。
 * - 对话：user 消息 + pending 占位落库 → 后台任务每轮按当前状态重拼系统段
 *   （首条 user 消息注入），历史只带 completed 正文 → 回填 completed/failed。
 * - 复用 findFollowUpChat 的"追问并入报告"模型；滚动清理在 db 层 CRUD 内完成。
 */

import {
  computeForm,
  createAiChat,
  createPendingAiReport,
  cyclingSummariesSince,
  getAiChat,
  getAiConfig,
  getAiReport,
  getEffectiveAthlete,
  getAthleteState,
  getProfile,
  listActivities,
  listMemories,
  monthlySummary,
  recentFormDaily,
  addAiChatMessage,
  touchAiChat,
  updateAiChatMessage,
  updateAiReport,
  getActivitySummary,
  saveMemory,
  type AiChatMode,
  type AiConfig,
  type AiReportContext,
  type AiReportMode,
} from '@/db';
import { loadDefaultFetch } from '@/ai/http';
import { callAI, runAgentLoop } from '@/ai/agent';
import { t, type Lang } from '@/core/i18n';
import { safeName, thinRecords } from '@/core/records';

import { thinToWeekly, buildReviewPrompt, buildPlanPrompt, buildTaperPrompt, buildComparePrompt, buildAgenticSection, buildMemorySection } from '@/prompts/prompts';
import { buildSkillsSection } from '@/prompts/skills';
import { buildChatSystemSection } from '@/prompts/chat';
import { toolDefs, createExecuteTool, type ToolIo } from '@/tools';
import { loadStoredRecords } from '@/records-store';

// ---------------- ToolIo 绑定（db + records-store → 工具层数据访问） ----------------

function buildToolIo(): ToolIo {
  return {
    listActivities: () => listActivities(200),
    getActivitySummary: (name) => getActivitySummary(name),
    loadRecords: async (name, opts) => {
      const records = await loadStoredRecords(name);
      if (!records) return null;
      return thinRecords(records, opts);
    },
    recentFormDaily: (days) => recentFormDaily(days),
    monthlySummary: (n) => monthlySummary(n),
    getAthleteState: () => getAthleteState(),
    getProfile: () => getProfile(),
    cyclingSummariesSince: (days) => cyclingSummariesSince(days),
    computeForm: (date) => computeForm(date, 'zh'),
    saveMemory: (input, lang) => saveMemory(input, lang),
  };
}

/** 取运行时生效配置；未配置密钥抛双语 Error（界面直接透传）。返回值 api_key 已保证非空 */
async function requireAiConfig(lang: Lang): Promise<AiConfig & { api_key: string }> {
  const { config, configured } = await getAiConfig();
  if (!configured || !config.api_key) throw new Error(t(lang, 'srv.ai_key_missing'));
  return { ...config, api_key: config.api_key };
}

/**
 * callAiMaybeAgentic（对标 server.js 同名函数）：agentic 开启走 runAgentLoop
 * （工具 schema 与执行器按语言装配，source 作为 save_memory 的场景标记），
 * 关闭走单轮 callAI。执行结果仅打日志，用户只见最终正文（口径同旧版）。
 * onRetry：传输层自动重试回调（透传到 UI 进度：长请求等了几分钟后被网关掐断时，
 * 用户需要知道"正在自动重试"而不是看着一个不动的转圈）。
 */
async function callAiMaybeAgentic(
  config: AiConfig & { api_key: string },
  messages: Parameters<typeof runAgentLoop>[2],
  opts: {
    source: string | null;
    lang: Lang;
    onRetry?: (nextAttempt: number, errMsg: string) => void;
  },
): Promise<string> {
  const fetchImpl = await loadDefaultFetch();
  if (config.agentic !== false) {
    return runAgentLoop(fetchImpl, config, messages, toolDefs(opts.lang), createExecuteTool(buildToolIo(), { source: opts.source, lang: opts.lang }), {
      lang: opts.lang,
      onRetry: opts.onRetry,
      onToolCall: (name, _args, result) => {
        // 只打工具名与结果长度：args 可能携带 save_memory 的用户个人事实，不落 logcat
        const chars = typeof result === 'string' ? result.length : 0;
        console.log(`[AI tool] ${name} → ${chars} 字符`);
      },
      onDegrade: (errMsg) => console.warn(`[AI] 模型不支持 tools，已降级为单轮调用（${errMsg}）`),
    });
  }
  return callAI(fetchImpl, config, messages, { lang: opts.lang, onRetry: opts.onRetry });
}

// ---------------- 报告：prompt 组装与生成任务 ----------------

/**
 * 组装报告基础提示词（对标 server.js buildPromptForMode）：数据取数 + 四场景
 * builder。skills 四场景统一注入；该提示词也是"复制提示词"兜底模式的产出
 * （agentic 工具指引与记忆段只在真实调用时追加，复制出去的提示词无法回调本机）。
 */
export async function buildReportPrompt(
  mode: AiReportMode,
  context: AiReportContext,
  lang: Lang = 'zh',
): Promise<string> {
  const [profile, athlete] = await Promise.all([getProfile(), getEffectiveAthlete()]);
  const skills = buildSkillsSection(lang);
  if (mode === 'review') {
    const name = safeName(String(context.file_name ?? ''));
    const summary = name ? await getActivitySummary(name) : null;
    if (!summary)
      throw new Error(t(lang, 'tool.summary_not_found', { name: context.file_name ?? '(未提供)' }));
    return buildReviewPrompt(summary, athlete, profile, skills, lang);
  }
  if (mode === 'plan') {
    const daily = await recentFormDaily(56);
    if (!daily.length) throw new Error(t(lang, 'srv.library_empty'));
    return buildPlanPrompt(
      {
        months: await monthlySummary(3),
        formSeries: thinToWeekly(daily),
        recentActivities: await listActivities(10),
      },
      athlete,
      profile,
      skills,
      lang,
    );
  }
  if (mode === 'taper') {
    const raceDate = context.race_date;
    if (!raceDate || !/^\d{4}-\d{2}-\d{2}$/.test(raceDate))
      throw new Error(t(lang, 'srv.race_date'));
    const today = new Date().toISOString().slice(0, 10);
    const form = await computeForm(today, lang);
    if (!form) throw new Error(t(lang, 'srv.library_empty'));
    const daysLeft = Math.round(
      (Date.parse(raceDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000,
    );
    return buildTaperPrompt(
      {
        raceDate,
        daysLeft,
        form,
        formSeries: thinToWeekly(await recentFormDaily(56)),
        recentActivities: await listActivities(10),
      },
      athlete,
      profile,
      skills,
      lang,
    );
  }
  if (mode === 'compare') {
    const a = safeName(String(context.file_name ?? ''));
    const b = safeName(String(context.compare_with ?? ''));
    const sa = a ? await getActivitySummary(a) : null;
    const sb = b ? await getActivitySummary(b) : null;
    if (!sa || !sb) throw new Error(t(lang, 'srv.compare_not_found'));
    return buildComparePrompt(sa, sb, athlete, profile, skills, lang);
  }
  throw new Error(t(lang, 'srv.unknown_mode', { mode }));
}

/**
 * 创建报告占位记录（status=pending）：先组装并落库 prompt（供失败后追溯与
 * 追问场景引用），再由 UI 跳转详情页并 fire generateReport。
 */
export async function createReportDraft(
  mode: AiReportMode,
  context: AiReportContext,
  lang: Lang = 'zh',
): Promise<number> {
  const prompt = await buildReportPrompt(mode, context, lang);
  return createPendingAiReport(mode, context, prompt);
}

// 运行中注册表（进程内）：同一任务不重复 fire；UI 侧据此判断 pending 占位是
// "生成中"还是"应用被杀留下的残留"（残留时重跑以恢复——提示词/系统段均已落库）
const runningReports = new Set<number>();
const runningChats = new Set<string>();

/** 生成进度（进程内）：传输级自动重试的现场信息，UI 轮询时同步读取展示 */
export interface GenProgress {
  attempt: number; // 下一次尝试的序号（2 = 首次响应异常、正在重试）
  note: string; // 上一次失败的原因（原文，便于诊断网关/网络问题）
}
const reportProgress = new Map<number, GenProgress>();
const chatProgress = new Map<string, GenProgress>();

/** 报告生成是否正在进行（会话详情页的恢复判断用） */
export function isReportGenerating(reportId: number): boolean {
  return runningReports.has(reportId);
}

/** 报告当前的重试进度（无重试/未运行返回 null） */
export function getReportProgress(reportId: number): GenProgress | null {
  return reportProgress.get(reportId) ?? null;
}

/** 对话消息生成是否正在进行 */
export function isChatGenerating(chatId: number, messageId: number): boolean {
  return runningChats.has(`${chatId}:${messageId}`);
}

/** 对话消息当前的重试进度（无重试/未运行返回 null） */
export function getChatProgress(chatId: number, messageId: number): GenProgress | null {
  return chatProgress.get(`${chatId}:${messageId}`) ?? null;
}

/**
 * 报告生成任务（fire-and-forget）：读回占位记录的 prompt，agentic 开启时追加
 * 工具指引与记忆段，生成结果回写 completed；失败回写 failed + error（UI 轮询
 * db 状态展示）。应用中途被杀只留下 pending 占位——再次进入详情页时重跑本
 * 函数即可（系统段与提示词均已落库，无会话态丢失）。
 * 传输级失败（空/破损正文、断连、429/5xx）由传输层自动重试一次，重试进度经
 * getReportProgress 透出（长请求被网关掐断是 2026-09-22 真机事故的现场形态）。
 */
export async function generateReport(reportId: number, lang: Lang = 'zh'): Promise<void> {
  if (runningReports.has(reportId)) return; // 同一报告不重复 fire
  runningReports.add(reportId);
  try {
    const config = await requireAiConfig(lang);
    const report = await getAiReport(reportId);
    if (!report) throw new Error(t(lang, 'srv.report_not_found'));
    let finalPrompt = report.prompt;
    if (config.agentic !== false) {
      finalPrompt += '\n\n' + buildAgenticSection(lang);
      finalPrompt += '\n\n' + buildMemorySection(await listMemories(), lang);
    }
    const markdown = await callAiMaybeAgentic(
      config,
      [{ role: 'user', content: finalPrompt }],
      {
        source: report.mode, // 场景标记：save_memory 写入 ai_memories.source
        lang,
        onRetry: (attempt, errMsg) => {
          reportProgress.set(reportId, { attempt, note: errMsg });
          console.warn(`[AI] 报告 #${reportId} 响应异常，自动重试（第 ${attempt} 次）：${errMsg}`);
        },
      },
    );
    await updateAiReport(reportId, { markdown, status: 'completed', error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateAiReport(reportId, { status: 'failed', error: msg });
    console.error(`[AI] 后台分析失败: ${msg}`);
  } finally {
    runningReports.delete(reportId);
    reportProgress.delete(reportId);
  }
}

// ---------------- 对话：提交与后台生成 ----------------

export interface SubmitChatParams {
  /** 继续既有对话时传 id；缺省新建（title 取首条消息前 50 字） */
  chatId?: number | null;
  mode: AiChatMode;
  message: string;
  /** follow_up：关联报告与训练文件 */
  reportId?: number | null;
  fileName?: string | null;
}

/**
 * 提交一条对话消息：校验 → user 消息 + pending 占位落库 → 返回 id 供 UI 立即
 * 跳转/刷新；随后 fire runChatGeneration 完成后台生成（口径与旧版 /api/ai/chat 一致）。
 */
export async function submitChatMessage(
  params: SubmitChatParams,
  lang: Lang = 'zh',
): Promise<{ chatId: number; messageId: number }> {
  await requireAiConfig(lang);
  if (params.mode !== 'follow_up' && params.mode !== 'chat')
    throw new Error(t(lang, 'srv.mode_invalid'));
  const message = String(params.message ?? '').trim();
  if (!message) throw new Error(t(lang, 'srv.message_empty'));
  if (message.length > 2000)
    throw new Error(t(lang, 'srv.message_too_long', { n: 2000 }));

  let chatId = params.chatId ?? null;
  if (chatId != null) {
    // 继续既有对话：校验存在，沿用其 mode/report_id/file_name
    if (!Number.isInteger(chatId) || chatId <= 0)
      throw new Error(t(lang, 'srv.chat_id_invalid'));
    if (!(await getAiChat(chatId))) throw new Error(t(lang, 'srv.chat_not_found'));
  } else {
    const reportId = Number(params.reportId);
    chatId = await createAiChat(params.mode, {
      report_id: Number.isInteger(reportId) && reportId > 0 ? reportId : null,
      file_name: params.fileName ? safeName(params.fileName) : null,
      title: message.slice(0, 50),
    });
  }
  await addAiChatMessage(chatId, 'user', message);
  const messageId = await addAiChatMessage(chatId, 'assistant', '', 'pending');
  await touchAiChat(chatId);
  return { chatId, messageId };
}

/** 对话系统段：按当前状态重拼（记忆/备注/profile 修改即时生效） */
async function buildChatSystem(chat: NonNullable<Awaited<ReturnType<typeof getAiChat>>>, agentic: boolean, lang: Lang): Promise<string> {
  const [athlete, profile, memories] = await Promise.all([getEffectiveAthlete(), getProfile(), listMemories()]);
  // 专业知识库只注入 chat 直接对话；follow_up 快答场景不注入（口径同旧版）
  const skills = chat.mode === 'chat' ? buildSkillsSection(lang) : null;
  // follow_up：关联报告正文 + 压缩训练数据（报告可能已被滚动清理，缺则仅靠训练数据）
  const rep = chat.report_id != null ? await getAiReport(chat.report_id) : null;
  const summary = chat.mode === 'follow_up' && chat.file_name ? await getActivitySummary(chat.file_name) : null;
  return buildChatSystemSection(
    {
      mode: chat.mode,
      agentic,
      athlete,
      profile,
      skills,
      memories,
      now: new Date(),
      reportMarkdown: rep?.markdown ?? null,
      summary,
    },
    lang,
  );
}

/**
 * 对话后台生成任务：系统段每轮重拼（首条 user 消息注入），历史只带 completed
 * 正文（排除 pending 占位与失败消息），结果回写占位消息 completed/failed。
 * 应用中途被杀留下的 pending 占位，重进会话页时以同一 messageId 重跑本函数即可。
 */
export async function runChatGeneration(chatId: number, messageId: number, lang: Lang = 'zh'): Promise<void> {
  const key = `${chatId}:${messageId}`;
  if (runningChats.has(key)) return; // 同一消息不重复 fire
  runningChats.add(key);
  try {
    const config = await requireAiConfig(lang);
    const chat = await getAiChat(chatId);
    if (!chat) throw new Error(t(lang, 'srv.chat_not_found'));
    const history = chat.messages
      .filter((m) => m.status === 'completed' && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    const system = await buildChatSystem(chat, config.agentic !== false, lang);
    const markdown = await callAiMaybeAgentic(
      config,
      [{ role: 'user', content: system }, ...history],
      {
        source: chat.mode, // 场景标记：save_memory 写入 ai_memories.source
        lang,
        onRetry: (attempt, errMsg) => {
          chatProgress.set(key, { attempt, note: errMsg });
          console.warn(`[AI chat] ${key} 响应异常，自动重试（第 ${attempt} 次）：${errMsg}`);
        },
      },
    );
    await updateAiChatMessage(messageId, { content: markdown, status: 'completed', error: null });
    await touchAiChat(chatId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateAiChatMessage(messageId, { status: 'failed', error: msg });
    await touchAiChat(chatId); // 失败同样刷新 updated_at（列表排序与旧版一致）
    console.error(`[AI chat] 后台生成失败: ${msg}`);
  } finally {
    runningChats.delete(key);
    chatProgress.delete(key);
  }
}

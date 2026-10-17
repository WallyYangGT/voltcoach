/**
 * aiGenerate.ts — AI 报告与对话的本地编排层（对标 fit-reader Web 版 server.js 的
 * /api/ai 与 /api/ai/chat 端点：Web 版"202 + 轮询 + 服务端后台任务"改为
 * App 内 fire-and-forget 异步任务 + 落库状态，UI 轮询本地 db 看进度）。
 *
 * 流程口径与旧版一致：
 * - 报告：buildReportPrompt 组装基础提示词（含 skills，不含工具/记忆段）→
 *   createPendingAiReport 占位 → 后台任务在 agentic 开启时于提示词末尾追加
 *   工具指引与记忆段 → callAiMaybeAgentic 分流（runAgentLoop / 单轮 callAI）→
 *   回写 completed/failed/cancelled；完成后编排层强制跑一次记忆回顾轮
 *   （runMemoryReviewRound，仅 save_memory 单工具，2026-10-13 拍板）——
 *   mem.rule.2「收尾补记」的编排层兜底；未配置密钥时 UI 用基础提示词走
 *   "复制提示词"兜底（与旧 Web 版返回 prompt 的形态一致，工具/记忆段只在
 *   真实调用时注入）。
 * - 对话：user 消息 + pending 占位落库 → 后台任务每轮按当前状态重拼系统段
 *   （首条 user 消息注入），历史只带 completed 正文 → 回填 completed/failed。
 * - 复用 findFollowUpChat 的"追问并入报告"模型；滚动清理在 db 层 CRUD 内完成。
 * 2026-10 增量落库 + 取消（架构评审 P2）：生成传输一律流式，流式最优正文经
 * shouldFlushPartial 节流回写 pending 行（UI 实时预览）；cancelXxxGeneration
 * abort 在跑任务 → 回写 cancelled + 保留部分正文（不命中补跑/续跑扫描，不复活）。
 */

import {
  computeForm,
  createAiChat,
  createPendingAiReport,
  cancelPendingAiReport,
  cancelPendingChatMessage,
  cyclingSummariesSince,
  getAiChat,
  getAiConfig,
  getAiReport,
  getCurrentPlan,
  getDossier,
  getEffectiveAthlete,
  getAthleteState,
  getProfile,
  listActivities,
  listMemories,
  monthlySummary,
  recentFormDaily,
  addAiChatMessage,
  recordPlanReportLink,
  savePlanVersion,
  touchAiChat,
  updateAiChatMessage,
  updateAiReport,
  getActivitySummary,
  listActivityRideKeys,
  listPendingAiReportRefs,
  listPendingChatMessageRefs,
  getChatSummary,
  saveChatSummary,
  saveMemory,
  setProfile,
  type AiChatMode,
  type AiConfig,
  type AiReportContext,
  type AiReportMode,
} from '@/db';
import { AiCancelledError, loadDefaultFetch } from '@/ai/http';
import {
  acquireGenerationKeepAlive,
  type KeepAliveHandle,
} from '@/ai/keepalive';
import { callAI, runAgentLoop } from '@/ai/agent';
import { t, type Lang } from '@/core/i18n';
import { localDay, localDayFromUtc } from '@/core/local-day';
import { CONTEXT_BUDGET } from '@/core/settings';
import type { AthleteDossier } from '@/core/dossier';
import { shouldFlushPartial, withinResumeWindow } from '@/core/report-status';
import { safeName, thinRecords } from '@/core/records';
import { extractPlanFromMarkdown, validateTrainingPlan } from '@/core/training-plan';
import { buildSummaryInput, normalizeSummaryOutput, shouldSummarize } from '@/core/chat-summary';

import { thinToWeekly, buildReviewPrompt, buildPlanPrompt, buildTaperPrompt, buildComparePrompt, buildAgenticSection, buildChatSummaryPrompt, buildDossierSection, buildMemorySection, buildMemoryReviewPrompt, withLocalActivityDate, withLocalActivityDates } from '@/prompts/prompts';
import { buildSkillsSection } from '@/prompts/skills';
import { buildChatSystemSection } from '@/prompts/chat';
import { rankMemories } from '@/prompts/memory-rank';
import { windowChatHistory } from '@/prompts/history';
import { toolDefs, createExecuteTool, type ToolIo } from '@/tools';
import { loadStoredRecords } from '@/records-store';
import { getRideStartAt } from './aiTitle';
import { applyAiFtpUpdate } from './ftp-apply';
import { reanalyzeActivity } from './reanalyze';
import { setPowerFlagAndRefresh, recalibrateActivityPower } from './power-calib';

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
    readRecordStart: (name) => getRideStartAt(name),
    recentFormDaily: (days) => recentFormDaily(days),
    monthlySummary: (n) => monthlySummary(n),
    getAthleteState: () => getAthleteState(),
    getProfile: () => getProfile(),
    setRiderProfile: (partial, lang) => setProfile(partial, lang),
    cyclingSummariesSince: (days) => cyclingSummariesSince(days),
    computeForm: (date) => computeForm(date, 'zh'),
    saveMemory: (input, lang) => saveMemory(input, lang),
    getDossier: () => getDossier(),
    getTrainingPlan: getCurrentPlan,
    savePlanVersion,
    setPowerFlag: (name, flagged, lang, reason) => setPowerFlagAndRefresh(name, flagged, lang, reason),
    recalibratePower: (name, scale, lang) => recalibrateActivityPower(name, scale, lang),
    applyFtpUpdate: (lang) => applyAiFtpUpdate(lang),
    reanalyzeActivity: (name, lang) => reanalyzeActivity(name, lang),
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
 * signal/onProgress/onActivity：取消信号、增量正文上抛、工具调用动态（2026-10
 * 增量落库 + 取消）。生成链路传输一律流式（agentic 循环走 incremental，单轮走
 * forceStream），流式失败各有降级梯子兜底。
 */
async function callAiMaybeAgentic(
  config: AiConfig & { api_key: string },
  messages: Parameters<typeof runAgentLoop>[2],
  opts: {
    source: string | null;
    lang: Lang;
    /** 对话类调用标记（chat/follow_up/plan 会话）：update_training_plan 等写类工具的放行依据 */
    chat?: boolean;
    onRetry?: (nextAttempt: number, errMsg: string) => void;
    signal?: AbortSignal;
    onProgress?: (partial: string) => void;
    /** 工具调用动态（开始/完成/降级），编排层写进 GenProgress.activity 供 UI 轮询展示 */
    onActivity?: (note: string) => void;
  },
): Promise<string> {
  const fetchImpl = await loadDefaultFetch();
  if (config.agentic !== false) {
    return runAgentLoop(fetchImpl, config, messages, toolDefs(opts.lang), createExecuteTool(buildToolIo(), { source: opts.source, lang: opts.lang, chat: opts.chat }), {
      lang: opts.lang,
      onRetry: opts.onRetry,
      signal: opts.signal,
      incremental: true,
      onProgress: opts.onProgress,
      onToolStart: (name) => opts.onActivity?.(t(opts.lang, 'ai.toolRunning', { name })),
      onToolCall: (name, _args, result) => {
        // 只打工具名与结果长度：args 可能携带 save_memory 的用户个人事实，不落 logcat
        const chars = typeof result === 'string' ? result.length : 0;
        console.log(`[AI tool] ${name} → ${chars} 字符`);
        opts.onActivity?.(t(opts.lang, 'ai.toolDone', { name, chars }));
      },
      onDegrade: (errMsg) => {
        console.warn(`[AI] 模型不支持 tools，已降级为单轮调用（${errMsg}）`);
        opts.onActivity?.(t(opts.lang, 'ai.degraded'));
      },
    });
  }
  let acc = '';
  return callAI(fetchImpl, config, messages, {
    lang: opts.lang,
    onRetry: opts.onRetry,
    signal: opts.signal,
    forceStream: true,
    onChunk: opts.onProgress
      ? (delta) => {
          acc += delta;
          opts.onProgress?.(acc);
        }
      : undefined,
  });
}

// ---------------- 报告：prompt 组装与生成任务 ----------------

/**
 * 活动行的首帧时刻映射（withLocalActivityDates 入参；getRideStartAt 自带进程内
 * 缓存，同屏/同会话重复装配不再读盘）。
 */
async function rideStartsOf(rows: { file_name: string }[]): Promise<Map<string, string | null>> {
  const starts = new Map<string, string | null>();
  for (const r of rows) starts.set(r.file_name, await getRideStartAt(r.file_name));
  return starts;
}

/** 锚 UTC 日 → 本地日历日（按当日任一骑行的首帧换算）；当日无骑行或无首帧返回 null */
async function localDayOfRideDay(utcDay: string): Promise<string | null> {
  const rides = await listActivityRideKeys();
  const hit = rides.find((r) => r.sport === 'cycling' && r.date === utcDay);
  if (!hit) return null;
  return localDayFromUtc(await getRideStartAt(hit.file_name));
}

/**
 * 档案段入参的锚日本地化（喂模型前，settings 缓存不动）：锚骑行首帧时刻换算
 * 本地日历日，与「当前时间」段同日历；换算失败保持 UTC 原值。工具层 get_dossier
 * 的同款整形（含 8 周周界重排）在 tools/execute.ts。
 */
async function localAnchorDossier(dossier: AthleteDossier | null): Promise<AthleteDossier | null> {
  if (!dossier?.anchor_date) return dossier;
  const local = await localDayOfRideDay(dossier.anchor_date);
  return local && local !== dossier.anchor_date ? { ...dossier, anchor_date: local } : dossier;
}

/**
 * 组装报告基础提示词（对标 server.js buildPromptForMode）：数据取数 + 四场景
 * builder。skills 四场景统一注入；该提示词也是"复制提示词"兜底模式的产出
 * （agentic 工具指引与记忆段只在真实调用时追加，复制出去的提示词无法回调本机）。
 * 双口径统一（2026-10）：数据面的纯日期字段（activity.date / 活动行清单 / 档案锚日）
 * 喂模型前换算为本地日历日；体能走势序列的 UTC 聚合口径在段落标题内注明。
 */
export async function buildReportPrompt(
  mode: AiReportMode,
  context: AiReportContext,
  lang: Lang = 'zh',
): Promise<string> {
  const [profile, athlete] = await Promise.all([getProfile(), getEffectiveAthlete()]);
  const skills = buildSkillsSection(lang, undefined, CONTEXT_BUDGET.skills_max_chars);
  // 个人训练档案段（本地聚合长期基线；无骑行数据为 null 整段省略——首次使用/
  // 空库时提示词与旧形态一致）
  const dossierSection = buildDossierSection(await localAnchorDossier(await getDossier()), lang);
  if (mode === 'review') {
    const name = safeName(String(context.file_name ?? ''));
    const summary = name ? await getActivitySummary(name) : null;
    if (!summary)
      throw new Error(t(lang, 'tool.summary_not_found', { name: context.file_name ?? '(未提供)' }));
    return buildReviewPrompt(withLocalActivityDate(summary, name ? await getRideStartAt(name) : null), athlete, profile, skills, lang, new Date(), dossierSection);
  }
  if (mode === 'plan') {
    const daily = await recentFormDaily(56);
    if (!daily.length) throw new Error(t(lang, 'srv.library_empty'));
    const recent = await listActivities(10);
    return buildPlanPrompt(
      {
        months: await monthlySummary(3),
        formSeries: thinToWeekly(daily),
        recentActivities: withLocalActivityDates(recent, await rideStartsOf(recent)),
      },
      athlete,
      profile,
      skills,
      lang,
      new Date(),
      dossierSection,
    );
  }
  if (mode === 'taper') {
    const raceDate = context.race_date;
    if (!raceDate || !/^\d{4}-\d{2}-\d{2}$/.test(raceDate))
      throw new Error(t(lang, 'srv.race_date'));
    // today 用本地日历日：race_date 是模型/用户按本地日历给的，daysLeft 同日历相减
    // 才不出一天偏差（UTC+8 清晨原实现整体后移一天）
    const today = localDay();
    const form = await computeForm(today, lang);
    if (!form) throw new Error(t(lang, 'srv.library_empty'));
    const daysLeft = Math.round(
      (Date.parse(raceDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000,
    );
    const recent = await listActivities(10);
    return buildTaperPrompt(
      {
        raceDate,
        daysLeft,
        form,
        formSeries: thinToWeekly(await recentFormDaily(56)),
        recentActivities: withLocalActivityDates(recent, await rideStartsOf(recent)),
      },
      athlete,
      profile,
      skills,
      lang,
      new Date(),
      dossierSection,
    );
  }
  if (mode === 'compare') {
    const a = safeName(String(context.file_name ?? ''));
    const b = safeName(String(context.compare_with ?? ''));
    const sa = a ? await getActivitySummary(a) : null;
    const sb = b ? await getActivitySummary(b) : null;
    if (!sa || !sb || !a || !b) throw new Error(t(lang, 'srv.compare_not_found'));
    return buildComparePrompt(
      withLocalActivityDate(sa, await getRideStartAt(a)),
      withLocalActivityDate(sb, await getRideStartAt(b)),
      athlete,
      profile,
      skills,
      lang,
      new Date(),
      dossierSection,
    );
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
// 在跑任务的取消控制器（2026-10 取消按钮）：cancelXxxGeneration 据此 abort，
// 与注册表同生命周期（finally 移除），任务结束后 key 必然查不到
const reportAborts = new Map<number, AbortController>();
const chatAborts = new Map<string, AbortController>();

/** 生成进度（进程内）：传输级自动重试的现场信息 + 工具调用动态，UI 轮询时同步读取展示 */
export interface GenProgress {
  attempt: number; // 下一次尝试的序号（2 = 首次响应异常、正在重试）
  note: string; // 上一次失败的原因（原文，便于诊断网关/网络问题）
  /** 当前动作提示（「正在调用 X…」/「✓ X · N 字符」/降级提示），瞬态不落库 */
  activity?: string;
}
const reportProgress = new Map<number, GenProgress>();
const chatProgress = new Map<string, GenProgress>();

/** 写活动提示：保留既有重试进度字段，只换 activity（轮询读的是同一 Map） */
function setActivity<K>(map: Map<K, GenProgress>, key: K, activity: string) {
  const prev = map.get(key);
  map.set(key, { attempt: prev?.attempt ?? 0, note: prev?.note ?? '', activity });
}

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
 * 2026-10 增量落库 + 取消：流式最优正文经 shouldFlushPartial 节流回写 pending 行
 * （生成中 UI 实时预览的数据源；进程死亡残留的部分正文会在补跑时被完整报告覆盖）；
 * cancelReportGeneration abort 在跑任务后回写 cancelled（部分正文保留），传输层
 * 的重试链随 signal aborted 自动失效。返回 started：同一报告已有任务在跑时为
 * false（**立即**返回，任务未受影响）；为 true 时要等整个生成任务结束（completed/
 * failed/cancelled 均已回写）才 resolve——不是"是否成功发起"的同步信号。M5 起
 * 调用方可感知 no-op，UI 按钮的禁用态以 isReportGenerating 为准。
 */
export async function generateReport(reportId: number, lang: Lang = 'zh'): Promise<{ started: boolean }> {
  if (runningReports.has(reportId)) return { started: false }; // 同一报告不重复 fire
  runningReports.add(reportId);
  const ctrl = new AbortController();
  reportAborts.set(reportId, ctrl);
  // 保活句柄：acquire 之前的 fast-fail 路径（未配对 acquire）下保持 null，
  // finally 的可选 release 是 no-op——不会偷走并发任务的保活引用（code-review P1-2）
  let keepAlive: KeepAliveHandle | null = null;
  // 增量落库节流状态：flushedLen/lastFlushAt 是上次写库的水位，latestPartial 留存
  // 最新正文供取消时无条件补写（cancel 可能落在两次节流写之间）。pendingFlush 把
  // 节流写串行化（onProgress 的触发频率高于写盘耗时），终态写前先等它落地——防止
  // 在途的部分正文写晚于完成写落地，把完整 markdown 覆盖回较短的半成品（P2-2）
  let flushedLen = 0;
  let lastFlushAt = 0;
  let latestPartial = '';
  let pendingFlush: Promise<void> = Promise.resolve();
  const flushPartial = (partial: string): Promise<void> => {
    latestPartial = partial;
    const now = Date.now();
    if (!shouldFlushPartial(partial.length - flushedLen, now - lastFlushAt)) return Promise.resolve();
    flushedLen = partial.length;
    lastFlushAt = now;
    const text = partial;
    pendingFlush = pendingFlush.then(() => updateAiReport(reportId, { markdown: text }));
    return pendingFlush;
  };
  try {
    const config = await requireAiConfig(lang);
    const report = await getAiReport(reportId);
    if (!report) throw new Error(t(lang, 'srv.report_not_found'));
    // 注意：这里不挡 cancelled——cancelXxxGeneration 与 fire 的竞态窗口只有几毫秒
    // （取消按钮只在行已 pending 时可见 = 任务已注册 controller，abort 路径必然命中），
    // 而手动 Retry（cancelled 行原行重跑）是合法路径；自动补跑/续跑扫描只认 pending，
    // 天然不会碰 cancelled 行，无需额外守卫。
    let finalPrompt = report.prompt;
    if (config.agentic !== false) {
      const agenticSection = buildAgenticSection(lang);
      finalPrompt += '\n\n' + agenticSection;
      // E1：记忆按相关度 top-k（query=报告基础 prompt 的正文特征），并在
      // report_total_max_chars 的剩余预算内二次收口——基础段已由 assemble 控制在
      // report_base_max_chars，记忆只吃剩余额度，绝不把总量推爆
      const remaining = Math.max(
        400,
        CONTEXT_BUDGET.report_total_max_chars - finalPrompt.length - 4,
      );
      const memories = rankMemories(await listMemories(), {
        mode: report.mode,
        query: report.prompt,
        topK: CONTEXT_BUDGET.memory_top_k,
        maxChars: Math.min(CONTEXT_BUDGET.memory_max_chars, remaining),
      });
      finalPrompt += '\n\n' + buildMemorySection(memories, lang);
      if (finalPrompt.length > CONTEXT_BUDGET.report_total_max_chars) {
        console.warn(
          `[AI] 报告 #${reportId} 上下文超出总预算：${finalPrompt.length}/${CONTEXT_BUDGET.report_total_max_chars} 字符（基础段+工具段为常量成本，记忆已按剩余额度收口）`,
        );
      }
    }
    // 生成期间启动保活前台服务（令牌制引用计数，见 src/ai/keepalive.ts）：进程脱离
    // cached 冻结桶，退后台/锁屏 SSE 不断流。放在所有取数/校验之后——fast-fail
    // 路径不闪通知；finally 只释放自己的句柄（成功/失败/超时都停）。
    keepAlive = await acquireGenerationKeepAlive({
      title: t(lang, 'ai.keepalive_title'),
      body: t(lang, 'ai.keepalive_body'),
      channel: t(lang, 'ai.keepalive_channel'),
    });
    const markdown = await callAiMaybeAgentic(
      config,
      [{ role: 'user', content: finalPrompt }],
      {
        source: report.mode, // 场景标记：save_memory 写入 ai_memories.source
        lang,
        signal: ctrl.signal,
        onRetry: (attempt, errMsg) => {
          const prev = reportProgress.get(reportId);
          reportProgress.set(reportId, { attempt, note: errMsg, activity: prev?.activity });
          console.warn(`[AI] 报告 #${reportId} 响应异常，自动重试（第 ${attempt} 次）：${errMsg}`);
        },
        onProgress: (partial) => {
          void flushPartial(partial).catch((e) => console.warn('[AI] 增量落库失败（不影响生成）:', e));
        },
        onActivity: (note) => setActivity(reportProgress, reportId, note),
      },
    );
    await pendingFlush.catch(() => {}); // 在途节流写先落地（code-review P2-2）
    await updateAiReport(reportId, { markdown, status: 'completed', error: null });
    // v2 训练计划载体：plan 报告完成后提取 ```plan-json 结构化计划落库（失败仅告警，
    // 不影响报告完成态——首页卡按「上次生成未产出有效计划」降级提示，可重新生成）
    let linkedPlanCreatedAt: string | null = null;
    if (report.mode === 'plan') {
      linkedPlanCreatedAt = await extractAndStorePlanFromReport(reportId, markdown, lang);
    }
    // 报告↔计划结构化关联（U1 收尾③）：settings 松散引用行。plan 模式锚产出的新版本
    // （提取失败不锚）；其它模式锚生成时的当前版（无计划不写）。失败只告警不损报告。
    try {
      const anchor = linkedPlanCreatedAt ?? (report.mode === 'plan' ? null : (await getCurrentPlan())?.created_at ?? null);
      if (anchor) await recordPlanReportLink(reportId, anchor);
    } catch (e) {
      console.warn(`[AI] 报告 #${reportId} 的计划关联写入失败（不影响报告）:`, e);
    }
    // 确定性记忆回顾轮（2026-10-13 拍板，decisions §20）：mem.rule.2「收尾回顾补记」
    // 此前 100% 依赖模型在主生成轮自觉执行，工具降级/轮数耗尽/模型偷懒三条静默路径
    // 都会让记忆绝迹——报告完成后编排层强制补跑一次回顾（见 runMemoryReviewRound），
    // fire-and-forget 自吞异常，绝不影响已完成的报告。
    if (config.agentic !== false) {
      void runMemoryReviewRound(config, report.mode, reportId, markdown, lang).catch((e) =>
        console.warn(`[AI] 报告 #${reportId} 记忆回顾轮异常:`, e),
      );
    }
  } catch (e) {
    if (e instanceof AiCancelledError || ctrl.signal.reason instanceof AiCancelledError) {
      // 用户取消：保留已生成的部分正文（可能是节流水位之后又多出来的几秒产出），
      // status=cancelled——不命中任何补跑/续跑扫描（都只认 pending），不会复活
      await pendingFlush.catch(() => {}); // 在途节流写先落地（code-review P2-2）
      await updateAiReport(reportId, {
        ...(latestPartial ? { markdown: latestPartial } : {}),
        status: 'cancelled',
        error: null,
      });
      console.log(`[AI] 报告 #${reportId} 已被用户取消（保留 ${latestPartial.length} 字部分正文）`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      await updateAiReport(reportId, { status: 'failed', error: msg });
      console.error(`[AI] 后台分析失败: ${msg}`);
    }
  } finally {
    await keepAlive?.release();
    runningReports.delete(reportId);
    reportAborts.delete(reportId);
    reportProgress.delete(reportId);
  }
  return { started: true };
}

/**
 * 取消报告生成（2026-10 取消按钮）：进程内有任务 → abort（任务自身回写 cancelled
 * 与部分正文）；无任务（触发/取消竞态、或残留占位尚未被补跑）→ 直接落库取消
 * （db 层 WHERE status='pending' 守卫，不会覆盖已完成/失败的行）。
 * 返回是否成功作用于一个 pending 任务/占位。
 */
export async function cancelReportGeneration(reportId: number): Promise<boolean> {
  const ctrl = reportAborts.get(reportId);
  if (ctrl) {
    ctrl.abort(new AiCancelledError());
    return true;
  }
  return cancelPendingAiReport(reportId);
}

// ---------------- 对话：提交与后台生成 ----------------

/**
 * plan 报告生成成功后的结构化计划提取：```plan-json 围栏 → create 档校验
 * （合理性只警告不拒收）→ savePlanVersion 落库。全程自吞异常——提取失败只告警，
 * 报告保持 completed（正文仍是完整的规划解读；结构化计划可重新生成补齐）。
 * 返回落库版本的 created_at（U1③ 报告→计划锚；提取失败返回 null）。
 */
async function extractAndStorePlanFromReport(
  reportId: number,
  markdown: string,
  lang: Lang,
): Promise<string | null> {
  try {
    const { plan, error } = extractPlanFromMarkdown(markdown, lang);
    if (!plan) throw new Error(error ?? t(lang, 'tp.no_block'));
    // 业余模式软约束（周质量课/周课次/单课超时）只进 warnings，不拒收（decisions §30）
    // 档案读取失败按标准模式继续校验（不因档案异常丢掉整份结构化计划）
    const profile = await getProfile().catch(() => null);
    const v = validateTrainingPlan(plan, localDay(), 'create', lang, {
      coachMode: profile?.coach_mode ?? null,
      sessionMaxMin: profile?.session_max_min ?? null,
    });
    if (!v.ok || !v.plan) throw new Error(v.errors.join('；'));
    await savePlanVersion(v.plan, {
      origin: 'generate',
      source_report_id: reportId,
      warnings: v.warnings,
    });
    console.log(
      `[AI] 结构化计划已从报告 #${reportId} 落库（${v.plan.sessions.length} 课次，合理性提示 ${v.warnings.length} 条）`,
    );
    // 刚落库的版本即当前版，读回 created_at 作报告→计划锚（savePlanVersion 不回传锚）
    const stored = await getCurrentPlan().catch(() => null);
    return stored?.created_at ?? null;
  } catch (e) {
    console.warn(`[AI] 报告 #${reportId} 的结构化计划提取失败（报告已完成，可重新生成）:`, e);
    return null;
  }
}

/**
 * 确定性记忆回顾轮（报告完成后的独立收尾，2026-10-13 拍板）：
 * - 只带 save_memory 单工具清单跑一次小 agent 循环——回顾报告 → 按需补记；
 *   既有记忆清单注入提示词（自带 #id 与规则），报告主轮已记过的不重复、
 *   同主题更新走 supersedes_id，天然去重；
 * - 超时单独收紧到 120s（回顾是小任务，不陪报告的超时预算）；
 * - 不 acquire 保活：回顾发生在报告完成后，通常几秒内结束，不值得为它闪
 *   一条前台服务通知（被冻结最多丢这一轮记忆，报告无损）；
 * - 全程自吞异常只打日志——记忆回顾失败不影响报告完成态，用户零感知；
 * - onDegrade（服务商拒 tools 静默降级）在这里也会现形，是「记忆绝迹」的
 *   首要诊断信号，warn 里点名。
 */
async function runMemoryReviewRound(
  config: AiConfig & { api_key: string },
  mode: AiReportMode,
  reportId: number,
  markdown: string,
  lang: Lang,
): Promise<void> {
  try {
    const fetchImpl = await loadDefaultFetch();
    // E1：既有记忆按报告正文相关度取 top-k（去重基准只保留真正相关的旧记忆），
    // 报告正文本身在 buildMemoryReviewPrompt 内走首末章瘦身
    const memories = rankMemories(await listMemories(), {
      mode: 'review',
      query: markdown,
      topK: CONTEXT_BUDGET.memory_top_k,
      maxChars: CONTEXT_BUDGET.memory_max_chars,
    });
    const prompt = buildMemoryReviewPrompt(markdown, memories, lang);
    // 仅 save_memory：回顾轮不需要（也不该再触发）取数/写计划等其他工具
    const defs = toolDefs(lang).filter((d) => d.function.name === 'save_memory');
    const answer = await runAgentLoop(
      fetchImpl,
      config,
      [{ role: 'user', content: prompt }],
      defs,
      createExecuteTool(buildToolIo(), { source: mode, lang }),
      {
        lang,
        timeoutMs: Math.min(config.timeout_ms, 120_000),
        onDegrade: (errMsg) =>
          console.warn(
            `[AI] 报告 #${reportId} 记忆回顾轮：模型不支持 tools，已降级单轮（${errMsg}）——该环境下记忆无法产生，请检查服务商工具调用支持`,
          ),
        onToolCall: (name, _args, result) => {
          const chars = typeof result === 'string' ? result.length : 0;
          console.log(`[AI 记忆回顾] ${name} → ${chars} 字符`);
        },
      },
    );
    console.log(`[AI] 报告 #${reportId} 记忆回顾完成（${answer.length} 字符）`);
  } catch (e) {
    console.warn(`[AI] 报告 #${reportId} 记忆回顾失败（不影响已完成报告）:`, e);
  }
}

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
  if (params.mode !== 'follow_up' && params.mode !== 'chat' && params.mode !== 'plan')
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

/**
 * 对话滚动摘要（E1）：被窗口挤出的旧消息交给模型压缩，成功落 settings 行；失败/超时
 * 回落确定性 digest，绝不影响主生成。
 * - 体量 < chat_summary_trigger_chars：直接用 digest（不值得为几百字调一次模型）；
 * - 已有摘要：只把 up_to_message_id 之后的增量与既有摘要一起送（滚动，不重复概括）；
 * - 无新增量：复用既有摘要；取消（AiCancelledError）原样上抛给主任务回写 cancelled。
 */
async function maybeRefreshChatSummary(
  config: AiConfig & { api_key: string },
  chatId: number,
  omitted: { id: number; role: 'user' | 'assistant'; content: string }[],
  digest: string | null,
  lang: Lang,
  signal: AbortSignal,
  onActivity?: (note: string) => void,
): Promise<string | null> {
  if (!omitted.length) return null;
  if (!shouldSummarize(omitted)) return digest;

  const prev = await getChatSummary(chatId);
  const delta = buildSummaryInput(omitted, prev?.up_to_message_id ?? 0);
  if (!delta.length) return prev?.summary ?? digest;

  try {
    onActivity?.(t(lang, 'ai.compacting'));
    const fetchImpl = await loadDefaultFetch();
    const prompt = buildChatSummaryPrompt(prev?.summary ?? null, delta, lang);
    const text = await callAI(fetchImpl, config, [{ role: 'user', content: prompt }], {
      lang,
      signal,
      timeoutMs: Math.min(config.timeout_ms, 60_000),
    });
    const normalized = normalizeSummaryOutput(text);
    if (!normalized) return prev?.summary ?? digest;
    // up_to = 最后一条被挤出窗口的消息 id（buildSummaryInput 已按输入上限从新往回保，
    // 丢掉的是更早的极小部分；不把水位线停在中间，避免下轮重复概括同一批旧消息）
    const upTo = omitted[omitted.length - 1].id;
    await saveChatSummary(chatId, normalized, upTo);
    onActivity?.(t(lang, 'ai.compacted'));
    return normalized;
  } catch (e) {
    if (e instanceof AiCancelledError) throw e;
    console.warn('[AI chat] 滚动摘要失败，回落到确定性 digest:', e);
    return prev?.summary ?? digest;
  }
}

/** 对话系统段：按当前状态重拼（记忆/备注/profile 修改即时生效）；answeredTurns 为此前已完成的回答轮数（follow_up 第 2 轮起 summary 降 headline 的依据） */
async function buildChatSystem(
  chat: NonNullable<Awaited<ReturnType<typeof getAiChat>>>,
  agentic: boolean,
  lang: Lang,
  answeredTurns = 0,
  historySummary: string | null = null,
  systemMaxChars?: number,
): Promise<string> {
  const [athlete, profile, allMemories, dossier] = await Promise.all([
    getEffectiveAthlete(),
    getProfile(),
    listMemories(),
    getDossier(),
  ]);
  // E1：记忆按当前问题（最近一条 user 消息）相关度取 top-k，不再全量注入最近 30 条
  const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user')?.content ?? null;
  const memories = rankMemories(allMemories, {
    mode: chat.mode,
    query: lastUser,
    topK: CONTEXT_BUDGET.memory_top_k,
    maxChars: CONTEXT_BUDGET.memory_max_chars,
  });
  // 专业知识库注入 chat 直接对话与 plan 计划会话；follow_up 快答场景不注入（口径同旧版）
  const skills = chat.mode === 'follow_up' ? null : buildSkillsSection(lang, undefined, CONTEXT_BUDGET.skills_max_chars);
  // follow_up：关联报告正文 + 压缩训练数据（报告可能已被滚动清理，缺则仅靠训练数据）；
  // 双口径统一：summary 的活动日期与档案锚日换算为本地日历日（与「当前时间」段同日历）
  const rep = chat.report_id != null ? await getAiReport(chat.report_id) : null;
  const rawSummary = chat.mode === 'follow_up' && chat.file_name ? await getActivitySummary(chat.file_name) : null;
  const rideStart = chat.mode === 'follow_up' && chat.file_name ? await getRideStartAt(chat.file_name) : null;
  const summary = rawSummary ? withLocalActivityDate(rawSummary, rideStart) : null;
  return buildChatSystemSection(
    {
      mode: chat.mode,
      agentic,
      athlete,
      profile,
      skills,
      memories,
      now: new Date(),
      dossierSection: buildDossierSection(await localAnchorDossier(dossier), lang),
      reportMarkdown: rep?.markdown ?? null,
      summary,
      historyTurns: answeredTurns,
      historySummary,
      systemMaxChars,
    },
    lang,
  );
}

/**
 * 对话后台生成任务：系统段每轮重拼（首条 user 消息注入），历史只带 completed
 * 正文（排除 pending 占位与失败消息），结果回写占位消息 completed/failed。
 * 应用中途被杀留下的 pending 占位，重进会话页时以同一 messageId 重跑本函数即可。
 * 2026-10 增量落库 + 取消：口径同 generateReport（节流回写部分正文到 pending
 * 消息行；cancelChatGeneration abort 后回写 cancelled + 部分正文）。
 * 返回 started：同一消息已有任务在跑时为 false（**立即**返回，任务未受影响）；
 * 为 true 时要等整个生成任务结束才 resolve（语义同 generateReport）。UI 按钮的
 * 禁用态以 isChatGenerating 为准。
 */
export async function runChatGeneration(chatId: number, messageId: number, lang: Lang = 'zh'): Promise<{ started: boolean }> {
  const key = `${chatId}:${messageId}`;
  if (runningChats.has(key)) return { started: false }; // 同一消息不重复 fire
  runningChats.add(key);
  const ctrl = new AbortController();
  chatAborts.set(key, ctrl);
  // 保活句柄：口径同 generateReport（fast-fail 不闪通知、finally 只释放自己的句柄）
  let keepAlive: KeepAliveHandle | null = null;
  // 增量落库节流状态（口径同 generateReport 的 flushPartial，含串行化防终态覆盖）
  let flushedLen = 0;
  let lastFlushAt = 0;
  let latestPartial = '';
  let pendingFlush: Promise<void> = Promise.resolve();
  const flushPartial = (partial: string): Promise<void> => {
    latestPartial = partial;
    const now = Date.now();
    if (!shouldFlushPartial(partial.length - flushedLen, now - lastFlushAt)) return Promise.resolve();
    flushedLen = partial.length;
    lastFlushAt = now;
    const text = partial;
    pendingFlush = pendingFlush.then(() => updateAiChatMessage(messageId, { content: text }));
    return pendingFlush;
  };
  try {
    const config = await requireAiConfig(lang);
    const chat = await getAiChat(chatId);
    if (!chat) throw new Error(t(lang, 'srv.chat_not_found'));
    // 不挡 cancelled（口径同 generateReport：手动重试是合法路径，自动补跑只认 pending）
    const completed = chat.messages.filter((m) => m.status === 'completed' && m.content);
    // 首条 user 消息是用户刚提的问题（completed 已入 history），故以「已完成的回答数」计轮：
    // 0 = 首轮（summary 全量），≥1 = 第 2 轮起（summary 降 headline）
    const answeredTurns = completed.filter((m) => m.role === 'assistant').length;
    // E1：历史窗口化——最近 N 轮原样发，更早的旧消息由模型滚动摘要（失败回落 digest）。
    // 保活先于摘要调用 acquire：摘要本身也是一次模型请求，不能被 cached 冻结打断。
    keepAlive = await acquireGenerationKeepAlive({
      title: t(lang, 'ai.keepalive_title'),
      body: t(lang, 'ai.keepalive_body'),
      channel: t(lang, 'ai.keepalive_channel'),
    });
    const windowed = windowChatHistory(completed, {
      recentTurns: CONTEXT_BUDGET.history_recent_turns,
      recentChars: CONTEXT_BUDGET.history_recent_chars,
      digestPerMessageChars: 200,
      digestMaxChars: CONTEXT_BUDGET.chat_summary_output_max_chars,
    });
    const historySummary = await maybeRefreshChatSummary(
      config,
      chatId,
      windowed.omitted,
      windowed.digest,
      lang,
      ctrl.signal,
      (note) => setActivity(chatProgress, key, note),
    );
    // 系统段预算 = 请求总预算 - 原样历史 - 摘要段（摘要已含在系统段里，这里一起扣）
    const historyChars =
      windowed.recent.reduce((n, m) => n + m.content.length, 0) + (historySummary?.length ?? 0);
    const systemBudget = Math.max(
      12000,
      Math.min(CONTEXT_BUDGET.system_max_chars, CONTEXT_BUDGET.request_max_chars - historyChars),
    );
    const system = await buildChatSystem(
      chat,
      config.agentic !== false,
      lang,
      answeredTurns,
      historySummary,
      systemBudget,
    );
    if (windowed.omitted.length) {
      console.log(
        `[AI chat] 历史窗口：保留 ${windowed.recent.length} 条 / 挤出 ${windowed.omitted.length} 条，摘要 ${historySummary?.length ?? 0} 字符，系统段预算 ${systemBudget}`,
      );
    }
    // 只把 role/content 发给 API（窗口化结果带 id 等 db 字段，不透传）
    const recentMessages = windowed.recent.map((m) => ({ role: m.role, content: m.content }));
    const markdown = await callAiMaybeAgentic(
      config,
      [{ role: 'user', content: system }, ...recentMessages],
      {
        source: chat.mode, // 场景标记：save_memory 写入 ai_memories.source
        lang,
        chat: true, // 对话类调用：update_training_plan 等写类工具据此放行
        signal: ctrl.signal,
        onRetry: (attempt, errMsg) => {
          const prev = chatProgress.get(key);
          chatProgress.set(key, { attempt, note: errMsg, activity: prev?.activity });
          console.warn(`[AI chat] ${key} 响应异常，自动重试（第 ${attempt} 次）：${errMsg}`);
        },
        onProgress: (partial) => {
          void flushPartial(partial).catch((e) => console.warn('[AI chat] 增量落库失败（不影响生成）:', e));
        },
        onActivity: (note) => setActivity(chatProgress, key, note),
      },
    );
    await pendingFlush.catch(() => {}); // 在途节流写先落地（code-review P2-2）
    await updateAiChatMessage(messageId, { content: markdown, status: 'completed', error: null });
    await touchAiChat(chatId);
  } catch (e) {
    if (e instanceof AiCancelledError || ctrl.signal.reason instanceof AiCancelledError) {
      // 用户取消：保留部分正文（口径同 generateReport），cancelled 不命中任何补跑扫描
      await pendingFlush.catch(() => {}); // 在途节流写先落地（code-review P2-2）
      await updateAiChatMessage(messageId, {
        ...(latestPartial ? { content: latestPartial } : {}),
        status: 'cancelled',
        error: null,
      });
      await touchAiChat(chatId);
      console.log(`[AI chat] ${key} 已被用户取消（保留 ${latestPartial.length} 字部分正文）`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      await updateAiChatMessage(messageId, { status: 'failed', error: msg });
      await touchAiChat(chatId); // 失败同样刷新 updated_at（列表排序与旧版一致）
      console.error(`[AI chat] 后台生成失败: ${msg}`);
    }
  } finally {
    await keepAlive?.release();
    runningChats.delete(key);
    chatAborts.delete(key);
    chatProgress.delete(key);
  }
  return { started: true };
}

/**
 * 取消对话消息生成（2026-10 取消按钮）：口径同 cancelReportGeneration——进程内
 * 有任务 → abort（任务自身回写）；无任务 → db 直接取消（pending 守卫）+ 刷新
 * 会话 updated_at（与失败路径同口径，列表排序不漂移）。
 */
export async function cancelChatGeneration(chatId: number, messageId: number): Promise<boolean> {
  const key = `${chatId}:${messageId}`;
  const ctrl = chatAborts.get(key);
  if (ctrl) {
    ctrl.abort(new AiCancelledError());
    return true;
  }
  const ok = await cancelPendingChatMessage(messageId);
  if (ok) await touchAiChat(chatId);
  return ok;
}

// ---------------- 残留恢复：回前台自动续跑（M5） ----------------

/** 自动续跑窗口：只恢复「刚被进程死亡打断」的生成（切后台被杀的典型时间窗） */
const RESUME_WINDOW_MS = 30 * 60_000;

/**
 * 恢复被进程死亡打断的生成（根布局在冷启动 + 每次 background→active 时调度）：
 * - 未配置 AI 密钥时整体跳过（不把 pending 扫成 failed，等用户进页面自行处理）；
 * - 只补跑窗口内的 pending——窗口外的维持"进 AI 页面时补跑"的现状（此前唯一恢复
 *   路径），避免为用户早已放弃的任务重复消耗 token；SSE 无法续传，续跑 = 整份
 *   重新生成，token 重复消耗已知并接受；
 * - 进程内已在跑的任务由 generateReport/runChatGeneration 的注册表防双跑，无需在此判断。
 */
export async function resumeInterruptedGenerations(lang: Lang = 'zh'): Promise<void> {
  const { config, configured } = await getAiConfig();
  if (!configured || !config.api_key) return;
  const now = Date.now();
  const [reports, messages] = await Promise.all([
    listPendingAiReportRefs(),
    listPendingChatMessageRefs(),
  ]);
  for (const r of reports) {
    if (!withinResumeWindow(r.created_at, now, RESUME_WINDOW_MS)) continue;
    void generateReport(r.id, lang).catch((e) => console.warn('报告残留续跑失败:', e));
  }
  for (const m of messages) {
    if (!withinResumeWindow(m.created_at, now, RESUME_WINDOW_MS)) continue;
    void runChatGeneration(m.chat_id, m.message_id, lang).catch((e) =>
      console.warn('对话残留续跑失败:', e),
    );
  }
}

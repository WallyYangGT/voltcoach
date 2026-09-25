/**
 * execute.ts — 工具参数校验与执行分发（自 reference/src/tools.js 平移，逻辑不动只补类型）。
 *
 * 三类工具：只读查询（数据经 ToolIo 注入，不重复实现查询逻辑）、纯计算
 * （simulate_form / generate_workout → src/planning 纯函数，simulate_form 未显式给
 * 起始 CTL/ATL 时经 ToolIo 读一次训练库当前值）、写（save_memory 写 ai_memories，
 * 带 source 场景标记；M5 追加 update_ftp——数值只来自估算器、采纳门槛在 core/ftp
 * 硬校验；reanalyze_activity 重算写回单次训练。两者编排均在 services 层，本层薄壳）。
 *
 * 与旧版的差异（其余逐字平移）：旧版直接调 db.js 同步查询并读全局同步过的 ATHLETE；
 * App 版所有 IO 异步、生效骑手参数显式注入——由 createExecuteTool(io) 工厂闭包持有，
 * node:test 注入假 io 即可全量断言。
 *
 * 约定：
 * - 所有工具返回 JSON 字符串；业务错误（file_name 不存在、参数非法）返回
 *   {error: "..."} JSON，不抛异常中断 agent 循环。
 * - 每个结果超过 AGENTIC.tool_result_max_chars 时截断并附"（结果已截断）"标记。
 * - file_name 参数一律经 safeName basename 校验，防路径穿越。
 */

import type { AthleteParams } from '../core/settings.ts';
import { AGENTIC, FTP_ESTIMATION, FORM_SIMULATION, WORKOUT_TEMPLATES } from '../core/settings.ts';
import { estimateFtpFromHistory, type CyclingRideInput } from '../core/ftp.ts';
import { t, type Lang } from '../core/i18n.ts';
import { safeName, type ThinResult } from '../core/records.ts';
import { compactSummaryForPrompt, localizeTimestamps, type PromptProfile } from '../prompts/prompts.ts';
import { generateWorkout, simulateForm, type PlanDay } from '../planning/planning.ts';

/** 工具层数据访问接口（由服务层绑定 db / records-store，测试注入假实现） */
export interface ToolIo {
  /** 训练简明清单（日期倒序全量，工具内再过滤/截断；口径同旧版 listActivities(200)） */
  listActivities(): Promise<
    {
      file_name: string;
      date: string;
      sport: string;
      category: string;
      duration_sec: number | null;
      distance_km: number | null;
      tss: number | null;
      np: number | null;
      intensity_factor: number | null;
    }[]
  >;
  /** 单次训练完整 summary；不存在返回 null */
  getActivitySummary(fileName: string): Promise<object | null>;
  /**
   * 逐秒时序（已按 maxPoints 抽稀、支持时间窗）；文件不存在返回 null。
   * 绑定层：records-store 读取 → parseRecordsCsv → thinRecords（口径与旧 loadRecords 一致）。
   */
  loadRecords(fileName: string, opts: { maxPoints: number; startSec?: number; endSec?: number }): Promise<ThinResult | null>;
  /** 最近 N 天逐日负荷序列 */
  recentFormDaily(days: number): Promise<{ date: string; tss: number; ctl: number; atl: number; tsb: number }[]>;
  /** 最近 N 个月汇总 */
  monthlySummary(months: number): Promise<unknown[]>;
  /** 骑手参数生效值与是否已配置 */
  getAthleteState(): Promise<{ athlete: AthleteParams; configured: boolean }>;
  /** 用户背景与训练目标 */
  getProfile(): Promise<PromptProfile>;
  /** 最近 N 天骑行完整 summary（FTP 估算输入） */
  cyclingSummariesSince(days: number): Promise<CyclingRideInput[]>;
  /** 某日 CTL/ATL 快照；训练库为空返回 null */
  computeForm(date: string): Promise<{ ctl: number; atl: number } | null>;
  /** 保存 AI 记忆，返回 id（非法输入抛双语 Error，本层兜为 {error}） */
  saveMemory(input: { content?: unknown; category?: unknown; source?: string | null; supersedes_id?: unknown }, lang: Lang): Promise<number>;
  /**
   * AI 触发的 FTP 更新（估算 → 采纳门槛 → 写回，编排见 services/ftp-apply）。
   * 拒绝不抛错，返回 {applied:false, reason, estimate}；成功返回 {applied:true, ...}。
   */
  applyFtpUpdate(lang: Lang): Promise<unknown>;
  /**
   * 按当前骑手参数重新分析一次训练并写回（编排见 services/reanalyze）。
   * 活动不存在/缺逐秒数据抛双语 Error，本层兜为 {error}。
   */
  reanalyzeActivity(fileName: string, lang: Lang): Promise<unknown>;
}

/** 执行上下文：source 场景标记（save_memory 写入 ai_memories.source），lang 消息语言 */
export interface ToolCallContext {
  source?: string | null;
  lang?: Lang;
}

// ---------------- 参数校验小工具 ----------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 结果序列化 + 截断（超 AGENTIC.tool_result_max_chars 附截断标记，按语言） */
function toResult(obj: unknown, lang: Lang = 'zh'): string {
  let s = JSON.stringify(obj);
  if (s.length > AGENTIC.tool_result_max_chars) {
    s = s.slice(0, AGENTIC.tool_result_max_chars) + t(lang, 'tool.result_truncated');
  }
  return s;
}

const errResult = (message: string) => JSON.stringify({ error: message });

// ---------------- 各工具实现（io 闭包注入） ----------------

type ToolImpl = (args: Record<string, unknown>, ctx: ToolCallContext, io: ToolIo) => Promise<string>;

const toolListActivities: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const limit = clampInt(args?.limit, 1, AGENTIC.list_limit, 20);
  let list = await io.listActivities();
  if (args?.start_date != null) {
    if (!DATE_RE.test(String(args.start_date)))
      return errResult(t(lang, 'tool.date_invalid', { key: 'start_date' }));
    list = list.filter((a) => a.date >= (args.start_date as string));
  }
  if (args?.end_date != null) {
    if (!DATE_RE.test(String(args.end_date)))
      return errResult(t(lang, 'tool.date_invalid', { key: 'end_date' }));
    list = list.filter((a) => a.date <= (args.end_date as string));
  }
  if (args?.sport != null) list = list.filter((a) => a.sport === args.sport);
  if (args?.category != null) list = list.filter((a) => a.category === args.category);
  return toResult({ count: Math.min(list.length, limit), activities: list.slice(0, limit) }, lang);
};

const toolGetActivitySummary: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const name = safeName(String(args?.file_name ?? ''));
  if (!name) return errResult(t(lang, 'tool.name_invalid'));
  const summary = await io.getActivitySummary(name);
  if (!summary) return errResult(t(lang, 'tool.summary_not_found', { name }));
  return toResult(compactSummaryForPrompt(summary, lang), lang);
};

const toolGetActivityRecords: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const name = safeName(String(args?.file_name ?? ''));
  if (!name) return errResult(t(lang, 'tool.name_invalid'));
  const data = await io.loadRecords(name, {
    maxPoints: AGENTIC.records_max_points,
    startSec: args?.start_sec != null ? Number(args.start_sec) : undefined,
    endSec: args?.end_sec != null ? Number(args.end_sec) : undefined,
  });
  if (!data) return errResult(t(lang, 'tool.records_not_found', { name }));
  // 时序时间戳为 UTC 口径，提交前改写为本地时区偏移，AI 按本地时间解读时段
  return toResult(localizeTimestamps(data), lang);
};

const toolGetFormSeries: ToolImpl = async (args, ctx, io) => {
  const days = clampInt(args?.days, 1, AGENTIC.form_max_days, 56);
  return toResult({ days, series: await io.recentFormDaily(days) }, ctx?.lang || 'zh');
};

const toolGetMonthlySummary: ToolImpl = async (args, ctx, io) => {
  const months = clampInt(args?.months, 1, AGENTIC.monthly_max, 6);
  return toResult({ months, summary: await io.monthlySummary(months) }, ctx?.lang || 'zh');
};

const toolGetAthleteProfile: ToolImpl = async (_args, ctx, io) => {
  const { athlete, configured } = await io.getAthleteState();
  const profile = await io.getProfile();
  return toResult(
    {
      athlete,
      athlete_configured: configured,
      identity: profile.identity || null,
      goal: profile.goal || null,
    },
    ctx?.lang || 'zh',
  );
};

const toolEstimateFtp: ToolImpl = async (_args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const acts = await io.cyclingSummariesSince(FTP_ESTIMATION.window_days);
  const athlete = await io.getAthleteState();
  return toResult(estimateFtpFromHistory(acts, athlete.athlete, FTP_ESTIMATION, lang), lang);
};

/** simulate_form：未来负荷推演（纯计算；起始 CTL/ATL 缺省时读一次训练库当前值） */
const toolSimulateForm: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const plan = args?.plan as PlanDay[] | undefined;
  if (!Array.isArray(plan) || !plan.length)
    return errResult(t(lang, 'tool.plan_array'));
  if (plan.length > AGENTIC.simulate_max_days)
    return errResult(t(lang, 'tool.plan_max_days', { n: AGENTIC.simulate_max_days }));
  const clean: PlanDay[] = [];
  for (const d of plan) {
    if (!d || !DATE_RE.test(String((d as PlanDay).date ?? '')))
      return errResult(t(lang, 'tool.plan_date'));
    const tss = Number((d as PlanDay).tss);
    if (!Number.isFinite(tss)) return errResult(t(lang, 'tool.plan_tss'));
    clean.push({ date: (d as PlanDay).date, tss: Math.min(1000, Math.max(0, tss)) });
  }
  clean.sort((a, b) => (a.date < b.date ? -1 : 1));
  let startCtl = Number(args?.start_ctl);
  let startAtl = Number(args?.start_atl);
  if (!Number.isFinite(startCtl) || !Number.isFinite(startAtl)) {
    const today = new Date().toISOString().slice(0, 10);
    const cur = await io.computeForm(today); // 训练库为空时返回 null，按 0 起步
    startCtl = cur?.ctl ?? 0;
    startAtl = cur?.atl ?? 0;
  }
  const { projection, risk_flags, end_form } = simulateForm({
    startCtl,
    startAtl,
    plan: clean,
    cfg: FORM_SIMULATION,
    lang,
  });
  return toResult({ start: { ctl: startCtl, atl: startAtl }, projection, risk_flags, end_form }, lang);
};

/** generate_workout：单次课表生成（纯计算，FTP 取生效骑手参数） */
const toolGenerateWorkout: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const duration = clampInt(args?.duration_minutes, 15, 300, NaN);
  if (!Number.isFinite(duration))
    return errResult(t(lang, 'tool.duration_invalid'));
  const { athlete } = await io.getAthleteState();
  const result = generateWorkout({
    target: String(args?.target ?? ''),
    durationMinutes: duration,
    ftpWatts: athlete.ftp_watts,
    tsb: args?.tsb != null ? Number(args.tsb) : null,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
    lang,
  });
  if (result.error) return errResult(result.error);
  return toResult({ ftp_watts: athlete.ftp_watts, ...result }, lang);
};

/** save_memory：写 ai_memories（唯一写工具）；ctx.source 为场景标记，ctx.lang 为消息语言 */
const toolSaveMemory: ToolImpl = async (args, ctx, io) => {
  const id = await io.saveMemory(
    {
      content: args?.content,
      category: args?.category,
      source: ctx?.source ?? null,
      supersedes_id: args?.supersedes_id,
    },
    ctx?.lang || 'zh',
  );
  return toResult(
    {
      ok: true,
      memory_id: id,
      date: new Date().toISOString().slice(0, 10),
    },
    ctx?.lang || 'zh',
  );
};

/** update_ftp：AI 教练按当前最佳估算更新 FTP（零参——数值只来自估算器，模型无自定数值入口） */
const toolUpdateFtp: ToolImpl = async (_args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  return toResult(await io.applyFtpUpdate(lang), lang);
};

/** reanalyze_activity：按当前骑手参数重算一次训练并写回，返回新旧指标对比 */
const toolReanalyzeActivity: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const name = safeName(String(args?.file_name ?? ''));
  if (!name) return errResult(t(lang, 'tool.name_invalid'));
  return toResult(await io.reanalyzeActivity(name, lang), lang);
};

const TOOL_IMPL: Record<string, ToolImpl> = {
  list_activities: toolListActivities,
  get_activity_summary: toolGetActivitySummary,
  get_activity_records: toolGetActivityRecords,
  get_form_series: toolGetFormSeries,
  get_monthly_summary: toolGetMonthlySummary,
  get_athlete_profile: toolGetAthleteProfile,
  estimate_ftp: toolEstimateFtp,
  simulate_form: toolSimulateForm,
  generate_workout: toolGenerateWorkout,
  save_memory: toolSaveMemory,
  update_ftp: toolUpdateFtp,
  reanalyze_activity: toolReanalyzeActivity,
};

export type ExecuteTool = (name: string, args: Record<string, unknown> | null) => Promise<string>;

/**
 * 工具执行分发工厂：未知工具名 / 执行异常均返回 {error} JSON，不抛出。
 * 返回值为 JSON 字符串（直接作为 role:"tool" 消息的 content）。
 * base 为本次调用上下文（{ source: 场景标记, lang: 消息语言 }），save_memory 用 source，
 * 各工具错误消息用 lang；缺省 zh。io 为数据访问注入（db / records-store 绑定）。
 */
export function createExecuteTool(io: ToolIo, base: ToolCallContext = {}): ExecuteTool {
  return async (name, args) => {
    const lang = base?.lang || 'zh';
    const impl = TOOL_IMPL[name];
    if (!impl) return errResult(t(lang, 'tool.unknown', { name }));
    try {
      return await impl(args ?? {}, { source: base?.source, lang: base?.lang }, io);
    } catch (e) {
      return errResult(t(lang, 'tool.failed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
}

/**
 * execute.ts — 工具参数校验与执行分发（自 fit-reader Web 版 src/tools.js 平移，逻辑不动只补类型）。
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
import { AGENTIC, AMATEUR_FORM_SIMULATION, FTP_ESTIMATION, FORM_SIMULATION, WORKOUT_TEMPLATES } from '../core/settings.ts';
import { estimateFtpFromHistory, type CyclingRideInput } from '../core/ftp.ts';
import { t, type Lang } from '../core/i18n.ts';
import { localDay, localDayFromUtc } from '../core/local-day.ts';
import { addDaysStr } from '../core/dossier.ts';
import { safeName, type ThinResult } from '../core/records.ts';
import {
  formatPlanIssue,
  planValidity,
  validateTrainingPlan,
  type PlanIssue,
  type TrainingPlan,
} from '../core/training-plan.ts';
import { applyPlanSessionOps } from '../core/plan-ops.ts';
import type { RiderProfilePatch } from '../core/profile.ts';
import {
  compactSummaryForPrompt,
  localizeTimestamps,
  withLocalActivityDate,
  withLocalActivityDates,
  type PromptProfile,
} from '../prompts/prompts.ts';
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
  /**
   * records 首帧时间戳（起骑时刻 ISO UTC；本地日历日换算的瞬间源）；无数据返回 null。
   * 绑定层：records-store.readStoredRecordStart（带进程内缓存，导入/删除/合并时失效）。
   */
  readRecordStart(fileName: string): Promise<string | null>;
  /** 最近 N 天逐日负荷序列 */
  recentFormDaily(days: number): Promise<{ date: string; tss: number; ctl: number; atl: number; tsb: number }[]>;
  /** 最近 N 个月汇总 */
  monthlySummary(months: number): Promise<unknown[]>;
  /** 骑手参数生效值与是否已配置 */
  getAthleteState(): Promise<{ athlete: AthleteParams; configured: boolean }>;
  /** 用户背景与训练目标（含教练模式与时间预算） */
  getProfile(): Promise<PromptProfile>;
  /** 更新骑手档案（校验/合并口径在 core/profile；非法值抛双语 Error，本层兜为 {error}） */
  setRiderProfile(partial: RiderProfilePatch, lang: Lang): Promise<PromptProfile>;
  /** 最近 N 天骑行完整 summary（FTP 估算输入） */
  cyclingSummariesSince(days: number): Promise<CyclingRideInput[]>;
  /** 某日 CTL/ATL 快照；训练库为空返回 null */
  computeForm(date: string): Promise<{ ctl: number; atl: number } | null>;
  /** 保存 AI 记忆，返回 id（非法输入抛双语 Error，本层兜为 {error}） */
  saveMemory(input: { content?: unknown; category?: unknown; scope?: unknown; source?: string | null; supersedes_id?: unknown }, lang: Lang): Promise<number>;
  /** 个人训练档案（本地聚合长期基线）；无骑行数据返回 null */
  getDossier(): Promise<unknown | null>;
  /** 当前结构化训练计划（settings 行）；无计划返回 null */
  getTrainingPlan(): Promise<{ plan: TrainingPlan; origin: string; created_at: string } | null>;
  /** 落一版调整后计划（已过 adjust 档校验），返回落地后的总版本数（当前 1 + 历史） */
  savePlanVersion(
    plan: TrainingPlan,
    meta: { origin: 'adjust'; change_note: string | null; warnings: PlanIssue[] },
  ): Promise<number>;
  /** 标记/取消「功率不可信」（编排见 services/power-calib：db 标记 + 档案重建），返回结果对象 */
  setPowerFlag(fileName: string, flagged: boolean, lang: Lang, reason: string | null): Promise<unknown>;
  /** 按系数缩放重算一次训练的功率派生指标并写回（编排见 services/power-calib），返回结果对象 */
  recalibratePower(fileName: string, scaleFactor: number, lang: Lang): Promise<unknown>;
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

/** 执行上下文：source 场景标记（save_memory 写入 ai_memories.source），lang 消息语言；
 * chat 标记对话类调用（chat/follow_up/plan 会话）——报告生成与对话的 source 都可能是
 * 'plan'（报告场景名 = 会话模式名），写类工具以 chat 标记区分，不能只看 source */
export interface ToolCallContext {
  source?: string | null;
  lang?: Lang;
  chat?: boolean;
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
  // 日期范围过滤按存储 UTC 日比较（存储列是纯日期、无时刻不可精确换算，清晨骑行的
  // 边缘 ±1 天可接受）；返回结果的 date 在下方统一改写为本地日历日
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
  const page = list.slice(0, limit);
  const starts = new Map<string, string | null>();
  for (const a of page) starts.set(a.file_name, await io.readRecordStart(a.file_name));
  return toResult({ count: page.length, activities: withLocalActivityDates(page, starts) }, lang);
};

const toolGetActivitySummary: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const name = safeName(String(args?.file_name ?? ''));
  if (!name) return errResult(t(lang, 'tool.name_invalid'));
  const summary = await io.getActivitySummary(name);
  if (!summary) return errResult(t(lang, 'tool.summary_not_found', { name }));
  // 双口径统一：activity.date 经首帧时刻换算为本地日历日（与「当前时间」段同日历），
  // 缺首帧（如记录被清）保持 UTC 原值
  return toResult(
    compactSummaryForPrompt(withLocalActivityDate(summary, await io.readRecordStart(name)), lang),
    lang,
  );
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
      coach_mode: profile.coach_mode ?? null,
      coach_mode_configured: profile.coach_mode != null,
      weekly_hours: profile.weekly_hours ?? null,
      available_days: profile.available_days ?? [],
      session_max_min: profile.session_max_min ?? null,
    },
    ctx?.lang || 'zh',
  );
};

/**
 * update_rider_profile：教练模式与时间预算的结构化写入口（业余教练模式，2026-10-17）。
 * 只放行对话类调用（ctx.chat）——模式变更必须建立在对话确认之上，报告生成场景没有
 * 用户答复可依；确认协议（先复述获肯定答复）在工具描述、chat.plan 与技能层约束。
 */
const toolUpdateRiderProfile: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  if (!ctx?.chat) return errResult(t(lang, 'profile.tool.chat_only'));
  const keys = ['coach_mode', 'weekly_hours', 'available_days', 'session_max_min'] as const;
  if (!keys.some((k) => args?.[k] !== undefined)) return errResult(t(lang, 'profile.tool.empty'));
  const patch: RiderProfilePatch = {};
  for (const k of keys) {
    if (args?.[k] === undefined) continue;
    let v = args[k];
    // 清空语义（工具 schema 不能表达 null，用哨兵值）：空串清模式/时长档，0 清单次上限；
    // 可用日的空数组本身就是「不限/清空」，直接交给 core/profile 校验。
    if ((k === 'coach_mode' || k === 'weekly_hours') && v === '') v = null;
    else if (k === 'session_max_min' && v === 0) v = null;
    (patch as Record<string, unknown>)[k] = v;
  }
  const updated = await io.setRiderProfile(patch, lang);
  return toResult(
    {
      ok: true,
      coach_mode: updated.coach_mode ?? null,
      weekly_hours: updated.weekly_hours ?? null,
      available_days: updated.available_days ?? [],
      session_max_min: updated.session_max_min ?? null,
    },
    lang,
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
    // 缺省起点取「今天」的库内快照：今天用本地日历日（与计划/当前时间同日历，
    // 清晨推演不再把今天算成昨天）
    const cur = await io.computeForm(localDay()); // 训练库为空时返回 null，按 0 起步
    startCtl = cur?.ctl ?? 0;
    startAtl = cur?.atl ?? 0;
  }
  // 档案读取失败按标准阈值继续推演（纯计算工具不因档案异常失败）
  const profile = await io.getProfile().catch(() => null);
  const { projection, risk_flags, end_form } = simulateForm({
    startCtl,
    startAtl,
    plan: clean,
    // 与计划页同口径：业余模式用放宽后的推演阈值（对话里的 what-if 不再按训练者标尺报风险）
    cfg: profile?.coach_mode === 'amateur' ? AMATEUR_FORM_SIMULATION : FORM_SIMULATION,
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

/** save_memory：写 ai_memories（scope 分层：short 两周/5 次训练失效）；ctx.source 为场景标记 */
const toolSaveMemory: ToolImpl = async (args, ctx, io) => {
  const id = await io.saveMemory(
    {
      content: args?.content,
      category: args?.category,
      scope: args?.scope,
      source: ctx?.source ?? null,
      supersedes_id: args?.supersedes_id,
    },
    ctx?.lang || 'zh',
  );
  return toResult(
    {
      ok: true,
      memory_id: id,
      // 本地日历日（清晨写入的记忆不再向模型报告「昨天」）
      date: localDay(),
    },
    ctx?.lang || 'zh',
  );
};

/** get_dossier：个人训练档案长期基线（评估进步/规划前的对照基准；空库返回提示） */
const toolGetDossier: ToolImpl = async (_args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const dossier = await io.getDossier();
  if (!dossier) return errResult(t(lang, 'tool.dossier_empty'));
  return toResult(await localDossierForPrompt(dossier, io), lang);
};

/**
 * 档案数据的本地日整形（喂模型前，settings 缓存不动）：锚日 anchor_date 改写为
 * 锚骑行（当日任一骑行的首帧）的本地日历日；8 周负荷的周界 start/end 按本地锚
 * 重排（同一套 addDaysStr 日串算术，保持「周界连续、锚日收尾」结构）。值本身仍按
 * UTC 日桶聚合（周界标签平移 ±1 天、清晨骑行的归桶不改——精确归桶需要逐骑行
 * 首帧重算，成本不值）；peak_power[].date 与 intensity 月桶无瞬间源，保持 UTC 原样。
 */
async function localDossierForPrompt(dossier: unknown, io: ToolIo): Promise<unknown> {
  const d = dossier as {
    anchor_date?: string | null;
    load_shape?: { weeks?: { start: string; end: string }[] } | null;
  };
  if (!d?.anchor_date) return dossier;
  let localAnchor: string | null = null;
  try {
    const rides = await io.listActivities();
    const candidates = rides.filter((r) => r.sport === 'cycling' && r.date === d.anchor_date);
    for (const r of candidates) {
      const local = localDayFromUtc(await io.readRecordStart(r.file_name));
      if (local) {
        localAnchor = local;
        break;
      }
    }
  } catch {
    return dossier; // 清单/首帧读取失败：保持 UTC 原值，不因整形阻断工具返回
  }
  if (!localAnchor || localAnchor === d.anchor_date) return dossier;
  const weeks = d.load_shape?.weeks ?? [];
  return {
    ...d,
    anchor_date: localAnchor,
    ...(weeks.length
      ? {
          load_shape: {
            ...d.load_shape,
            weeks: weeks.map((w, i) => ({
              ...w,
              end: addDaysStr(localAnchor!, -7 * i),
              start: addDaysStr(localAnchor!, -7 * i - 6),
            })),
          },
        }
      : {}),
  };
}

/** get_training_plan：当前结构化训练计划（计划答疑/执行对比/重生成前的查阅入口） */
const toolGetTrainingPlan: ToolImpl = async (_args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const stored = await io.getTrainingPlan();
  if (!stored) return toResult({ has_plan: false }, lang);
  // 有效期判定在确定性层（core/training-plan）：state = valid | expired | upcoming
  const { state, days_left } = planValidity(stored.plan, localDay());
  // 展示字段裁剪（副本，不动存储）：42 课次满额 note/intensity 的原始载荷会越过
  // 16k 截断线，截断标记会把 JSON 从中间切坏——模型后续调整就失去了整体重发基准
  const sessions = stored.plan.sessions.map((s) => ({
    ...s,
    intensity: s.intensity ? s.intensity.slice(0, 40) : null,
    note: s.note ? s.note.slice(0, 60) : null,
  }));
  return toResult(
    {
      has_plan: true,
      state,
      days_left,
      valid_from: stored.plan.valid_from,
      valid_to: stored.plan.valid_to,
      goal: stored.plan.goal,
      origin: stored.origin,
      created_at: stored.created_at,
      sessions,
    },
    lang,
  );
};

/**
 * update_training_plan：调整后完整计划的落库入口（adjust 档确定性校验在此硬闸——
 * 合理性违规返回 {ok:false, violations} 由模型向用户转述，不静默放过）。
 * 只放行对话类调用（ctx.chat）：报告场景名与会话模式名都可能是 'plan'，
 * 单看 source 分不出「plan 报告生成」和「plan 会话调整」，故用显式 chat 标记。
 */
const toolUpdateTrainingPlan: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  if (!ctx?.chat) return errResult(t(lang, 'tp.tool.report_source'));
  const profile = await io.getProfile();
  const v = validateTrainingPlan(args?.plan, localDay(), 'adjust', lang, {
    coachMode: profile.coach_mode,
    sessionMaxMin: profile.session_max_min,
  });
  if (!v.ok || !v.plan) return errResult(v.errors.join('；'));
  if (v.violations.length) {
    return toResult(
      {
        ok: false,
        violations: v.violations.map((i) => formatPlanIssue(i, lang)),
        hint: t(lang, 'tp.tool.adjust_hint'),
      },
      lang,
    );
  }
  const note =
    typeof args?.change_note === 'string' ? args.change_note.trim().slice(0, 200) || null : null;
  const versionsTotal = await io.savePlanVersion(v.plan, {
    origin: 'adjust',
    change_note: note,
    warnings: v.warnings,
  });
  return toResult(
    {
      ok: true,
      versions_total: versionsTotal,
      valid_from: v.plan.valid_from,
      valid_to: v.plan.valid_to,
      sessions: v.plan.sessions.length,
      note,
      warnings: v.warnings.map((i) => formatPlanIssue(i, lang)),
    },
    lang,
  );
};

/**
 * adjust_plan_sessions：课次级局部调整（U1 收尾，roadmap 2026-10-15 用户需求）——
 * ops 数组一次往返原子应用（core/plan-ops 逐操作校验 + 全计划 adjust 档复检，任一
 * 失败整批拒），免整发重排的 token 与「无关日被顺手改动」回归面。门控与落库口径同
 * update_training_plan（ctx.chat 放行、origin='adjust' 留档可逆）；确认落实协议
 * （先复述获肯定答复）在工具描述与 chat.plan 指令层约束，不做系统级强制闸门（§16 D6 先例）。
 */
const toolAdjustPlanSessions: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  if (!ctx?.chat) return errResult(t(lang, 'tp.tool.report_source'));
  const stored = await io.getTrainingPlan();
  if (!stored) return errResult(t(lang, 'tp.tool.no_plan'));
  const profile = await io.getProfile();
  const r = applyPlanSessionOps(stored.plan, args?.ops, localDay(), lang, {
    coachMode: profile.coach_mode,
    sessionMaxMin: profile.session_max_min,
  });
  if (!r.ok || !r.plan) {
    if (r.errors.length) return errResult(r.errors.join('；'));
    return toResult(
      {
        ok: false,
        violations: r.violations.map((i) => formatPlanIssue(i, lang)),
        hint: t(lang, 'tp.tool.adjust_hint'),
      },
      lang,
    );
  }
  const adjusted = r.plan;
  const note =
    typeof args?.change_note === 'string' ? args.change_note.trim().slice(0, 200) || null : null;
  const versionsTotal = await io.savePlanVersion(adjusted, {
    origin: 'adjust',
    change_note: note,
    warnings: r.warnings,
  });
  return toResult(
    {
      ok: true,
      versions_total: versionsTotal,
      applied: r.applied,
      valid_from: adjusted.valid_from,
      valid_to: adjusted.valid_to,
      sessions: adjusted.sessions.length,
      note,
      warnings: r.warnings.map((i) => formatPlanIssue(i, lang)),
    },
    lang,
  );
};

/** set_power_flag：标记/取消「功率不可信」（可逆；绑定层负责档案重建） */
const toolSetPowerFlag: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const name = safeName(String(args?.file_name ?? ''));
  if (!name) return errResult(t(lang, 'tool.name_invalid'));
  if (typeof args?.flagged !== 'boolean') return errResult(t(lang, 'tool.flag_invalid'));
  const reason = typeof args?.reason === 'string' ? args.reason.slice(0, 200) : null;
  return toResult(await io.setPowerFlag(name, args.flagged, lang, reason), lang);
};

/** recalibrate_activity_power：按系数缩放重算并写回（夹逼界限在 settings.POWER_CALIBRATION，服务层执行） */
const toolRecalibratePower: ToolImpl = async (args, ctx, io) => {
  const lang = ctx?.lang || 'zh';
  const name = safeName(String(args?.file_name ?? ''));
  if (!name) return errResult(t(lang, 'tool.name_invalid'));
  const scale = Number(args?.scale_factor);
  if (!Number.isFinite(scale)) return errResult(t(lang, 'tool.scale_invalid'));
  return toResult(await io.recalibratePower(name, scale, lang), lang);
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
  update_rider_profile: toolUpdateRiderProfile,
  estimate_ftp: toolEstimateFtp,
  simulate_form: toolSimulateForm,
  generate_workout: toolGenerateWorkout,
  save_memory: toolSaveMemory,
  get_dossier: toolGetDossier,
  get_training_plan: toolGetTrainingPlan,
  update_training_plan: toolUpdateTrainingPlan,
  adjust_plan_sessions: toolAdjustPlanSessions,
  set_power_flag: toolSetPowerFlag,
  recalibrate_activity_power: toolRecalibratePower,
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
      return await impl(args ?? {}, { source: base?.source, lang: base?.lang, chat: base?.chat }, io);
    } catch (e) {
      return errResult(t(lang, 'tool.failed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
}

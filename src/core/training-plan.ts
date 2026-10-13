/**
 * training-plan.ts — 结构化训练计划核心层（纯函数，无 IO，v2 训练计划载体）。
 *
 * 职责：AI 报告 ```plan-json 数据块的提取、课次 TSS 回填、格式与合理性双档校验
 * （create=周期规划生成，合理性仅警示；adjust=会话调整，合理性硬拒）、有效期判定、
 * 周视图切片与长期周聚合、基于 planning.simulateForm 的负荷推演。
 *
 * 口径：
 * - 阈值集中在 settings 的 PLAN_VALIDATION（代码单源），与 05-weekly-planning 技能一致；
 * - 计划日期一律本地日历日字符串（YYYY-MM-DD），日差运算按 UTC 锚定解析
 *   （与 taper 场景 daysLeft 同口径）；周一为一周起点（05 技能口径）；
 * - 合理性提示（warnings/violations）以结构化 PlanIssue 存库、渲染侧按语言拼装
 *   （口径同报告标题「渲染侧拼不落库」）；格式硬错（errors）为一次性消息，直接出文案；
 * - 本文件对 src/planning 是单向引用（仅复用 simulateForm 纯函数，planning 不回引本文件，无环）。
 */

import { t, type Lang } from './i18n.ts';
import { PLAN_VALIDATION } from './settings.ts';
import { simulateForm, type PlanDay, type SimRiskFlag } from '../planning/planning.ts';

// ---------------- 类型 ----------------

export const PLAN_SESSION_TYPES = [
  'rest',
  'recovery',
  'endurance',
  'long',
  'sweet_spot',
  'threshold',
  'vo2max',
] as const;
export type PlanSessionType = (typeof PLAN_SESSION_TYPES)[number];

/** 质量课集合（合理性校验的间隔规则作用对象，05 技能口径） */
const QUALITY_TYPES: readonly string[] = ['sweet_spot', 'threshold', 'vo2max'];

/** 课型 → 强度因子（与 WORKOUT_TEMPLATES 各模板 if 同源；long 按 endurance 口径） */
export const PLAN_TYPE_IF: Record<PlanSessionType, number> = {
  rest: 0,
  recovery: 0.5,
  endurance: 0.68,
  long: 0.68,
  sweet_spot: 0.91,
  threshold: 1.0,
  vo2max: 1.13,
};

/** 单条课次（date 为本地日历日；rest 课 duration_min 为 null） */
export interface PlanSession {
  date: string;
  type: PlanSessionType;
  duration_min: number | null;
  intensity: string | null; // 强度区间描述（如 "95–105% FTP"），模型自由文本，超限截断
  tss: number | null; // 训练负荷（缺失时由 resolvePlanTss 按 PLAN_TYPE_IF 估算回填）
  note: string | null; // 课表要点
}

/** 结构化训练计划（逐课次 + 计划级有效期与目标声明） */
export interface TrainingPlan {
  valid_from: string;
  valid_to: string;
  goal: string;
  sessions: PlanSession[];
}

/** 合理性提示（结构化存库，渲染侧经 formatPlanIssue 按语言拼） */
export interface PlanIssue {
  code: 'quality_gap' | 'no_rest' | 'no_recovery';
  vars: Record<string, string | number>;
}

/** 合理性提示 → 展示文案（语言在渲染时决定，不冻结在生成时） */
export function formatPlanIssue(issue: PlanIssue, lang: Lang = 'zh'): string {
  return t(lang, `tp.warn.${issue.code}`, issue.vars);
}

// ---------------- 日期工具（UTC 锚定，全文件内共用） ----------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const isDateStr = (v: unknown): v is string =>
  typeof v === 'string' && DATE_RE.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z'));

const parseDay = (s: string): number => Date.parse(s + 'T00:00:00Z');

/** b - a 的天数差（同日为 0） */
export const diffDays = (a: string, b: string): number =>
  Math.round((parseDay(b) - parseDay(a)) / DAY_MS);

/** 日期偏移（UI 周切换导航也用） */
export const addDays = (dateStr: string, n: number): string =>
  new Date(parseDay(dateStr) + n * DAY_MS).toISOString().slice(0, 10);

/** ISO 周一锚点（05 技能：周从周一开始） */
export function weekStartOf(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const shift = (d.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  return addDays(dateStr, -shift);
}

// ---------------- plan-json 提取与 TSS 回填 ----------------

export interface PlanParseResult {
  plan: unknown | null;
  error: string | null;
}

/**
 * 从报告 markdown 提取 ```plan-json 围栏 JSON 块（多处出现取最后一处——模型修正时
 * 以最终版为准）。缺块/坏 JSON 返回 error（生成链路的提取钩子据此放弃入库）。
 */
export function extractPlanFromMarkdown(markdown: string, lang: Lang = 'zh'): PlanParseResult {
  let last: string | null = null;
  for (const m of markdown.matchAll(/```plan-json\s*([\s\S]*?)```/g)) last = m[1];
  if (last == null) return { plan: null, error: t(lang, 'tp.no_block') };
  try {
    return { plan: JSON.parse(last), error: null };
  } catch (e) {
    return {
      plan: null,
      error: t(lang, 'tp.bad_json', { msg: e instanceof Error ? e.message : String(e) }),
    };
  }
}

/** 单课 TSS 估算：时长分钟 × 60 × IF² / 36（与 planning.segTss 同式）；rest / 缺时长为 0 */
export function estimateSessionTss(type: PlanSessionType, durationMin: number | null): number {
  if (type === 'rest' || durationMin == null || !Number.isFinite(durationMin)) return 0;
  const inf = PLAN_TYPE_IF[type];
  return Math.round(((durationMin * 60 * inf * inf) / 36) * 10) / 10;
}

/** 课次 TSS 回填：缺失或非有限值按课型×时长估算，已有有效值保留 */
export function resolvePlanTss(sessions: PlanSession[]): PlanSession[] {
  return sessions.map((s) => ({
    ...s,
    tss:
      s.tss != null && Number.isFinite(Number(s.tss))
        ? Number(s.tss)
        : estimateSessionTss(s.type, s.duration_min),
  }));
}

// ---------------- 双档校验（格式硬错 + 合理性警告/违规） ----------------

export interface PlanValidationResult {
  /** 格式硬错为空（合理性提示不影响本值；adjust 档是否拒收另看 violations） */
  ok: boolean;
  /** 规范化后的计划（goal/intensity/note 截断、课次排序、TSS 回填）；有硬错时为 null */
  plan: TrainingPlan | null;
  /** 格式硬错（两档都拒，一次性消息） */
  errors: string[];
  /** create 档合理性提示（存库展示，不拒收）；adjust 档恒为空 */
  warnings: PlanIssue[];
  /** adjust 档合理性违规（硬拒）；create 档恒为空 */
  violations: PlanIssue[];
}

/**
 * 结构化训练计划校验。
 * - 硬错：结构缺失、日期非法、窗长越界、valid_to 已过去 / valid_from 过早、
 *   课次越窗 / 一天多课 / 课型越界 / 时长越界（rest 外 10–600 分钟）/ tss 越界；
 * - 合理性（05 技能阈值，PLAN_VALIDATION 单源）：质量课间隔、休息日保留、减量周节奏；
 *   create 档记入 warnings（生成整份重生成代价高，降级为提示），adjust 档记入
 *   violations（会话调整逐次校验，不合理直接拒绝并说明理由）。
 * 拒收判定：`!result.ok || (mode === 'adjust' && result.violations.length > 0)`。
 */
export function validateTrainingPlan(
  raw: unknown,
  today: string,
  mode: 'create' | 'adjust',
  lang: Lang = 'zh',
): PlanValidationResult {
  const errors: string[] = [];
  const warnings: PlanIssue[] = [];
  const violations: PlanIssue[] = [];
  const flag = (issue: PlanIssue) => (mode === 'adjust' ? violations : warnings).push(issue);
  const fail = (msg: string) => {
    errors.push(msg);
    return { ok: false, plan: null, errors, warnings, violations };
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(t(lang, 'tp.shape'));
  const o = raw as Record<string, unknown>;

  // 计划级：有效期与目标
  if (!isDateStr(o.valid_from) || !isDateStr(o.valid_to))
    return fail(t(lang, 'tp.date_invalid', { key: 'valid_from / valid_to' }));
  const from = o.valid_from;
  const to = o.valid_to;
  const span = diffDays(from, to) + 1;
  if (span < PLAN_VALIDATION.min_window_days || span > PLAN_VALIDATION.max_window_days)
    errors.push(
      t(lang, 'tp.window', {
        min: PLAN_VALIDATION.min_window_days,
        max: PLAN_VALIDATION.max_window_days,
        n: span,
      }),
    );
  if (!isDateStr(today) || diffDays(from, today) > PLAN_VALIDATION.from_max_past_days)
    errors.push(t(lang, 'tp.from_past', { n: PLAN_VALIDATION.from_max_past_days }));
  if (isDateStr(today) && diffDays(today, to) < 0)
    errors.push(t(lang, 'tp.to_past', { date: today }));
  const goal = typeof o.goal === 'string' ? o.goal.trim().slice(0, 200) : '';

  // 课次级：一课一天、课型/时长/tss 越界即硬错（展示字段超限截断不报错）
  const rawSessions = Array.isArray(o.sessions) ? o.sessions : null;
  if (!rawSessions || rawSessions.length === 0)
    errors.push(t(lang, 'tp.session_empty'));
  const sessions: PlanSession[] = [];
  const seen = new Set<string>();
  const clip = (v: unknown, n: number): string | null => {
    const str = typeof v === 'string' ? v.trim() : '';
    return str ? str.slice(0, n) : null;
  };
  if (rawSessions) {
    for (let i = 0; i < rawSessions.length; i++) {
      const idx = i + 1;
      const s = rawSessions[i] as Record<string, unknown>;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        errors.push(t(lang, 'tp.session_shape', { i: idx }));
        continue;
      }
      if (!isDateStr(s.date)) {
        errors.push(t(lang, 'tp.session_date', { i: idx }));
        continue;
      }
      if (seen.has(s.date)) {
        errors.push(t(lang, 'tp.session_dup', { date: s.date }));
        continue;
      }
      seen.add(s.date);
      const type = PLAN_SESSION_TYPES.find((x) => x === s.type);
      if (!type) {
        errors.push(
          t(lang, 'tp.type_invalid', {
            i: idx,
            type: String(s.type),
            opts: PLAN_SESSION_TYPES.join('/'),
          }),
        );
        continue;
      }
      let duration: number | null = null;
      if (type !== 'rest') {
        const d = Number(s.duration_min);
        if (!Number.isInteger(d) || d < 10 || d > 600) {
          errors.push(t(lang, 'tp.duration_invalid', { i: idx }));
          continue;
        }
        duration = d;
      }
      const tssRaw = s.tss == null ? null : Number(s.tss);
      if (tssRaw != null && (!Number.isFinite(tssRaw) || tssRaw < 0 || tssRaw > 500)) {
        errors.push(t(lang, 'tp.tss_invalid', { i: idx }));
        continue;
      }
      // 越窗检查仅在前面的计划级校验都过了时做（窗口本身非法时必报错，无需叠加噪音）
      if (!errors.length && (diffDays(from, s.date) < 0 || diffDays(s.date, to) < 0)) {
        errors.push(t(lang, 'tp.session_range', { i: idx, date: s.date }));
        continue;
      }
      sessions.push({
        date: s.date,
        type,
        duration_min: duration,
        intensity: clip(s.intensity, 80),
        tss: type === 'rest' ? 0 : tssRaw, // rest 课负荷恒 0（模型误填也不计入周 TSS）
        note: clip(s.note, 200),
      });
    }
  }
  if (errors.length) return { ok: false, plan: null, errors, warnings, violations };

  // 升序排列：diffDays(a, b) = b − a，不能直接当比较器用（方向会反成降序）
  sessions.sort((a, b) => parseDay(a.date) - parseDay(b.date));
  const resolved = resolvePlanTss(sessions);

  // ---------------- 合理性校验（05 技能阈值） ----------------
  if (resolved.length) {
    // R1 质量课间隔：相邻质量课日期差 ≥2 天（「≥48h」的日粒度口径，边界 inclusive）
    const qs = resolved.filter((s) => QUALITY_TYPES.includes(s.type));
    for (let i = 1; i < qs.length; i++) {
      const gap = diffDays(qs[i - 1].date, qs[i].date);
      if (gap < PLAN_VALIDATION.quality_gap_days)
        flag({ code: 'quality_gap', vars: { a: qs[i - 1].date, b: qs[i].date, n: gap } });
    }

    // R2 休息日保留：窗内覆盖 ≥N 天的自然周须有休息日（显式 rest 课或整日无课都算）
    const byDate = new Map(resolved.map((s) => [s.date, s]));
    let week = weekStartOf(from);
    while (diffDays(week, to) >= 0) {
      const days: string[] = [];
      for (let k = 0; k < 7; k++) {
        const d = addDays(week, k);
        if (diffDays(from, d) < 0) continue; // 窗首残周：窗前日不计入覆盖
        if (diffDays(d, to) < 0) break; // 日期递增，越过窗尾即止
        days.push(d);
      }
      if (days.length >= PLAN_VALIDATION.week_min_covered_days) {
        const restDays = days.filter(
          (d) => !byDate.has(d) || byDate.get(d)!.type === 'rest',
        ).length;
        if (restDays === 0)
          flag({ code: 'no_rest', vars: { range: `${days[0]} ~ ${days[days.length - 1]}` } });
      }
      week = addDays(week, 7);
    }

    // R3 减量周节奏：任 N 连周（覆盖达标）须有 1 周计划 TSS ≤ 窗内最大周 × ratio
    const weekAggs = aggregatePlanWeeks(resolved);
    const n = PLAN_VALIDATION.recovery_window_weeks;
    for (let i = 0; i + n <= weekAggs.length; i++) {
      const win = weekAggs.slice(i, i + n);
      const max = Math.max(...win.map((w) => w.tss));
      if (!win.some((w) => w.tss <= max * PLAN_VALIDATION.recovery_week_ratio))
        flag({ code: 'no_recovery', vars: { a: win[0].week_start, n } });
    }
  }

  return {
    ok: true,
    plan: { valid_from: from, valid_to: to, goal, sessions: resolved },
    errors,
    warnings,
    violations,
  };
}

// ---------------- 有效期判定与视图数据 ----------------

export type PlanValidityState = 'upcoming' | 'valid' | 'expired';

/**
 * 计划有效期判定（确定性层：过期提示不进模型）。
 * days_left：valid = 距有效期结束的剩余天数；expired = 已过期天数；upcoming = 距开始天数。
 */
export function planValidity(
  plan: Pick<TrainingPlan, 'valid_from' | 'valid_to'>,
  today: string,
): { state: PlanValidityState; days_left: number } {
  if (diffDays(today, plan.valid_from) > 0)
    return { state: 'upcoming', days_left: diffDays(today, plan.valid_from) };
  const left = diffDays(today, plan.valid_to);
  if (left < 0) return { state: 'expired', days_left: -left };
  return { state: 'valid', days_left: left };
}

/** 长期视图的周聚合行（week_start 为 ISO 周一；recovery = 相对全计划最大周的减量周标记） */
export interface PlanWeekAgg {
  week_start: string;
  week_end: string;
  sessions: number; // 非 rest 课数
  quality: number; // 质量课数
  tss: number; // 计划 TSS 合计（1 位小数）
  recovery: boolean;
}

export function aggregatePlanWeeks(sessions: PlanSession[]): PlanWeekAgg[] {
  // 防御性回填：入参可能是未经 resolvePlanTss 的原始课次（缺 tss 时按课型估算，
  // 已有值幂等保留），否则周 TSS 会静默算 0
  const resolved = resolvePlanTss(sessions);
  const map = new Map<string, { sessions: number; quality: number; tss: number }>();
  for (const s of resolved) {
    const wk = weekStartOf(s.date);
    const cur = map.get(wk) ?? { sessions: 0, quality: 0, tss: 0 };
    if (s.type !== 'rest') cur.sessions += 1;
    if (QUALITY_TYPES.includes(s.type)) cur.quality += 1;
    cur.tss += s.tss ?? 0;
    map.set(wk, cur);
  }
  const rows: PlanWeekAgg[] = [...map.entries()]
    .sort((a, b) => parseDay(a[0]) - parseDay(b[0]))
    .map(([week_start, v]) => ({
      week_start,
      week_end: addDays(week_start, 6),
      sessions: v.sessions,
      quality: v.quality,
      tss: Math.round(v.tss * 10) / 10,
      recovery: false,
    }));
  const max = rows.length ? Math.max(...rows.map((r) => r.tss)) : 0;
  // 零负荷周（窗外空周/全休息周）不标减量——0 ≤ 阈值恒真会把空周误标成 Recovery
  for (const r of rows)
    r.recovery = max > 0 && r.tss > 0 && r.tss <= max * PLAN_VALIDATION.recovery_week_ratio;
  return rows;
}

/** 周视图切片：取 [weekStart, weekStart+6] 内的课次（入参计划已按日期升序） */
export function slicePlanWeek(plan: TrainingPlan, weekStart: string): PlanSession[] {
  const end = addDays(weekStart, 6);
  return plan.sessions.filter(
    (s) => diffDays(weekStart, s.date) >= 0 && diffDays(s.date, end) >= 0,
  );
}

export interface PlanFormProjection {
  risk_flags: SimRiskFlag[];
  end_form: { ctl: number; atl: number; tsb: number } | null;
}

/**
 * 计划负荷推演（展示用不阻断）：按计划窗逐日展开 TSS（无课日为 0），
 * 复用 simulateForm 的 CTL/ATL 递推与风险阈值标注（FORM_SIMULATION 单源）。
 */
export function projectPlanForm(
  plan: TrainingPlan,
  startCtl: number,
  startAtl: number,
  lang: Lang = 'zh',
): PlanFormProjection {
  const days: PlanDay[] = [];
  const resolved = resolvePlanTss(plan.sessions);
  for (let d = plan.valid_from; diffDays(d, plan.valid_to) >= 0; d = addDays(d, 1)) {
    const s = resolved.find((x) => x.date === d);
    days.push({ date: d, tss: s?.tss ?? 0 });
  }
  const sim = simulateForm({ startCtl, startAtl, plan: days, lang });
  return { risk_flags: sim.risk_flags, end_form: sim.end_form };
}

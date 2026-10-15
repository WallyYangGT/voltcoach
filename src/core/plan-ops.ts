/**
 * plan-ops.ts — 训练计划课次级操作原语（纯函数，U1 收尾：教练局部调整训练日）。
 *
 * 背景（roadmap 2026-10-15 用户需求）：此前一切会话调整都走 update_training_plan
 * 整体重发——token 随课次线性放大（42 课满额时改一天也要重发全计划）、模型重发
 * 长计划时无关日被顺手改动/抄错的回归风险。本层提供 move / swap / 改课型 / 改时长 /
 * 删课 / 插课六种原语，逐操作局部校验 + 全计划合理性复检（violations 复用双档校验、
 * 文案锚定受影响日期），TSS 回填复用 resolvePlanTss。
 *
 * 口径：
 * - 原子性：操作按序应用于副本，任一操作失败整批拒绝（errors 非空），绝不返回半改
 *   状态——工具层据此「一次往返、要么全成要么全拒」；
 * - 边界：操作日期必须在计划窗内且不早于今天（改历史拒）；目标日已有课时 move/insert
 *   拒绝并提示改用 swap 或 remove+insert（「交换还是替换」由模型复述向用户明示）；
 * - 落库仍走 settings 双 JSON 行与 training_plan_history（origin='adjust'），可逆半边
 *   现成（savePlanVersion 天然留档）；
 * - set_type/set_duration 改动后该课 tss 置空，由 resolvePlanTss 按新课型/时长重估
 *   （模型无需自己算 TSS，也与 estimateSessionTss 单源）；
 * - 全计划合理性复检用 adjust 档（quality_gap 等进 violations 硬拒，vars 已锚定具体两课）。
 */

import { t, type Lang } from './i18n.ts';
import {
  PLAN_SESSION_TYPES,
  diffDays,
  resolvePlanTss,
  validateTrainingPlan,
  type PlanIssue,
  type PlanSession,
  type PlanSessionType,
  type TrainingPlan,
} from './training-plan.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateStr = (v: unknown): v is string =>
  typeof v === 'string' && DATE_RE.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z'));

const clip = (v: unknown, n: number): string | null => {
  const str = typeof v === 'string' ? v.trim() : '';
  return str ? str.slice(0, n) : null;
};

/** 单次提交的操作数上限（42 课满额计划也远用不到 20 个，防失控长数组） */
export const PLAN_OPS_MAX = 20;

export type PlanSessionOp =
  | { op: 'move'; from: string; to: string }
  | { op: 'swap'; a: string; b: string }
  | { op: 'set_type'; date: string; type: PlanSessionType; duration_min?: number | null }
  | { op: 'set_duration'; date: string; duration_min: number }
  | { op: 'remove'; date: string }
  | {
      op: 'insert';
      date: string;
      type: PlanSessionType;
      duration_min?: number | null;
      intensity?: string | null;
      note?: string | null;
    };

export interface PlanOpsResult {
  ok: boolean;
  /** 调整后的完整计划（已过 adjust 档全计划复检）；失败为 null */
  plan: TrainingPlan | null;
  /** 操作级错误（一次性文案，锚定操作序号与日期） */
  errors: string[];
  /** 全计划合理性复检违规（adjust 档；渲染侧经 formatPlanIssue 拼文案） */
  violations: PlanIssue[];
  /** 实际应用的操作清单（成功时返回，供模型向用户复述「动了哪些课」） */
  applied: PlanSessionOp[];
}

const fail = (errors: string[], violations: PlanIssue[] = []): PlanOpsResult => ({
  ok: false,
  plan: null,
  errors,
  violations,
  applied: [],
});

/**
 * 对当前计划应用一组课次级操作（原子）：
 * 逐操作在副本上顺序校验并应用（后续操作看到的是前面操作的结果），全部通过后
 * resolvePlanTss 回填 + validateTrainingPlan(mode:'adjust') 全计划复检。
 * today 为本地日历日（计划链路口径）。
 */
export function applyPlanSessionOps(
  plan: TrainingPlan,
  ops: unknown,
  today: string,
  lang: Lang = 'zh',
): PlanOpsResult {
  if (!Array.isArray(ops) || ops.length === 0) return fail([t(lang, 'tp.op.empty')]);
  if (ops.length > PLAN_OPS_MAX) return fail([t(lang, 'tp.op.too_many', { n: PLAN_OPS_MAX })]);

  const errors: string[] = [];
  const working: PlanSession[] = plan.sessions.map((s) => ({ ...s }));
  const applied: PlanSessionOp[] = [];
  const indexOf = (date: string) => working.findIndex((s) => s.date === date);

  /** 操作日期三连检：格式 → 计划窗内 → 不早于今天；任一不过返回 null（错误已入列） */
  const checkDate = (d: unknown, opName: string, i: number): string | null => {
    if (!isDateStr(d)) {
      errors.push(t(lang, 'tp.op.date', { i, op: opName, date: String(d) }));
      return null;
    }
    if (diffDays(plan.valid_from, d) < 0 || diffDays(d, plan.valid_to) < 0) {
      errors.push(
        t(lang, 'tp.op.range', { i, op: opName, date: d, from: plan.valid_from, to: plan.valid_to }),
      );
      return null;
    }
    if (diffDays(d, today) > 0) {
      errors.push(t(lang, 'tp.op.past', { i, op: opName, date: d, today }));
      return null;
    }
    return d;
  };

  for (let k = 0; k < ops.length; k++) {
    const i = k + 1;
    const raw = ops[k];
    const name = raw && typeof raw === 'object' && !Array.isArray(raw) ? String((raw as Record<string, unknown>).op ?? '') : '';
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !['move', 'swap', 'set_type', 'set_duration', 'remove', 'insert'].includes(name)
    ) {
      errors.push(t(lang, 'tp.op.shape', { i }));
      break;
    }
    const o = raw as Record<string, unknown>;

    if (name === 'move') {
      const from = checkDate(o.from, name, i);
      const to = from != null ? checkDate(o.to, name, i) : null;
      if (from == null || to == null) break;
      const src = working[indexOf(from)];
      if (!src) {
        errors.push(t(lang, 'tp.op.no_session', { i, op: name, date: from }));
        break;
      }
      if (indexOf(to) >= 0) {
        errors.push(t(lang, 'tp.op.occupied', { i, op: name, date: to }));
        break;
      }
      src.date = to;
      applied.push({ op: 'move', from, to });
      continue;
    }

    if (name === 'swap') {
      const a = checkDate(o.a, name, i);
      const b = a != null ? checkDate(o.b, name, i) : null;
      if (a == null || b == null) break;
      const sa = working[indexOf(a)];
      const sb = working[indexOf(b)];
      if (!sa || !sb) {
        errors.push(t(lang, 'tp.op.no_session', { i, op: name, date: sa ? b : a }));
        break;
      }
      sa.date = b;
      sb.date = a;
      applied.push({ op: 'swap', a, b });
      continue;
    }

    if (name === 'set_type') {
      const date = checkDate(o.date, name, i);
      if (date == null) break;
      const s = working[indexOf(date)];
      if (!s) {
        errors.push(t(lang, 'tp.op.no_session', { i, op: name, date }));
        break;
      }
      const type = PLAN_SESSION_TYPES.find((x) => x === o.type);
      if (!type) {
        errors.push(
          t(lang, 'tp.op.type', { i, type: String(o.type), opts: PLAN_SESSION_TYPES.join('/') }),
        );
        break;
      }
      if (type === 'rest') {
        s.type = 'rest';
        s.duration_min = null;
        s.intensity = null;
        s.tss = 0; // rest 课负荷恒 0（与校验器同口径）
      } else {
        // rest → 训练课必须给时长；训练课 → 训练课缺省沿用原时长
        const needDuration = s.type === 'rest' && o.duration_min == null;
        if (needDuration) {
          errors.push(t(lang, 'tp.op.duration_required', { i, op: name }));
          break;
        }
        const d = o.duration_min != null ? Number(o.duration_min) : s.duration_min;
        if (d == null || !Number.isInteger(d) || d < 10 || d > 600) {
          errors.push(t(lang, 'tp.op.duration', { i, op: name }));
          break;
        }
        s.type = type;
        s.duration_min = d;
        s.tss = null; // 课型/时长变了，旧 TSS 作废 → 由 resolvePlanTss 按新课型重估
      }
      applied.push({ op: 'set_type', date, type, duration_min: s.duration_min });
      continue;
    }

    if (name === 'set_duration') {
      const date = checkDate(o.date, name, i);
      if (date == null) break;
      const s = working[indexOf(date)];
      if (!s) {
        errors.push(t(lang, 'tp.op.no_session', { i, op: name, date }));
        break;
      }
      if (s.type === 'rest') {
        errors.push(t(lang, 'tp.op.rest_no_duration', { i, date }));
        break;
      }
      const d = Number(o.duration_min);
      if (!Number.isInteger(d) || d < 10 || d > 600) {
        errors.push(t(lang, 'tp.op.duration', { i, op: name }));
        break;
      }
      s.duration_min = d;
      s.tss = null; // 时长变了 → 重估 TSS（同 set_type）
      applied.push({ op: 'set_duration', date, duration_min: d });
      continue;
    }

    if (name === 'remove') {
      const date = checkDate(o.date, name, i);
      if (date == null) break;
      const idx = indexOf(date);
      if (idx < 0) {
        errors.push(t(lang, 'tp.op.no_session', { i, op: name, date }));
        break;
      }
      working.splice(idx, 1);
      applied.push({ op: 'remove', date });
      continue;
    }

    // insert
    const date = checkDate(o.date, name, i);
    if (date == null) break;
    if (indexOf(date) >= 0) {
      errors.push(t(lang, 'tp.op.occupied', { i, op: name, date }));
      break;
    }
    const type = PLAN_SESSION_TYPES.find((x) => x === o.type);
    if (!type) {
      errors.push(
        t(lang, 'tp.op.type', { i, type: String(o.type), opts: PLAN_SESSION_TYPES.join('/') }),
      );
      break;
    }
    let duration: number | null = null;
    if (type !== 'rest') {
      const d = Number(o.duration_min);
      if (o.duration_min == null || !Number.isInteger(d) || d < 10 || d > 600) {
        errors.push(t(lang, 'tp.op.duration_required', { i, op: name }));
        break;
      }
      duration = d;
    }
    working.push({
      date,
      type,
      duration_min: duration,
      intensity: clip(o.intensity, 80),
      tss: null, // 由 resolvePlanTss 按课型×时长估算
      note: clip(o.note, 200),
    });
    applied.push({ op: 'insert', date, type, duration_min: duration });
  }
  if (errors.length) return fail(errors);

  // 全计划复检（adjust 档）：合理性违规（质量课间隔/休息日/减量周）进 violations 硬拒，
  // 格式硬错（窗口/越界等，正常到不了这里——操作日期已逐个验过）进 errors。
  // 先按日期升序（diffDays(a,b)=b−a，取 diffDays(b.date,a.date) 即升序比较器）
  working.sort((a, b) => diffDays(b.date, a.date));
  const merged: TrainingPlan = {
    valid_from: plan.valid_from,
    valid_to: plan.valid_to,
    goal: plan.goal,
    sessions: resolvePlanTss(working),
  };
  const v = validateTrainingPlan(merged, today, 'adjust', lang);
  if (!v.ok) return fail(v.errors);
  if (v.violations.length) return fail([], v.violations);
  return { ok: true, plan: v.plan, errors: [], violations: [], applied };
}

/**
 * profile.ts — 骑手档案（身份/目标 + 教练模式与时间预算）的纯校验与合并层。
 *
 * 为什么独立成纯函数：档案存在 settings 表 profile JSON 行（无 schema 迁移），
 * 写入路径有两处——设置页表单与 AI 工具 update_rider_profile；校验与合并规则
 * 必须单一来源，且要能进 node:test（db 层依赖 expo-sqlite，不可直测）。
 *
 * 字段口径：
 *  - coach_mode：null = 未设置（首次生成计划时由教练询问）；amateur = 业余/健康
 *    导向（用户期望与时间预算主导）；standard = 系统训练提升；
 *  - weekly_hours：每周可用时间档（区间档，防用户高估时间；TrainerRoad volume
 *    tier 先例），null = 未设置；
 *  - available_days：可骑的星期编号 1–7（1=周一 … 7=周日，与 ISO 周口径一致；
 *    空数组 = 未设置/不限），去重升序存储；
 *  - session_max_min：单次骑行时长上限（分钟 10–600，与 plan 课次时长硬错区间
 *    同口径），null = 未设置。
 *
 * 未知字段一律忽略（前向兼容：未来加字段时旧客户端读到不认识的键不报错）。
 */

import { t, type Lang } from './i18n.ts';
import {
  COACH_PROFILE_LIMITS,
  WEEKLY_HOURS_TIERS,
  type CoachMode,
  type WeeklyHoursTier,
} from './settings.ts';

export const COACH_MODES: readonly CoachMode[] = ['amateur', 'standard'];
export const IDENTITY_MAX = 100;
export const GOAL_MAX = 500;

/** 档案数据（不含 configured；db 层返回值在此基础上加 configured） */
export interface RiderProfileData {
  identity: string;
  goal: string;
  coach_mode: CoachMode | null;
  weekly_hours: WeeklyHoursTier | null;
  available_days: number[];
  session_max_min: number | null;
}

/** 局部更新入参：undefined = 不修改；null（模式/时长档/单次上限）或 []（可用日）清空；identity/goal 传空字符串清空 */
export interface RiderProfilePatch {
  identity?: string;
  goal?: string;
  coach_mode?: CoachMode | null;
  weekly_hours?: WeeklyHoursTier | null;
  available_days?: number[];
  session_max_min?: number | null;
}

export function emptyProfile(): RiderProfileData {
  return {
    identity: '',
    goal: '',
    coach_mode: null,
    weekly_hours: null,
    available_days: [],
    session_max_min: null,
  };
}

/**
 * 容错解析存档（行内容损坏/旧版本缺字段/未来未知字段时按空值处理，不抛错）。
 * 旧版本 profile 行只有 identity/goal；未知值（如手改的枚举）一律归 null。
 */
export function parseStoredProfile(raw: unknown): RiderProfileData {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const mode = p.coach_mode;
  const hours = p.weekly_hours;
  const max = p.session_max_min;
  const days = Array.isArray(p.available_days)
    ? [...new Set(p.available_days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7))].sort(
        (a, b) => a - b,
      )
    : [];
  return {
    identity: typeof p.identity === 'string' ? p.identity : '',
    goal: typeof p.goal === 'string' ? p.goal : '',
    coach_mode: COACH_MODES.includes(mode as CoachMode) ? (mode as CoachMode) : null,
    weekly_hours: WEEKLY_HOURS_TIERS.includes(hours as WeeklyHoursTier)
      ? (hours as WeeklyHoursTier)
      : null,
    available_days: days,
    session_max_min:
      Number.isInteger(max) &&
      (max as number) >= COACH_PROFILE_LIMITS.session_max_min.min &&
      (max as number) <= COACH_PROFILE_LIMITS.session_max_min.max
        ? (max as number)
        : null,
  };
}

/** 是否所有字段都为空（空档案时 db 层删除 settings 行，与旧 identity/goal 口径一致） */
export function isProfileEmpty(p: RiderProfileData): boolean {
  return (
    !p.identity &&
    !p.goal &&
    p.coach_mode == null &&
    p.weekly_hours == null &&
    p.available_days.length === 0 &&
    p.session_max_min == null
  );
}

/**
 * 合并并校验一次局部更新。非法值抛双语 Error（message 直接展示或经工具层转述）；
 * 合法时返回新对象（不改入参）。
 */
export function normalizeProfilePatch(
  current: RiderProfileData,
  patch: Partial<RiderProfilePatch> | null | undefined,
  lang: Lang = 'zh',
): RiderProfileData {
  // 显式逐字段构造（不展开 current）：current 在生产路径是 db 的 RiderProfile，
  // 带 configured 派生字段，展开会把派生值序列化进 settings JSON 行（review P2-3）
  const next: RiderProfileData = {
    identity: current.identity,
    goal: current.goal,
    coach_mode: current.coach_mode,
    weekly_hours: current.weekly_hours,
    available_days: [...current.available_days],
    session_max_min: current.session_max_min,
  };
  const p = patch ?? {};

  for (const [key, max] of [
    ['identity', IDENTITY_MAX],
    ['goal', GOAL_MAX],
  ] as const) {
    if (p[key] == null) continue;
    if (typeof p[key] !== 'string') throw new Error(t(lang, 'profile.type', { key }));
    const v = (p[key] as string).trim();
    if (v.length > max) throw new Error(t(lang, 'profile.too_long', { key, n: max }));
    next[key] = v;
  }

  if (p.coach_mode !== undefined) {
    if (p.coach_mode !== null && !COACH_MODES.includes(p.coach_mode))
      throw new Error(t(lang, 'profile.enum', { key: 'coach_mode', opts: COACH_MODES.join('/') }));
    next.coach_mode = p.coach_mode ?? null;
  }

  if (p.weekly_hours !== undefined) {
    if (p.weekly_hours !== null && !WEEKLY_HOURS_TIERS.includes(p.weekly_hours))
      throw new Error(
        t(lang, 'profile.enum', { key: 'weekly_hours', opts: WEEKLY_HOURS_TIERS.join('/') }),
      );
    next.weekly_hours = p.weekly_hours ?? null;
  }

  if (p.available_days !== undefined) {
    if (!Array.isArray(p.available_days))
      throw new Error(t(lang, 'profile.days'));
    const days = p.available_days;
    if (!days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7))
      throw new Error(t(lang, 'profile.days'));
    next.available_days = [...new Set(days)].sort((a, b) => a - b);
  }

  if (p.session_max_min !== undefined) {
    if (p.session_max_min !== null) {
      const v = p.session_max_min;
      const { min, max } = COACH_PROFILE_LIMITS.session_max_min;
      if (!Number.isInteger(v) || v < min || v > max)
        throw new Error(t(lang, 'profile.range', { key: 'session_max_min', min, max }));
      next.session_max_min = v;
    } else {
      next.session_max_min = null;
    }
  }

  return next;
}

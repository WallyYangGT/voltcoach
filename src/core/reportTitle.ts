/**
 * reportTitle.ts — AI 报告标题装配（纯函数层，M5）
 *
 * 背景：报告卡片此前直接拿 file_name 当标题（review/compare）、plan 干脆没有标题
 * （file_name 为 NULL）、详情页头部只显示模式名（「复盘」）——列表里认不出报告对应
 * 哪次骑行、哪段周期。
 *
 * 口径（2026-09-23 定，标题在渲染时拼、不落库，语言切换后仍能重算）：
 *  - review：`复盘骑行 2026年09月20日 08时`——运动类型取 activities.sport，时刻取该
 *    活动 records 首帧时间戳（转本地时区）；缺 records 时退化到只显示日期；
 *  - plan：`周期规划 2026年09月21日-10月18日`——窗口为生成时刻所在自然周的周一起
 *    28 天（本周 + 后续 3 周，与技能库 05-weekly-planning「周从周一开始」同口径，
 *    覆盖提示词里的「下一周逐日建议」+「中期 4-8 周方向」）；
 *  - taper：`赛前减量 2026年10月05日`（race_date 已落库）；
 *  - compare：`对比 2026年09月20日 vs 2026年09月13日`。
 *
 * 文案模板走 UI 词典（调用方注入 t），本模块只负责日期/区间格式化与分支选择；
 * core 层不 import src/i18n（只声明自己需要的 key 联合类型）。
 */

import dayjs, { type Dayjs } from 'dayjs';
import type { Lang } from './i18n.ts';

export type ReportTitleMode = 'review' | 'plan' | 'taper' | 'compare';

/** 本模块用到的词典 key（zh/en 必须齐备，由 test/report-title.test.mjs 断言） */
export type ReportTitleKey =
  | 'ai.report.title.review'
  | 'ai.report.title.review_nosport'
  | 'ai.report.title.review_gone'
  | 'ai.report.title.plan'
  | 'ai.report.title.plan_norange'
  | 'ai.report.title.taper'
  | 'ai.report.title.taper_plain'
  | 'ai.report.title.compare'
  | 'ai.report.title.compare_plain';

/** 取词函数（注入 UI 词典的 t；key 收窄到本模块用到的集合） */
export type ReportTitleTranslate = (
  key: ReportTitleKey,
  vars?: Record<string, string | number>,
) => string;

/** 骑行简报（取不到 = 训练已删除或数据缺失） */
export interface RideBrief {
  /** 已本地化的运动类型名；unknown/缺失时传 null（标题走泛称模板） */
  sport?: string | null;
  /** 起骑时刻（ISO UTC，来自 records 首帧）；缺省退化到只显示日期 */
  startAt?: string | null;
  /** 活动日期（YYYY-MM-DD，UTC 口径，与训练列表显示一致） */
  date?: string | null;
}

export interface ReportTitleInput {
  mode: ReportTitleMode;
  lang: Lang;
  /** review：本次骑行；compare：第一趟骑行 */
  ride?: RideBrief | null;
  /** compare：第二趟骑行 */
  other?: RideBrief | null;
  /** taper：比赛日期（YYYY-MM-DD） */
  raceDate?: string | null;
  /** plan：生成时刻（sqlite UTC "YYYY-MM-DD HH:MM:SS"），据此推规划窗口 */
  createdAt?: string | null;
}

/** 规划窗口长度（天）：本周 + 后续 3 周 */
export const PLAN_WINDOW_DAYS = 28;

/**
 * sqlite UTC 时间串（"YYYY-MM-DD HH:MM:SS"）→ 本地时区的 dayjs；
 * 已是 ISO（含 T/Z）的原样解析；空串/非法返回 null。
 */
function parseSqliteUtc(s: string | null | undefined): Dayjs | null {
  if (!s) return null;
  const d = dayjs(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return d.isValid() ? d : null;
}

/** 单日文本：zh「2026年09月20日」/ en「Sep 20, 2026」 */
function fmtDay(d: Dayjs, lang: Lang): string {
  return lang === 'en' ? d.locale('en').format('MMM D, YYYY') : d.format('YYYY年MM月DD日');
}

/** 起骑时刻（本地）：有 startAt 时带「HH时」/「HH:mm」，否则只有日期 */
function fmtRideTime(brief: RideBrief | null | undefined, lang: Lang): string | null {
  if (!brief) return null;
  const at = parseSqliteUtc(brief.startAt) ?? (brief.date ? dayjs(brief.date) : null);
  if (!at || !at.isValid()) return null;
  const day = fmtDay(at, lang);
  if (!brief.startAt) return day; // 没有逐秒记录 → 只到日期
  return `${day} ${lang === 'en' ? at.format('HH:mm') : at.format('HH时')}`;
}

/**
 * 日期区间文本：同年只写一次年份（zh 前段带年份「2026年09月21日-10月18日」，
 * en 后段带年份「Sep 21 – Oct 18, 2026」，各自的行文习惯），跨年两端都带。
 */
function fmtRange(start: Dayjs, end: Dayjs, lang: Lang): string {
  const sameYear = start.year() === end.year();
  if (lang === 'en') {
    const s = sameYear ? start.locale('en').format('MMM D') : start.locale('en').format('MMM D, YYYY');
    return `${s} – ${end.locale('en').format('MMM D, YYYY')}`;
  }
  const e = sameYear ? end.format('MM月DD日') : end.format('YYYY年MM月DD日');
  return `${start.format('YYYY年MM月DD日')}-${e}`;
}

/**
 * 规划窗口：生成时刻所在自然周的周一 00:00 起 PLAN_WINDOW_DAYS 天（含首日）。
 * 生成时刻缺失/非法返回 null（标题退化为不带范围的「周期规划」，不去猜当前时刻——
 * 报告行由 SQLite 默认值写 created_at，实际不会缺）。
 */
export function planWindow(createdAt: string | null | undefined): { start: Dayjs; end: Dayjs } | null {
  const base = parseSqliteUtc(createdAt);
  if (!base || !base.isValid()) return null;
  const dow = (base.day() + 6) % 7; // dayjs 的 0 是周日 → 转成 0=周一
  const start = base.subtract(dow, 'day').startOf('day');
  return { start, end: start.add(PLAN_WINDOW_DAYS - 1, 'day') };
}

/** 报告标题（各模式的降级分支见文件头；t 由调用方注入 UI 词典） */
export function reportTitle(input: ReportTitleInput, t: ReportTitleTranslate): string {
  const { mode, lang } = input;

  if (mode === 'plan') {
    const w = planWindow(input.createdAt);
    return w
      ? t('ai.report.title.plan', { range: fmtRange(w.start, w.end, lang) })
      : t('ai.report.title.plan_norange');
  }

  if (mode === 'taper') {
    const d = input.raceDate ? dayjs(input.raceDate) : null;
    return d && d.isValid()
      ? t('ai.report.title.taper', { date: fmtDay(d, lang) })
      : t('ai.report.title.taper_plain');
  }

  if (mode === 'compare') {
    const a = fmtRideTime(input.ride, lang);
    const b = fmtRideTime(input.other, lang);
    // 任一侧取不到日期（训练已删或缺数据）→ 泛称标题，不显示"vs undefined"
    return a && b ? t('ai.report.title.compare', { a, b }) : t('ai.report.title.compare_plain');
  }

  // review
  const time = fmtRideTime(input.ride, lang);
  if (!time) return t('ai.report.title.review_gone');
  const sport = input.ride?.sport ?? null;
  return sport
    ? t('ai.report.title.review', { sport, time })
    : t('ai.report.title.review_nosport', { time });
}

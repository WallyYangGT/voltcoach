/**
 * local-day.ts — 本地日历日助手（v2 训练计划载体引入）。
 *
 * 口径：「用户直觉的一天」= 本地时区的日历日，与 AI 报告标题的本地时区口径一致
 * （decisions §9.10）。不要用 `new Date().toISOString().slice(0, 10)` 取「今天」——
 * 那是 UTC 日历日，UTC+8 的凌晨 0–8 点会差一天（训练列表与报告标题双口径的根源，
 * 统一立项见 roadmap）。训练计划全链路（有效期判定 / 周视图锚点 / 工具层 today）
 * 一律走本助手，不新增第三处 UTC 日口径。
 */

import dayjs from 'dayjs';

/** 时刻 → 本地日历日 YYYY-MM-DD（缺省当前时刻） */
export function localDay(d: Date | string = new Date()): string {
  return dayjs(d).format('YYYY-MM-DD');
}

/**
 * local-day.ts — 本地日历日助手（v2 训练计划载体引入；2026-10 全局面统一后成为
 * 展示面与 AI 数据面的共用口径源）。
 *
 * 口径：「用户直觉的一天」= 本地时区的日历日，与 AI 报告标题的本地时区口径一致
 * （decisions §9.10）。不要用 `new Date().toISOString().slice(0, 10)` 取「今天」——
 * 那是 UTC 日历日，UTC+8 的凌晨 0–8 点会差一天（训练列表与报告标题双口径的根源，
 * 已统一：训练计划全链路（有效期判定 / 周视图锚点 / 工具层 today）、用户可见的
 * 骑行日期展示与喂 AI 的纯日期字段一律走本助手，不新增 UTC 日口径。存储与去重
 * 的「同一 UTC 日期」判据不动（那是数据面自身自洽的口径，见 core/dedupe）。
 */

import dayjs from 'dayjs';

/** 时刻 → 本地日历日 YYYY-MM-DD（缺省当前时刻） */
export function localDay(d: Date | string = new Date()): string {
  return dayjs(d).format('YYYY-MM-DD');
}

/**
 * UTC 时刻 → 本地日历日 YYYY-MM-DD；解析失败返回 null。
 *
 * 接受两种存储形态：records 首帧的 ISO UTC（`…Z` 结尾）与 SQLite `datetime('now')`
 * 的 UTC 文本（`YYYY-MM-DD HH:MM:SS`，无时区标记，补 Z 再解析）。纯日期字符串
 * （如 activities.date）不是时刻、无法精确换算本地日，一律返回 null——调用方
 * （整形层/展示层）拿到 null 时回退原值，绝不猜测。
 */
export function localDayFromUtc(s: string | null | undefined): string | null {
  if (!s) return null;
  const text = String(s).trim();
  let d;
  if (/Z$/i.test(text)) {
    d = dayjs(text);
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) {
    d = dayjs(`${text.replace(' ', 'T')}Z`);
  } else {
    return null;
  }
  return d.isValid() ? d.format('YYYY-MM-DD') : null;
}

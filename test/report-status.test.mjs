/**
 * report-status.test.mjs — AI 生成状态纯判定（src/core/report-status.ts）的回归断言。
 *
 * 1) shouldPollReport：守住 2026-09-22 真机事故——失败后在页内点重试，重试成功也不
 *    刷新界面（必须退出重进）。轮询条件必须覆盖"库状态仍是 failed、但进程内有任务在跑"。
 * 2) parseDbUtcTimestamp / withinResumeWindow：M5 回前台自动续跑窗口的判定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { shouldPollReport, parseDbUtcTimestamp, withinResumeWindow } = await import(
  '../src/core/report-status.ts'
);

/** 默认全 false 的输入（各用例只覆盖关心的位） */
const base = {
  status: 'completed',
  retrying: false,
  taskRunning: false,
  chatPending: false,
  chatRunning: false,
};

test('shouldPollReport: pending 报告持续轮询', () => {
  assert.equal(shouldPollReport({ ...base, status: 'pending', taskRunning: true }), true);
});

test('shouldPollReport: 失败后手动重试中仍要轮询（否则重试成功界面不刷新）', () => {
  assert.equal(shouldPollReport({ ...base, status: 'failed', retrying: true, taskRunning: true }), true);
});

test('shouldPollReport: 库状态已是 failed 但进程内有任务在跑 → 继续轮询', () => {
  assert.equal(shouldPollReport({ ...base, status: 'failed', taskRunning: true }), true);
});

test('shouldPollReport: 追问消息生成中也要轮询（否则气泡永远停在"生成中"）', () => {
  assert.equal(shouldPollReport({ ...base, chatPending: true }), true);
});

test('shouldPollReport: 追问消息重试中也要轮询（库状态仍是 failed、内容稍后回写）', () => {
  assert.equal(shouldPollReport({ ...base, status: 'failed', chatRunning: true }), true);
});

test('shouldPollReport: 完成且无任务无追问 → 停止轮询（不空转）', () => {
  assert.equal(shouldPollReport(base), false);
  assert.equal(shouldPollReport({ ...base, status: null }), false);
});

test('shouldPollReport: cancelled 不轮询（取消后无任何补跑路径，不得复活）', () => {
  assert.equal(shouldPollReport({ ...base, status: 'cancelled' }), false);
  assert.equal(shouldPollReport({ ...base, status: 'cancelled', chatPending: false }), false);
});

// ---------------- shouldFlushPartial：增量落库节流（2026-10） ----------------

const { shouldFlushPartial, STREAM_FLUSH_MIN_CHARS, STREAM_FLUSH_MIN_MS } = await import(
  '../src/core/report-status.ts'
);

test('shouldFlushPartial: 字数与间隔同时过线才写库', () => {
  assert.equal(shouldFlushPartial(STREAM_FLUSH_MIN_CHARS, STREAM_FLUSH_MIN_MS), true);
  assert.equal(shouldFlushPartial(STREAM_FLUSH_MIN_CHARS - 1, STREAM_FLUSH_MIN_MS + 9999), false); // 字数不足
  assert.equal(shouldFlushPartial(STREAM_FLUSH_MIN_CHARS + 9999, STREAM_FLUSH_MIN_MS - 1), false); // 间隔不足
});

test('shouldFlushPartial: 恰好低于阈值其一即 false（边界含等号在过线侧）', () => {
  assert.equal(shouldFlushPartial(0, 0), false);
  assert.equal(shouldFlushPartial(199, 5000), false);
  assert.equal(shouldFlushPartial(5000, 1999), false);
});

// ---------------- parseDbUtcTimestamp：SQLite datetime('now') 的 UTC 无时区串 ----------------

const NOW = Date.parse('2026-09-24T08:00:00Z');

test('parseDbUtcTimestamp: datetime(\'now\') 格式补 Z 按 UTC 解析', () => {
  assert.equal(parseDbUtcTimestamp('2026-09-24 08:00:00'), NOW);
  assert.equal(parseDbUtcTimestamp('2026-09-24 07:59:59'), NOW - 1000);
});

test('parseDbUtcTimestamp: ISO 带 T 的串原样兼容；非法/空值为 null', () => {
  assert.equal(parseDbUtcTimestamp('2026-09-24T08:00:00Z'), NOW);
  assert.equal(parseDbUtcTimestamp(''), null);
  assert.equal(parseDbUtcTimestamp(null), null);
  assert.equal(parseDbUtcTimestamp(undefined), null);
  assert.equal(parseDbUtcTimestamp('not-a-date'), null);
});

// ---------------- withinResumeWindow：残留自动续跑窗口 ----------------

const HOUR = 3600_000;

test('withinResumeWindow: 刚打断与窗口边界内为 true', () => {
  assert.equal(withinResumeWindow('2026-09-24 08:00:00', NOW, HOUR), true);
  assert.equal(withinResumeWindow('2026-09-24 07:00:00', NOW, HOUR), true); // 恰好等于窗口
});

test('withinResumeWindow: 超窗 / 未来时刻 / 空值为 false', () => {
  assert.equal(withinResumeWindow('2026-09-24 06:59:59', NOW, HOUR), false);
  assert.equal(withinResumeWindow('2026-09-24 08:00:01', NOW, HOUR), false); // 时钟回拨
  assert.equal(withinResumeWindow('', NOW, HOUR), false);
  assert.equal(withinResumeWindow(null, NOW, HOUR), false);
});

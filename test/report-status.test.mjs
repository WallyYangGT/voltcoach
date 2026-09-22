/**
 * report-status.test.mjs — 报告轮询判定（src/core/report-status.ts）的回归断言。
 *
 * 守住 2026-09-22 真机事故：失败后在页内点重试，重试成功也不刷新界面（必须退出重进）。
 * 轮询条件必须覆盖"库状态仍是 failed、但进程内有任务在跑"这一段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { shouldPollReport } = await import('../src/core/report-status.ts');

test('shouldPollReport: pending 报告持续轮询', () => {
  assert.equal(
    shouldPollReport({ status: 'pending', retrying: false, taskRunning: true, chatPending: false }),
    true,
  );
});

test('shouldPollReport: 失败后手动重试中仍要轮询（否则重试成功界面不刷新）', () => {
  assert.equal(
    shouldPollReport({ status: 'failed', retrying: true, taskRunning: true, chatPending: false }),
    true,
  );
});

test('shouldPollReport: 库状态已是 failed 但进程内有任务在跑 → 继续轮询', () => {
  assert.equal(
    shouldPollReport({ status: 'failed', retrying: false, taskRunning: true, chatPending: false }),
    true,
  );
});

test('shouldPollReport: 追问消息生成中也要轮询（否则气泡永远停在"生成中"）', () => {
  assert.equal(
    shouldPollReport({ status: 'completed', retrying: false, taskRunning: false, chatPending: true }),
    true,
  );
});

test('shouldPollReport: 完成且无任务无追问 → 停止轮询（不空转）', () => {
  assert.equal(
    shouldPollReport({ status: 'completed', retrying: false, taskRunning: false, chatPending: false }),
    false,
  );
  assert.equal(
    shouldPollReport({ status: null, retrying: false, taskRunning: false, chatPending: false }),
    false,
  );
});

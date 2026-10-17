/**
 * chat-summary.test.mjs — 对话滚动摘要纯逻辑测试（E1）
 *
 * 覆盖：持久化行校验/损坏自愈、触发阈值、增量输入组装（逐条/总量截断、从新往回保）、
 * 输出归一。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummaryInput,
  CHAT_SUMMARY_SHAPE,
  normalizeSummaryOutput,
  parseChatSummary,
  shouldSummarize,
} from '../src/core/chat-summary.ts';

test('parseChatSummary：合法行通过、损坏/缺字段/null 一律按无摘要', () => {
  const ok = { shape: CHAT_SUMMARY_SHAPE, up_to_message_id: 7, summary: '此前讨论了 FTP 估算。' };
  assert.deepEqual(parseChatSummary(JSON.stringify(ok)), ok);
  assert.equal(parseChatSummary(null), null);
  assert.equal(parseChatSummary(''), null);
  assert.equal(parseChatSummary('not json'), null);
  assert.equal(parseChatSummary('{"shape":99,"up_to_message_id":7,"summary":"x"}'), null); // shape 不符
  assert.equal(parseChatSummary(JSON.stringify({ ...ok, up_to_message_id: 0 })), null); // 非法 id
  assert.equal(parseChatSummary(JSON.stringify({ ...ok, summary: '   ' })), null); // 空摘要
});

test('shouldSummarize 边界：恰好阈值 true、差 2 字 false', () => {
  const one = 'x'.repeat(2000);
  assert.equal(shouldSummarize([{ content: one }, { content: one }]), true); // 4000
  const short = 'x'.repeat(1999);
  assert.equal(shouldSummarize([{ content: short }, { content: short }]), false); // 3998
});

test('buildSummaryInput：只取 up_to 之后的增量', () => {
  const history = [
    { id: 1, role: 'user', content: '老1' },
    { id: 2, role: 'assistant', content: '老2' },
    { id: 3, role: 'user', content: '新1' },
    { id: 4, role: 'assistant', content: '新2' },
  ];
  assert.deepEqual(buildSummaryInput(history, 2).map((m) => m.id), [3, 4]);
  assert.deepEqual(buildSummaryInput(history, 99), []);
});

test('buildSummaryInput：逐条截 1500 字', () => {
  const big = 'y'.repeat(3000);
  const history = [
    { id: 1, role: 'user', content: big },
    { id: 2, role: 'assistant', content: big },
    { id: 3, role: 'user', content: big },
  ];
  const kept = buildSummaryInput(history, 0);
  assert.deepEqual(kept.map((m) => m.id), [1, 2, 3]); // 3×1501 ≤ 16000 全保
  for (const m of kept) assert.ok(m.content.length <= 1501); // 1500 + 省略号
});

test('buildSummaryInput 总量截断：超过输入上限时保最新', () => {
  const big = 'z'.repeat(3000); // 截到 1501/条
  const history = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    role: i % 2 ? 'assistant' : 'user',
    content: big,
  }));
  const kept = buildSummaryInput(history, 0); // 11 条 = 16511 > 16000 → 只保最新 10 条
  assert.deepEqual(kept.map((m) => m.id), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('normalizeSummaryOutput：截到输出上限、空白剥离、空正文为 null', () => {
  assert.equal(normalizeSummaryOutput('  内容  '), '内容');
  assert.equal(normalizeSummaryOutput(''), null);
  assert.equal(normalizeSummaryOutput(null), null);
  const long = 'n'.repeat(1500);
  const out = normalizeSummaryOutput(long);
  assert.equal(out.length, 1201); // 1200 + 省略号
  assert.ok(out.endsWith('…'));
});

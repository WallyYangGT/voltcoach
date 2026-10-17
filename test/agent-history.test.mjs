/**
 * agent-history.test.mjs — agent 循环请求体历史压缩测试（E1）
 *
 * 覆盖：快路径原样、tool 结果组整组压缩、tool_call_id 配对保持、首条与末尾保留、
 * 逐组从旧到新、普通消息兜底压缩。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAgentHistory } from '../src/ai/agent-history.ts';

const NOTE = '（结果已压缩）';

test('未超预算：原样返回（同一引用，零拷贝）', () => {
  const messages = [
    { role: 'user', content: '主提示词' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果' },
  ];
  assert.equal(compactAgentHistory(messages, { maxChars: 32000, note: NOTE }), messages);
});

function bigHistory() {
  // 主提示词 + 4 组工具调用（每组结果 8k 字符）+ 收尾
  const msgs = [{ role: 'user', content: 'P'.repeat(4000) }];
  for (let i = 0; i < 4; i++) {
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'get_activity_records', arguments: `{"file_name":"a${i}.fit"}` } }],
    });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'R'.repeat(8000) });
  }
  msgs.push({ role: 'user', content: 'U'.repeat(500) });
  return msgs;
}

test('超预算：最旧的 tool 结果先被压缩为占位 JSON', () => {
  const msgs = bigHistory(); // 总计约 4k + 4×8k + 0.5k = 36.5k
  const out = compactAgentHistory(msgs, { maxChars: 32000, note: NOTE });
  assert.ok(out !== msgs);
  const total = out.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  assert.ok(total <= 32000, `total=${total}`);
  // 最旧的组（c0）被压缩
  const c0 = out.find((m) => m.role === 'tool' && m.tool_call_id === 'c0');
  const parsedC0 = JSON.parse(c0.content);
  assert.equal(parsedC0._compacted, true);
  assert.equal(parsedC0._original_chars, 8000);
  assert.ok(parsedC0._preview.startsWith('R'));
  assert.ok(c0.content.length < 8000);
  // 最新的组（c3）原样保留
  const c3 = out.find((m) => m.role === 'tool' && m.tool_call_id === 'c3');
  assert.equal(c3.content, 'R'.repeat(8000));
  // 首条主提示词原样
  assert.equal(out[0].content, 'P'.repeat(4000));
});

test('tool_call_id 配对保持：assistant.tool_calls 结构不被删除', () => {
  const msgs = bigHistory();
  const out = compactAgentHistory(msgs, { maxChars: 32000, note: NOTE });
  for (let i = 0; i < 4; i++) {
    const assistant = out.find((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === `c${i}`);
    assert.ok(assistant, `assistant c${i} 存在`);
    assert.ok(out.some((m) => m.role === 'tool' && m.tool_call_id === `c${i}`));
  }
});

test('工具组压完后仍超：keepRecent 现场不动，尽力压缩返回', () => {
  const msgs = bigHistory();
  // keepRecent=3（a3/t3/user，约 8.5k 原文）+ 首条 4k 是压缩不可达的下限
  const out = compactAgentHistory(msgs, { maxChars: 14000, note: NOTE });
  const total = out.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  assert.ok(total <= 14000, `total=${total}`);
  assert.equal(out[0].content, 'P'.repeat(4000)); // 首条主提示词原样
  assert.equal(out[out.length - 1].content, 'U'.repeat(500)); // 末尾 user 原样
  // 最旧的三个工具组全部压缩为占位
  for (const i of [0, 1, 2]) {
    const tool = out.find((m) => m.role === 'tool' && m.tool_call_id === `c${i}`);
    assert.equal(JSON.parse(tool.content)._compacted, true);
  }
  // 最新组原样
  const c3 = out.find((m) => m.role === 'tool' && m.tool_call_id === 'c3');
  assert.equal(c3.content, 'R'.repeat(8000));
});

test('首条系统段不计入 32k 历史预算：英文 49k 系统段 + 12k 窗口历史不被压缩（P1-1）', () => {
  const messages = [{ role: 'user', content: 'S'.repeat(49000) }];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'user', content: 'Q'.repeat(1000) });
    messages.push({ role: 'assistant', content: 'A'.repeat(1000) });
  }
  // 首条不计入：12k < 32000 → 原样返回（同引用）
  assert.equal(compactAgentHistory(messages, { maxChars: 32000, note: NOTE }), messages);
});

test('tool_calls arguments 计入预算：旧组的 arguments 被清空、id/name 保持', () => {
  const messages = [
    { role: 'user', content: 'P' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_training_plan', arguments: 'x'.repeat(40000) } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
  ];
  const out = compactAgentHistory(messages, { maxChars: 32000, note: NOTE });
  const asst = out.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  assert.equal(asst.tool_calls[0].function.arguments, '{}');
  assert.equal(asst.tool_calls[0].id, 'c1');
  assert.equal(asst.tool_calls[0].function.name, 'update_training_plan');
  assert.ok(out.find((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
});

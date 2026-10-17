/**
 * context.test.mjs — 上下文预算装配器测试（E1）
 *
 * 覆盖：快路径零损耗、optional 段优先级丢弃次序、degrade 截断边界与断点选择、
 * 数据段不可截断宁超不破、全组合超预算的兜底行为。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleBudgetedSections, truncateTextBlock } from '../src/prompts/context.ts';

const NOTE = '（已省略）';

test('快路径：总量不超预算时零损耗拼接', () => {
  const r = assembleBudgetedSections(
    [
      { id: 'a', text: 'AAA', priority: 1 },
      { id: 'b', text: 'BBB', priority: 2 },
    ],
    100,
    NOTE,
  );
  assert.equal(r.text, 'AAA\n\nBBB');
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.trimmed, []);
  assert.equal(r.chars, 8);
});

test('输出保持传入顺序（priority 只决定丢弃/降级次序）', () => {
  const r = assembleBudgetedSections(
    [
      { id: 'late', text: 'LOW', priority: 9 },
      { id: 'early', text: 'HIGH', priority: 0 },
    ],
    100,
    NOTE,
  );
  assert.equal(r.text, 'LOW\n\nHIGH');
});

test('超预算：先丢 priority 最大且 optional 的段', () => {
  const r = assembleBudgetedSections(
    [
      { id: 'core', text: 'C'.repeat(50), priority: 0 },
      { id: 'skills', text: 'S'.repeat(40), priority: 1 },
      { id: 'dossier', text: 'D'.repeat(30), priority: 5, optional: true },
      { id: 'memory', text: 'M'.repeat(20), priority: 6, optional: true },
    ],
    130, // 全量 146 字；丢 memory（20 字 + 1 个分隔符）后 124 ≤ 130，只丢一个
    NOTE,
  );
  assert.deepEqual(r.dropped, ['memory']);
  assert.deepEqual(r.trimmed, []);
  assert.ok(r.text.includes('D'.repeat(30)));
  assert.ok(!r.text.includes('M'));
});

test('丢弃次序：priority 大者先丢、丢到够用即停', () => {
  const r = assembleBudgetedSections(
    [
      { id: 'core', text: 'C'.repeat(50), priority: 0 },
      { id: 'skills', text: 'S'.repeat(40), priority: 1 },
      { id: 'dossier', text: 'D'.repeat(30), priority: 5, optional: true },
      { id: 'memory', text: 'M'.repeat(20), priority: 6, optional: true },
    ],
    100,
    NOTE,
  );
  assert.deepEqual(r.dropped, ['memory', 'dossier']); // 6 先于 5 丢
  assert.deepEqual(r.trimmed, []);
  assert.ok(r.text.includes('S'.repeat(40))); // 非.optional 的 skills 不受影响
});

test('丢弃不够时逐个继续丢；仍不够才降级', () => {
  const sections = [
    { id: 'core', text: 'C'.repeat(60), priority: 0 },
    { id: 'data', text: '{"k":"' + 'x'.repeat(40) + '"}', priority: 1 }, // 无 degrade/optional
    { id: 'dossier', text: 'D'.repeat(30), priority: 5, optional: true },
    { id: 'memory', text: 'M'.repeat(30), priority: 6, optional: true },
    { id: 'skills', text: 'S'.repeat(60), priority: 2, degrade: (n) => 'S'.repeat(Math.min(60, Math.max(0, n - 20))) },
  ];
  // 预算掐在丢光 optional + 截 skills 之后刚好满足
  const r = assembleBudgetedSections(sections, 150, NOTE);
  assert.deepEqual(r.dropped, ['memory', 'dossier']);
  assert.deepEqual(r.trimmed, ['skills']);
  assert.ok(r.chars <= 150 + 8, `chars=${r.chars}`); // 段间分隔符余量
  assert.ok(r.text.includes('{"k"')); // 数据段原样保留
});

test('数据段不可截断：无可丢无降级时宁超预算不破 JSON', () => {
  const big = JSON.stringify({ activity: { date: '2026-03-25' }, blob: 'x'.repeat(300) });
  const r = assembleBudgetedSections([{ id: 'data', text: big, priority: 0 }], 100, NOTE);
  assert.equal(JSON.parse(r.text).blob, 'x'.repeat(300)); // 结构完好
  assert.ok(r.chars > 100); // 接受超预算
});

test('truncateTextBlock：优先段落边界断开并附省略说明', () => {
  const text = '第一段。\n\n' + '第二段内容。'.repeat(50) + '\n\n第三段。';
  const out = truncateTextBlock(text, 60, NOTE);
  assert.ok(out.endsWith(NOTE));
  assert.ok(out.length <= 61);
  assert.ok(out.includes('第一段。'));
  assert.ok(!out.includes('第三段'));
});

test('truncateTextBlock：无段落边界时退化为行边界/硬切', () => {
  const text = '行一\n' + 'x'.repeat(200);
  const out = truncateTextBlock(text, 50, NOTE);
  assert.ok(out.endsWith(NOTE));
  assert.ok(out.length <= 51);
  const noBreak = 'y'.repeat(200);
  const hard = truncateTextBlock(noBreak, 50, NOTE);
  assert.ok(hard.endsWith(NOTE));
  assert.ok(hard.length <= 51);
});

test('truncateTextBlock：预算内原样、预算为零/负返回说明本身', () => {
  assert.equal(truncateTextBlock('short', 100, NOTE), 'short');
  assert.equal(truncateTextBlock('content', 0, NOTE), NOTE);
  assert.equal(truncateTextBlock('content', -5, NOTE), NOTE);
});

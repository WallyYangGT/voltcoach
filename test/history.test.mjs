/**
 * history.test.mjs — 对话历史窗口化测试（E1）
 *
 * 覆盖：轮切分、轮数/字符双上限、最新一轮强制保留、digest 概括与截断、空历史。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { windowChatHistory } from '../src/prompts/history.ts';

const msg = (role, content) => ({ role, content });
const turn = (u, a) => [msg('user', u), msg('assistant', a)];

test('不超预算：全部保留、无 digest', () => {
  const messages = [...turn('问题1', '答1'), ...turn('问题2', '答2')];
  const r = windowChatHistory(messages, { recentTurns: 6, recentChars: 12000 });
  assert.deepEqual(r.recent, messages);
  assert.deepEqual(r.omitted, []);
  assert.equal(r.digest, null);
});

test('轮数上限：只保留最近 N 轮', () => {
  const messages = [...turn('问1', '答1'), ...turn('问2', '答2'), ...turn('问3', '答3')];
  const r = windowChatHistory(messages, { recentTurns: 2, recentChars: 12000 });
  assert.deepEqual(r.recent, [...turn('问2', '答2'), ...turn('问3', '答3')]);
  assert.deepEqual(r.omitted, [...turn('问1', '答1')]);
  assert.match(r.digest, /用户: 问1/);
  assert.match(r.digest, /教练: 答1/);
});

test('字符上限：从最旧轮起丢；最新一轮超预算也强制保留', () => {
  const a = 'a'.repeat(400);
  const b = 'b'.repeat(400);
  const c = 'c'.repeat(400);
  const messages = [...turn('问1', a), ...turn('问2', b), ...turn('问3', c)];
  // 保留两轮（~808 字）后，第三轮加入会到 ~1211 > 1000 → 最旧轮被丢
  const r = windowChatHistory(messages, { recentTurns: 6, recentChars: 1000 });
  assert.deepEqual(r.recent, [...turn('问2', b), ...turn('问3', c)]);
  assert.deepEqual(r.omitted, [...turn('问1', a)]);
  assert.match(r.digest, /用户: 问1/);

  // 最新一轮自己超预算：强制保留（丢掉当前问题就答非所问了），旧轮被挤出
  const huge = 'h'.repeat(5000);
  const messages2 = [...turn('旧问', '旧答'), ...turn('最新问', huge)];
  const r2 = windowChatHistory(messages2, { recentTurns: 6, recentChars: 1000 });
  assert.deepEqual(r2.recent, [...turn('最新问', huge)]);
  assert.deepEqual(r2.omitted, [...turn('旧问', '旧答')]);
});

test('首条即超预算：至少保留最后一轮', () => {
  const huge = 'y'.repeat(20000);
  const messages = [...turn('巨大问', huge)];
  const r = windowChatHistory(messages, { recentTurns: 6, recentChars: 1000 });
  assert.deepEqual(r.recent, messages);
  assert.deepEqual(r.omitted, []);
  assert.equal(r.digest, null);
});

test('digest：逐条概括、单条截断、整体截断', () => {
  const messages = [
    ...turn('第一问', '超长回答'.repeat(300)), // 1800 字，被挤出的旧轮
    ...turn('第二问', '第二答'),
  ];
  const r = windowChatHistory(messages, { recentTurns: 1, recentChars: 12000, digestPerMessageChars: 100, digestMaxChars: 300 });
  assert.equal(r.recent.length, 2);
  assert.ok(r.digest.startsWith('- 用户: 第一问'));
  assert.ok(r.digest.includes('…')); // 超长回答被单条截断
  assert.ok(r.digest.length <= 301);

  // 整体截断：digestMaxChars 收紧后仍保留首行锚点
  const r2 = windowChatHistory(messages, { recentTurns: 1, recentChars: 12000, digestPerMessageChars: 100, digestMaxChars: 50 });
  assert.ok(r2.digest.startsWith('- 用户: 第一问'));
  assert.ok(r2.digest.length <= 51);
});

test('异常序列：assistant 收尾前又来 user 不另起轮', () => {
  const messages = [msg('user', '一'), msg('user', '补充'), msg('assistant', '答')];
  const r = windowChatHistory(messages, { recentTurns: 1, recentChars: 12000 });
  assert.deepEqual(r.recent, messages);
  assert.equal(r.omitted.length, 0);
});

test('空历史：全部为空', () => {
  const r = windowChatHistory([], { recentTurns: 6, recentChars: 12000 });
  assert.deepEqual(r.recent, []);
  assert.deepEqual(r.omitted, []);
  assert.equal(r.digest, null);
});

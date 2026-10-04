/**
 * ai-presets.test.mjs — AI 服务商预设数据校验（M5 后打磨）。
 *
 * src/ai/providers.json 是服务商预设的唯一维护点（设置页下拉的接口地址/模型列表
 * 来源）。node:test 不直接 import 该 JSON（Node ESM 对无 attributes 的 JSON import
 * 报错；Metro 无此要求），故用 fs 读取后校验形状——保证坏数据在上线路径前被拦下：
 * baseUrl 口径尤其关键（http.ts 按 `${baseUrl}/chat/completions` 拼端点，带末尾斜杠
 * 会出双斜杠）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const presets = JSON.parse(readFileSync(join(root, 'src', 'ai', 'providers.json'), 'utf8'));

test('服务商预设：数组非空且 id 唯一', () => {
  assert.ok(Array.isArray(presets) && presets.length > 0, 'providers.json 应为非空数组');
  const ids = presets.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `id 重复: ${ids.join(', ')}`);
});

test('服务商预设：baseUrl 口径（https、无末尾斜杠、无空白、可拼 /chat/completions）', () => {
  for (const p of presets) {
    assert.equal(typeof p.baseUrl, 'string', `${p.id} baseUrl 缺失`);
    assert.match(p.baseUrl, /^https:\/\/\S+$/, `${p.id} baseUrl 必须 https 且不含空白`);
    assert.doesNotMatch(p.baseUrl, /\/$/, `${p.id} baseUrl 不能以斜杠结尾（http.ts 拼端点口径）`);
    const u = new URL(`${p.baseUrl}/chat/completions`);
    assert.equal(u.protocol, 'https:', `${p.id} 拼出的端点应为 https`);
    assert.ok(!u.pathname.includes('//'), `${p.id} 拼出的端点路径含双斜杠: ${u.pathname}`);
  }
  const urls = presets.map((p) => p.baseUrl);
  assert.equal(new Set(urls).size, urls.length, `baseUrl 重复: ${urls.join(', ')}`);
});

test('服务商预设：label 与模型列表形状', () => {
  for (const p of presets) {
    assert.equal(typeof p.label, 'string');
    assert.ok(p.label.trim().length > 0, `${p.id} label 为空`);
    assert.ok(Array.isArray(p.models) && p.models.length > 0, `${p.id} models 应为非空数组`);
    for (const m of p.models) {
      assert.equal(typeof m, 'string');
      assert.match(m, /^\S+$/, `${p.id} 模型名含空白: ${m}`);
    }
    assert.equal(new Set(p.models).size, p.models.length, `${p.id} models 重复`);
  }
});

test('服务商预设：至少包含 deepseek / kimi / glm / openai 四家', () => {
  const ids = new Set(presets.map((p) => p.id));
  for (const required of ['deepseek', 'kimi', 'glm', 'openai']) {
    assert.ok(ids.has(required), `缺少必备服务商: ${required}`);
  }
});

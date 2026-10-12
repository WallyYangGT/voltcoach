/**
 * skills.test.mjs — src/prompts/skills.ts 内嵌知识库回归测试。
 * 自 fit-reader Web 版 test/skills.test.mjs 搬运断言（目录扫描改为 files 参数注入；
 * 内嵌默认目录的冒烟校验保留）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { SKILL_FILES, buildSkillsSection } = await import('../src/prompts/skills.ts');

test('按文件名排序加载，标题取首个一级标题（files 注入）', () => {
  const files = [
    { name: '02-beta.md', content: '# Beta 技能\n\n正文 B' },
    { name: '01-alpha.md', content: '# Alpha 技能\n\n正文 A' },
  ];
  const section = buildSkillsSection('zh', files);
  assert.match(section, /### Alpha 技能\n\n正文 A/);
  assert.match(section, /### Beta 技能\n\n正文 B/);
  assert.ok(section.indexOf('Alpha 技能') < section.indexOf('Beta 技能'));
});

test('空文件跳过；无标题时用文件名兜底（去掉 .md 后缀）', () => {
  const files = [
    { name: 'empty.md', content: '   \n' },
    { name: '03-no-title.md', content: '没有标题行的正文' },
  ];
  const section = buildSkillsSection('zh', files);
  assert.match(section, /### 03-no-title\n/);
  assert.ok(section.includes('没有标题行的正文'));
});

// `_` 前缀过滤发生在内嵌生成时（scripts/embed-skills.mjs 排除 _* 文件），
// 旧版在 loadSkills 目录扫描时过滤——两者口径等价：内嵌清单里不允许出现 _ 前缀文件
test('内嵌清单不含 _ 前缀文件（旧 loadSkills 的 _ 过滤口径移到生成期）', () => {
  for (const f of [...SKILL_FILES.zh, ...SKILL_FILES.en]) {
    assert.ok(!f.name.startsWith('_'), f.name);
  }
});

test('无有效技能时返回 null', () => {
  assert.equal(buildSkillsSection('zh', []), null);
  assert.equal(buildSkillsSection('zh', [{ name: 'empty.md', content: '  ' }]), null);
});

test('buildSkillsSection 拼装专业知识库段（标题降为三级）', () => {
  const files = [
    { name: '01-a.md', content: '# 技能甲\n\n内容甲' },
    { name: '02-b.md', content: '# 技能乙\n\n内容乙' },
  ];
  const section = buildSkillsSection('zh', files);
  assert.match(section, /^## 专业知识库/);
  assert.match(section, /### 技能甲\n\n内容甲/);
  assert.match(section, /### 技能乙\n\n内容乙/);
});

test('内嵌 skills/ 目录默认加载六个技能且跳过 _README（zh）', () => {
  const titles = buildSkillsSection('zh');
  assert.match(titles, /Coggan 功率训练体系/);
  assert.match(titles, /TrainingPeaks 负荷模型（CTL \/ ATL \/ TSB）/);
  assert.match(titles, /心率区间与心率解读体系/);
  assert.match(titles, /训练报告撰写规范/);
  assert.match(titles, /周计划节奏（按星期几安排训练）/);
  assert.match(titles, /功率数据质量与校准/);
  assert.doesNotMatch(titles, /_README/);
  assert.equal(SKILL_FILES.zh.length, 6);
});

test('内嵌英文技能：.en.md 归英文，zh 不混入英文技能', () => {
  const en = buildSkillsSection('en');
  assert.match(en, /^## Knowledge Base/);
  assert.match(en, /Coggan Power Training System/);
  assert.match(en, /Weekly Planning Rhythm \(Scheduling by Day of Week\)/);
  assert.match(en, /Power Data Quality and Calibration/);
  assert.equal(SKILL_FILES.en.length, 6);
  for (const f of SKILL_FILES.zh) assert.ok(!f.name.endsWith('.en.md'));
  for (const f of SKILL_FILES.en) assert.ok(f.name.endsWith('.en.md'));
});

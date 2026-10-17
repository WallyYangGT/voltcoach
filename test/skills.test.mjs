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

test('内嵌 skills/ 目录默认加载十个技能且跳过 _README（zh）', () => {
  const titles = buildSkillsSection('zh');
  assert.match(titles, /Coggan 功率训练体系/);
  assert.match(titles, /TrainingPeaks 负荷模型（CTL \/ ATL \/ TSB）/);
  assert.match(titles, /心率区间与心率解读体系/);
  assert.match(titles, /训练报告撰写规范/);
  assert.match(titles, /周计划节奏（按星期几安排训练）/);
  assert.match(titles, /功率数据质量与校准/);
  assert.match(titles, /周期化训练计划：输出约定与执行对比/);
  assert.match(titles, /### 骑手水平分级与教练校准/);
  assert.match(titles, /### 户外骑行安全与路线选择/);
  assert.match(titles, /### 业余教练模式（时间预算与健康导向）/);
  assert.doesNotMatch(titles, /_README/);
  assert.equal(SKILL_FILES.zh.length, 10);
});

test('业余教练技能：关键口径钉死 + zh/en 成对', () => {
  const zh = SKILL_FILES.zh.find((f) => f.name === '10-amateur-coach.md');
  const en = SKILL_FILES.en.find((f) => f.name === '10-amateur-coach.en.md');
  assert.ok(zh, '缺少 10-amateur-coach.md');
  assert.ok(en, '缺少 10-amateur-coach.en.md');
  // P2 起模式与时间预算写入结构化档案（工具真实存在）
  assert.ok(zh.content.includes('update_rider_profile'));
  assert.ok(en.content.includes('update_rider_profile'));
  // 关键行为：两维取交集、健康锚点、目标阶梯分窗、首次询问不阻塞、
  // 活动日长骑是上限、记忆兜底、入门不做全力测试、质量课 ≤2
  for (const phrase of [
    '两维取交集',
    '150–300 分钟',
    '12 周分两个 6 周计划窗落地',
    '不要停下来等回答',
    '60–75% 是上限而非目标',
    'update_rider_profile',
    '不引导新手做 20 分钟全力测试',
    '周质量课建议 ≤2',
  ]) {
    assert.ok(zh.content.includes(phrase), `中文技能缺少「${phrase}」`);
  }
  for (const phrase of [
    'the two dimensions **intersect**',
    '150–300 minutes',
    'Deliver the 12 weeks as two 6-week plan windows',
    'Do not stop and wait',
    'is a ceiling, not a target',
    'update_rider_profile',
    'Never push beginners into a 20-minute all-out test',
    'about 2 or fewer',
  ]) {
    assert.ok(en.content.includes(phrase), `英文技能缺少「${phrase}」`);
  }
  // zh/en 成对：每个 NN- 前缀的中文技能都有同名 .en.md（数量与配对同时校验）
  const zhNums = SKILL_FILES.zh.map((f) => /^(\d\d)-/.exec(f.name)?.[1]).filter(Boolean).sort();
  const enNums = SKILL_FILES.en.map((f) => /^(\d\d)-/.exec(f.name)?.[1]).filter(Boolean).sort();
  assert.deepEqual(enNums, zhNums);
  assert.equal(zhNums.length, SKILL_FILES.zh.length);
  assert.equal(enNums.length, SKILL_FILES.en.length);
});

test('内嵌英文技能：.en.md 归英文，zh 不混入英文技能', () => {
  const en = buildSkillsSection('en');
  assert.match(en, /^## Knowledge Base/);
  assert.match(en, /Coggan Power Training System/);
  assert.match(en, /Weekly Planning Rhythm \(Scheduling by Day of Week\)/);
  assert.match(en, /Power Data Quality and Calibration/);
  assert.match(en, /Periodized Training Plans: Output Contract and Execution Review/);
  assert.match(en, /### Rider Level Calibration/);
  assert.match(en, /### Outdoor Ride Safety and Route Selection/);
  assert.match(en, /### Amateur Coaching Mode \(Time Budget and Health-First\)/);
  assert.equal(SKILL_FILES.en.length, 10);
  for (const f of SKILL_FILES.zh) assert.ok(!f.name.endsWith('.en.md'));
  for (const f of SKILL_FILES.en) assert.ok(f.name.endsWith('.en.md'));
});

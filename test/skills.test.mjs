/**
 * skills.test.mjs — src/prompts/skills.ts 内嵌知识库回归测试。
 * 自 fit-reader Web 版 test/skills.test.mjs 搬运断言（目录扫描改为 files 参数注入；
 * 内嵌默认目录的冒烟校验保留）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const { SKILL_FILES, buildSkillsSection, truncateSkillsSection } = await import('../src/prompts/skills.ts');
const { CONTEXT_BUDGET } = await import('../src/core/settings.ts');

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

test('E1 预算：超 maxChars 时整文件装入、装不下的尾部整篇省略并列名', () => {
  const files = [
    { name: '01-a.md', content: '# 技能甲\n\n' + '甲'.repeat(300) },
    { name: '02-b.md', content: '# 技能乙\n\n' + '乙'.repeat(300) },
    { name: '03-c.md', content: '# 技能丙\n\n' + '丙'.repeat(300) },
  ];
  // 预算只够前两篇（每篇约 320 字 + 段头开销）
  const section = buildSkillsSection('zh', files, 1000);
  assert.match(section, /### 技能甲/);
  assert.match(section, /### 技能乙/);
  assert.doesNotMatch(section, /### 技能丙\n/); // 整篇不注入（标题不出现在正文）
  assert.match(section, /以下技能因上下文预算未注入：.*技能丙/); // 省略说明列名
  // 半篇技能不允许出现（内容要么全在、要么全不在）
  assert.doesNotMatch(section, /丙丙丙/);
});

test('truncateSkillsSection：对已拼好的段按整技能边界截断，不出半篇', () => {
  const files = [
    { name: '01-a.md', content: '# 技能甲\n\n' + '甲'.repeat(300) },
    { name: '02-b.md', content: '# 技能乙\n\n' + '乙'.repeat(300) },
    { name: '03-c.md', content: '# 技能丙\n\n' + '丙'.repeat(300) },
  ];
  const section = buildSkillsSection('zh', files);
  const out = truncateSkillsSection(section, 900, 'zh');
  assert.ok(out.length <= 900, `len=${out.length}`); // 含省略说明严格不超预算
  assert.match(out, /### 技能甲/);
  assert.doesNotMatch(out, /### 技能丙\n/);
  assert.match(out, /以下技能因上下文预算未注入：.*技能丙/);
  assert.doesNotMatch(out, /丙丙丙/); // 整篇省略，不切半篇
  // 小预算：一篇都放不下时返回最小省略说明（截到预算），绝不出现半篇技能
  for (const n of [300, 120, 50]) {
    const tiny = truncateSkillsSection(section, n, 'zh');
    assert.ok(tiny.length <= n, `n=${n} len=${tiny.length}`);
    assert.doesNotMatch(tiny, /甲甲甲|乙乙乙|丙丙丙/);
  }
  // 预算充足时原样返回
  assert.equal(truncateSkillsSection(section, section.length + 10, 'zh'), section);
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
  // P1 遗留的「更新记忆」口径必须清除（否则模型只写记忆、不落结构化档案）
  assert.ok(!zh.content.includes('更新记忆'));
  assert.ok(!en.content.includes('update the memory'));
  // 可用日空 = 不限（与 UI/工具口径一致）
  assert.ok(zh.content.includes('可用日未设置（available_days 为空）= 不限'));
  assert.ok(en.content.includes('unset available days (empty available_days) means unrestricted'));
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

// ---- 内嵌产物守卫（2026-10-18 skills 评审批）----

// 改 skills/*.md 后忘跑 `node scripts/embed-skills.mjs` 时，内嵌 SKILL_FILES 会静默漂移
// （本文件其余断言读的都是内嵌产物，测不出源文件改动）。md 已入库，本测试在 CI 同样生效。
test('内嵌产物与 skills/ 源目录逐篇一致（防改 md 后忘记重跑 embed-skills）', () => {
  const dir = new URL('../src/prompts/skills/', import.meta.url);
  for (const lang of ['zh', 'en']) {
    const onDisk = readdirSync(dir)
      .filter(
        (name) =>
          name.endsWith('.md') &&
          !name.startsWith('_') &&
          (lang === 'en' ? name.endsWith('.en.md') : !name.endsWith('.en.md')),
      )
      .sort()
      // 归一化口径同 embed-skills.mjs：CRLF→LF + 首尾 trim
      .map((name) => ({
        name,
        content: readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n').trim(),
      }));
    assert.equal(
      SKILL_FILES[lang].length,
      onDisk.length,
      `${lang} 内嵌篇数（${SKILL_FILES[lang].length}）与磁盘（${onDisk.length}）不一致——新增/删除技能后需重跑 node scripts/embed-skills.mjs`,
    );
    for (let i = 0; i < onDisk.length; i++) {
      assert.equal(SKILL_FILES[lang][i].name, onDisk[i].name, `${lang} 第 ${i} 篇文件名错位`);
      assert.equal(
        SKILL_FILES[lang][i].content,
        onDisk[i].content,
        `技能 ${onDisk[i].name} 内容与内嵌产物不一致——改了 md 后需重跑 node scripts/embed-skills.mjs`,
      );
    }
  }
});

// en 全文 ~40k 字符曾达旧预算 44k 的 ~90%：再增技能就会在运行时开始整篇静默省略尾部
// 技能（最先牺牲排最尾、体积最大的 10-amateur-coach）。本测试把增长闸门前移到 CI：
// 渲染段超预算 85% 即红灯，提示先评审 skills_max_chars 而不是默默降级。
test('E1 预算闸门：两语言技能全文渲染段 ≤ skills_max_chars 的 85%', () => {
  for (const lang of ['zh', 'en']) {
    const section = buildSkillsSection(lang);
    assert.ok(section, `${lang} 技能段为空`);
    const share = section.length / CONTEXT_BUDGET.skills_max_chars;
    assert.ok(
      share <= 0.85,
      `${lang} 技能段 ${section.length} 字符已达 skills_max_chars=${CONTEXT_BUDGET.skills_max_chars} 的 ${(share * 100).toFixed(1)}%（阈值 85%）——新增技能前先评审预算，否则运行时会开始整篇静默省略尾部技能`,
    );
  }
});

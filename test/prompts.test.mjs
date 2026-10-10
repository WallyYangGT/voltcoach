/**
 * prompts.test.mjs — src/prompts 提示词层回归测试。
 * 自 fit-reader Web 版 test/（web.test.mjs 提示词相关断言 + skills/ai 测试中的拼装口径）
 * 同源搬运：四场景拼装结构、数据整形压缩、时间戳本地化、记忆段、对话系统段。
 * zh 文案 2026-09-25 客观性修正起与旧 repo 逐字同步（回归断言依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildReviewPrompt,
  buildPlanPrompt,
  buildTaperPrompt,
  buildComparePrompt,
  buildAgenticSection,
  buildMemorySection,
  buildProfileSection,
  buildDateSection,
  buildChatInstruction,
  compactSummaryForPrompt,
  localizeTimestamps,
  thinToWeekly,
} = await import('../src/prompts/prompts.ts');
const { buildChatSystemSection } = await import('../src/prompts/chat.ts');
const { ATHLETE } = await import('../src/core/settings.ts');

/** 最小可用的单次骑行 summary（测试素材） */
function sampleSummary(overrides = {}) {
  return {
    activity: { date: '2026-03-25', sport: 'cycling', duration_sec: 3600, category: 'training' },
    power: { np: 180, avg: 160, intensity_factor: 0.85, tss: 60 },
    heart_rate: { drift_pct: 3.2 },
    athlete_context: { ctl: 50, atl: 45, tsb: 5 },
    anomalies: [],
    ...overrides,
  };
}

test('复盘提示词：角色 + 口径 + 当前时间 + 数据段 + 编号问题', () => {
  const now = new Date('2026-03-26T10:00:00');
  const p = buildReviewPrompt(sampleSummary(), ATHLETE, null, null, 'zh', now);
  assert.match(p, /^## 角色\n\n你是一位严谨、务实的自行车教练/);
  // 客观性修正（2026-09-25）：评价平衡口径与数据口径注意钉死
  assert.match(p, /评价客观平衡——做得好的地方（有数据支撑）明确肯定，存在的问题也直接指出，不回避不美化/);
  assert.match(p, /## 指标口径与骑手参数/);
  assert.match(p, new RegExp(`骑手参数：FTP ${ATHLETE.ftp_watts}W，最大心率 ${ATHLETE.max_hr}bpm，体重 ${ATHLETE.weight_kg}kg`));
  assert.match(p, /数据口径注意：/);
  assert.match(p, /0W（滑行、下坡、停车但计时未停）也计入 Z1，Z1 占比高不等于没有踩踏输出/);
  assert.match(p, /timer_pause 条目的 at 为暂停起始时刻/);
  assert.match(p, /## 当前时间/);
  assert.match(p, /今天是 2026-03-26/);
  assert.match(p, /## 训练数据（单次骑行汇总）/);
  assert.match(p, /用户已将本次记录分类为：\*\*训练\*\*/);
  assert.match(p, /```json/);
  assert.match(p, /## 请回答\n\n1\. 参考用户标记的分类/);
  // 强度分布题：基线结合分类与场景（通勤/热身 Z1–Z2 为主属正常）
  assert.match(p, /基线结合用户标记的分类与场景判断（如通勤\/热身\/恢复骑以 Z1–Z2 为主属正常）/);
  // anomalies 题：先按 at 时间戳定位暂停环节，不凭推测安放到发力段
  assert.match(p, /先按 timer_pause 的 at 时间戳对照时间线定位暂停发生的环节/);
  assert.match(p, /不要凭推测把暂停安放到某个发力段/);
  // 无 skills 段（传 null 不注入）
  assert.doesNotMatch(p, /专业知识库/);
});

test('复盘提示词：比赛分类高亮 + 备注触发印证问句', () => {
  const s = sampleSummary();
  s.activity.category = 'race';
  s.activity.note = '体感偏累，逆风';
  const p = buildReviewPrompt(s, ATHLETE, null, null, 'zh', new Date());
  assert.match(p, /\*\*比赛\*\*/);
  assert.match(p, /用户还为本次训练填写了备注/);
  assert.match(p, /2\. 结合用户备注（activity\.note）解读本次训练/);
  // 备注原文透传（用户自填内容不翻译、不改写）
  assert.match(p, /体感偏累，逆风/);
});

test('复盘提示词：profile 段与 skills 段按需注入', () => {
  const profile = { identity: '上班族骑手', goal: '完成一场 200km 骑游' };
  const p = buildReviewPrompt(sampleSummary(), ATHLETE, profile, '## 专业知识库\n\n### 技能甲\n\n内容', 'zh', new Date());
  assert.match(p, /## 用户背景与训练目标/);
  assert.match(p, /身份：上班族骑手/);
  assert.match(p, /训练目标：完成一场 200km 骑游/);
  assert.match(p, /## 专业知识库/);
  // 全空 profile 不产生该段
  const p2 = buildReviewPrompt(sampleSummary(), ATHLETE, { identity: '', goal: '' }, null, 'zh', new Date());
  assert.doesNotMatch(p2, /用户背景与训练目标/);
  assert.equal(buildProfileSection(null), null);
});

test('周期规划/减量/对比提示词：数据段与固化问题齐全', () => {
  const formSeries = [{ date: '2026-03-25', tss: 0, ctl: 50, atl: 45, tsb: 5 }];
  const months = [{ month: '2026-03', tss: 900 }];
  const recent = [{ file_name: 'a.fit', date: '2026-03-25', tss: 60 }];
  const plan = buildPlanPrompt({ months, formSeries, recentActivities: recent }, ATHLETE, null, null, 'zh', new Date());
  assert.match(plan, /## 逐月训练汇总/);
  assert.match(plan, /## 近期 CTL\/ATL\/TSB 走势（逐周取样，每天 0 点值）/);
  assert.match(plan, /## 近期训练清单/);
  assert.match(plan, /5\. 中期（4-8 周）应侧重什么能力短板/);

  const taper = buildTaperPrompt(
    { raceDate: '2026-04-20', daysLeft: 25, form: { ctl: 50, atl: 45, tsb: 5 }, formSeries, recentActivities: recent },
    ATHLETE, null, null, 'zh', new Date(),
  );
  assert.match(taper, /## 比赛信息/);
  assert.match(taper, /比赛日期：2026-04-20（距今 25 天）/);
  assert.match(taper, /## 当前状态（今日 CTL\/ATL\/TSB）/);
  assert.match(taper, /5\. 指出当前数据中的风险点/);

  const b = sampleSummary();
  b.activity.date = '2026-03-01';
  const cmp = buildComparePrompt(sampleSummary(), b, ATHLETE, null, null, 'zh', new Date());
  assert.match(cmp, /## 训练 A（2026-03-25）/);
  assert.match(cmp, /## 训练 B（2026-03-01）/);
  assert.match(cmp, /6\. 基于对比结果，给出下一阶段的训练重点建议。/);
});

test('compactSummaryForPrompt：anomalies 聚合 / segments 首尾省略 / climbs 取最大', () => {
  const anomalies = Array.from({ length: 8 }, (_, i) => ({ type: 'power_gap', duration_sec: 10 + i, at: `2026-03-25T0${i}:00:00.000Z` }));
  const segments = Array.from({ length: 25 }, (_, i) => ({ name: `S${i + 1}` }));
  const climbs = Array.from({ length: 12 }, (_, i) => ({ name: `C${i + 1}`, elevation_gain_m: i * 10 }));
  const s = sampleSummary({ anomalies, segments, climbs });
  const original = JSON.parse(JSON.stringify(s));
  const out = compactSummaryForPrompt(s, 'zh');
  // 返回新对象，入参不被修改
  assert.deepEqual(s, original);
  // anomalies 聚合为 summary（8 条 power_gap，总 108s，单段最大 17s）
  assert.equal(out.anomalies, undefined);
  assert.equal(out.anomalies_summary.length, 1);
  assert.equal(out.anomalies_summary[0].count, 8);
  assert.equal(out.anomalies_summary[0].total_sec, 108);
  assert.equal(out.anomalies_summary[0].max_sec, 17);
  // segments 保留前 10 + 占位 + 后 5
  assert.equal(out.segments.length, 16);
  assert.equal(out.segments[10].name, '...（中间省略 10 段）');
  assert.equal(out.segments[0].name, 'S1');
  assert.equal(out.segments[15].name, 'S25');
  // climbs 只留爬升最大的 10 段
  assert.equal(out.climbs.length, 10);
  assert.equal(out.climbs[0].name, 'C12');
  // 少于阈值时原样保留
  const few = compactSummaryForPrompt(sampleSummary({ anomalies: [{ type: 'power_gap', duration_sec: 5, at: 'x' }] }), 'zh');
  assert.equal(few.anomalies.length, 1);
});

test('compactSummaryForPrompt：timer_pause 不参与聚合、逐条保留位置证据', () => {
  // 暂停的 at 是判断其落在哪个环节（热身/通勤/间歇之间）的唯一位置证据，
  // 聚合丢失会迫使 AI 凭叙述需要"安放"暂停——热身段暂停被归因为冲刺段没出力
  const anomalies = [
    { type: 'timer_pause', duration_sec: 45, at: '2026-03-25T05:40:00.000Z' },
    { type: 'timer_pause', duration_sec: 30, at: '2026-03-25T05:52:00.000Z' },
    { type: 'power_gap', duration_sec: 78, at: '2026-03-25T05:43:40.000Z' },
    { type: 'power_gap', duration_sec: 65, at: '2026-03-25T06:36:53.000Z' },
    { type: 'record_gap', duration_sec: 25, at: '2026-03-25T05:54:16.000Z' },
    { type: 'hr_jump', at: '2026-03-25T06:05:00.000Z' },
  ];
  const out = compactSummaryForPrompt(sampleSummary({ anomalies }), 'zh');
  assert.equal(out.anomalies.length, 2);
  assert.ok(out.anomalies.every((a) => a.type === 'timer_pause'));
  assert.equal(out.anomalies[0].duration_sec, 45);
  assert.equal(new Date(out.anomalies[0].at).getTime(), Date.parse('2026-03-25T05:40:00.000Z'));
  assert.equal(new Date(out.anomalies[1].at).getTime(), Date.parse('2026-03-25T05:52:00.000Z'));
  const byType = Object.fromEntries(out.anomalies_summary.map((g) => [g.type, g]));
  assert.equal(byType.power_gap.count, 2);
  assert.equal(byType.power_gap.total_sec, 143);
  assert.equal(byType.record_gap.count, 1);
  assert.equal(byType.hr_jump.count, 1);
  assert.equal(byType.hr_jump.total_sec, undefined); // 无 duration_sec 的异常不写 total_sec
  assert.equal(byType.timer_pause, undefined);
});

test('compactSummaryForPrompt：全部为 timer_pause 时逐条保留、不产生空聚合', () => {
  const anomalies = Array.from({ length: 7 }, (_, i) => ({
    type: 'timer_pause',
    duration_sec: 20 + i,
    at: `2026-03-25T0${i}:00:00.000Z`,
  }));
  const out = compactSummaryForPrompt(sampleSummary({ anomalies }), 'zh');
  assert.equal(out.anomalies.length, 7);
  assert.equal(out.anomalies_summary, undefined);
});

test('localizeTimestamps：UTC 时间戳改写为本地偏移（时刻不变），用户自填字段不改写', () => {
  const iso = '2026-03-25T11:51:24.000Z';
  const out = localizeTimestamps({ at: iso, note: '早上 11:51Z 出发', date: '2026-03-25' });
  // 时刻不变（偏移表示与 UTC 表示是同一瞬间）
  assert.equal(new Date(out.at).getTime(), Date.parse(iso));
  // 不再是 Z 后缀（已带本地偏移）
  assert.doesNotMatch(out.at, /Z$/);
  // 用户自填内容（note）不改写；纯日期字段不动
  assert.equal(out.note, '早上 11:51Z 出发');
  assert.equal(out.date, '2026-03-25');
  // 数组与嵌套对象递归
  const nested = localizeTimestamps({ list: [{ at: iso }] });
  assert.equal(new Date(nested.list[0].at).getTime(), Date.parse(iso));
});

test('thinToWeekly：每 7 天取样一个点且含最后一天', () => {
  const daily = Array.from({ length: 56 }, (_, i) => ({ date: `d${i}`, ctl: i }));
  const weekly = thinToWeekly(daily);
  assert.equal(weekly.length, 9); // 0,7,...,49 共 8 点 + 末点 d55
  assert.equal(weekly[0].date, 'd0');
  assert.equal(weekly[7].date, 'd49');
  assert.equal(weekly[8].date, 'd55');
  // 恰好整除时末点已是取样点，不重复
  assert.equal(thinToWeekly(daily.slice(0, 50)).length, 8);
});

test('记忆段：id DESC 反转为时间正序、#id 标注、空态句', () => {
  const mems = [
    { id: 5, content: '目标：环千岛湖', category: 'goal', created_at: '2026-03-02 10:00:00' },
    { id: 3, content: '左膝伤后恢复中', category: 'injury', created_at: '2026-03-01 09:00:00' },
  ];
  const s = buildMemorySection(mems, 'zh');
  assert.match(s, /^## 用户记忆/);
  const i5 = s.indexOf('#5');
  const i3 = s.indexOf('#3');
  assert.ok(i3 >= 0 && i5 > i3); // 时间正序：#3 在前
  assert.match(s, /\[2026-03-01\] \(#3, 伤病\)/);
  assert.match(s, /同主题更新时用 supersedes_id 取代旧记忆/);
  const empty = buildMemorySection([], 'zh');
  assert.match(empty, /（暂无记忆——这是你第一次积累对用户的了解/);
});

test('agentic 工具指引段：11 个工具与 6 条规则（含 FTP 更新/重新分析）', () => {
  const s = buildAgenticSection('zh');
  for (const name of ['list_activities', 'get_activity_summary', 'get_activity_records', 'get_form_series', 'get_monthly_summary', 'get_athlete_profile', 'estimate_ftp', 'simulate_form', 'generate_workout', 'update_ftp', 'reanalyze_activity']) {
    assert.ok(s.includes(`- ${name}：`), name);
  }
  assert.match(s, /1\. 只在上方预装数据不足以回答时才调用工具/);
  assert.match(s, /4\. 需要先调用工具时，中间轮只写简短过渡语/);
  // 新增规则：主动更新须在回答中指出旧值→新值；重新分析后说明指标变化
  assert.match(s, /5\. FTP 自动更新/);
  assert.match(s, /「FTP 已由 X 更新为 Y」/);
  assert.match(s, /引导其到「我的」页手动设置/);
  assert.match(s, /6\. 重新分析/);
  const en = buildAgenticSection('en');
  assert.match(en, /5\. FTP auto-update/);
  assert.match(en, /"FTP has been updated from X to Y"/);
  assert.match(en, /6\. Re-analysis/);
});

test('对话指令与当前时间段：双语切换', () => {
  assert.match(buildChatInstruction('follow_up', 'zh'), /每次回答控制在 200 字以内/);
  assert.match(buildChatInstruction('chat', 'zh'), /你是用户的随身 AI 训练顾问/);
  assert.match(buildChatInstruction('follow_up', 'en'), /within 200 characters/);
  assert.match(buildDateSection(new Date('2026-03-26T10:00:00'), 'zh'), /今天是 2026-03-26/);
  assert.match(buildDateSection(new Date('2026-03-26T10:00:00'), 'en'), /2026-03-26/);
  assert.equal(buildDateSection(null), null);
});

test('对话系统段（follow_up）：快答指令 + 报告正文 + 训练数据 + 工具 + 记忆，不注 skills', () => {
  const s = buildChatSystemSection(
    {
      mode: 'follow_up',
      agentic: true,
      athlete: ATHLETE,
      profile: { identity: '上班族', goal: '一年内完成 200km' },
      skills: '## 专业知识库\n\n不应出现在 follow_up',
      memories: [{ id: 3, content: '左膝伤后恢复中', category: 'injury', created_at: '2026-03-01 09:00:00' }],
      now: new Date('2026-03-26T10:00:00'),
      reportMarkdown: '# 复盘报告\n\n本次训练 NP 180W…',
      summary: sampleSummary(),
    },
    'zh',
  );
  assert.match(s, /每次回答控制在 200 字以内/);
  assert.match(s, /训练分析报告：\n# 复盘报告/);
  assert.match(s, /本次训练数据（供引用具体细节）：\n```json/);
  assert.match(s, /## 数据查询与计算工具/); // agentic 开 → 工具指引
  assert.match(s, /## 用户记忆/); // agentic 开 → 记忆段
  assert.match(s, /#3, 伤病/);
  assert.doesNotMatch(s, /专业知识库/); // follow_up 不注 skills
  assert.doesNotMatch(s, /## 角色/); // 无角色段（快答场景）
  assert.doesNotMatch(s, /用户背景与训练目标/); // 无 profile 段
});

test('对话系统段（chat）：角色 + 口径 + 当前时间 + skills + profile + 指令 + 工具 + 记忆', () => {
  const s = buildChatSystemSection(
    {
      mode: 'chat',
      agentic: true,
      athlete: ATHLETE,
      profile: { identity: '上班族', goal: '' },
      skills: '## 专业知识库\n\n### 技能甲\n\n内容',
      memories: [],
      now: new Date('2026-03-26T10:00:00'),
    },
    'zh',
  );
  assert.match(s, /^## 角色/);
  assert.match(s, /## 指标口径与骑手参数/);
  assert.match(s, /## 当前时间/);
  assert.match(s, /## 专业知识库/);
  assert.match(s, /身份：上班族/);
  assert.match(s, /你是用户的随身 AI 训练顾问/);
  assert.match(s, /## 数据查询与计算工具/);
  assert.match(s, /（暂无记忆——/); // 无记忆也注入空态，保持 save_memory 指引
});

test('对话系统段：agentic 关闭时无工具指引与记忆段', () => {
  const s = buildChatSystemSection(
    { mode: 'chat', agentic: false, athlete: ATHLETE, profile: null, skills: null, memories: [], now: new Date() },
    'zh',
  );
  assert.doesNotMatch(s, /## 数据查询与计算工具/);
  assert.doesNotMatch(s, /## 用户记忆/);
});

test('英文复盘提示词：角色/口径/时间/问题全英', () => {
  const p = buildReviewPrompt(sampleSummary(), ATHLETE, null, null, 'en', new Date('2026-03-26T10:00:00'));
  assert.match(p, /^## Role\n\nYou are a rigorous, pragmatic cycling coach/);
  // 客观性修正：en 口径注意与评价平衡同步钉死
  assert.match(p, /Be objective and balanced: explicitly acknowledge what the data shows was done well/);
  assert.match(p, /a high Z1 share does not mean the rider was not pedaling/);
  assert.match(p, /judging the baseline against the user-assigned category and context/);
  assert.match(p, /do not place a pause into a hard segment by guesswork/);
  assert.match(p, /## Metrics & Athlete Parameters/);
  assert.match(p, new RegExp(`FTP ${ATHLETE.ftp_watts} W, max HR ${ATHLETE.max_hr} bpm, weight ${ATHLETE.weight_kg} kg`));
  assert.match(p, /## Current Date & Time/);
  assert.match(p, /1\. Given the category the user assigned/);
  assert.match(p, /The user has categorized this record as \*\*Training\*\*/);
});

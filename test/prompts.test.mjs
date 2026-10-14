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
  buildMemoryReviewPrompt,
  buildDossierSection,
  buildProfileSection,
  buildDateSection,
  buildChatInstruction,
  compactSummaryForPrompt,
  compactReportForPrompt,
  headlineSummaryForPrompt,
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
  assert.match(s, /5\. 记录时区分时效与类别/); // scope/strategy 指引
  const empty = buildMemorySection([], 'zh');
  assert.match(empty, /（暂无记忆——这是你第一次积累对用户的了解/);
});

test('记忆分层：strategy 进权威段置顶、short 行内标注、普通记忆维持原格式', () => {
  const mems = [
    { id: 9, content: '出差一周', category: 'schedule', scope: 'short', created_at: '2026-03-03 10:00:00' },
    { id: 8, content: '上坡以心率和功率为主控，踏频允许降到 65-75rpm', category: 'strategy', created_at: '2026-03-02 10:00:00' },
    { id: 7, content: '左膝伤后恢复中', category: 'injury', created_at: '2026-03-01 09:00:00' },
  ];
  const s = buildMemorySection(mems, 'zh');
  // 策略段置顶且含权威规则
  assert.match(s, /^## 训练策略（既定结论）/);
  assert.match(s, /#8\) 上坡以心率和功率为主控/);
  assert.match(s, /必须显式指出「这与既定策略不同」/);
  // 策略条目不再出现在普通记忆列表
  const memListStart = s.indexOf('## 用户记忆');
  assert.ok(memListStart > 0);
  assert.equal(s.slice(memListStart).indexOf('#8'), -1);
  // 短期标注
  assert.match(s, /\(#9, 日程, 短期\) 出差一周/);
  // 长期条目原格式
  assert.match(s, /\(#7, 伤病\) 左膝伤后恢复中/);
  // en 版本
  const en = buildMemorySection(mems, 'en');
  assert.match(en, /^## Training Strategies \(Agreed Conclusions\)/);
  assert.match(en, /#9, Schedule, short-term\)/);
});

test('记忆回顾轮：报告全文 + 回顾指令 + 既有记忆段（去重基准）', () => {
  const mems = [{ id: 3, content: '左膝伤后恢复中', category: 'injury', created_at: '2026-03-01 09:00:00' }];
  const s = buildMemoryReviewPrompt('## 报告正文\n\nNP 为 280W。', mems, 'zh');
  assert.match(s, /## 记忆回顾/);
  assert.match(s, /## 报告正文[\s\S]*NP 为 280W/); // 报告全文在前
  assert.match(s, /判断是否有值得记入记忆的用户事实/); // 回顾指令
  assert.match(s, /## 用户记忆[\s\S]*\(#3, 伤病\) 左膝伤后恢复中/); // 既有清单殿后（去重基准）
  assert.match(s, /不调用任何工具、直接回复「无」/); // 无需记录时不许空跑工具
  assert.match(s, /不要把你自己的分析建议存为记忆/); // 防模型把自身建议写成权威策略段
  const en = buildMemoryReviewPrompt('report', null, 'en');
  assert.match(en, /## Memory Review/);
  assert.match(en, /reply "none"/);
  assert.match(en, /never store your own analysis or recommendations/);
});

test('记忆分层口径：rule.4 与工时描述同步两周/5 次放宽（2026-10-13 拍板）', () => {
  const zh = buildMemorySection([], 'zh');
  assert.match(zh, /短期记忆超过两周或 5 次训练后自动失效/);
  assert.doesNotMatch(zh, /超过一周或 3 次训练/);
  const en = buildMemorySection([], 'en');
  assert.match(en, /auto-expire after two weeks or 5 activities/);
});

test('档案段：null 省略；完整档案逐行渲染；被标记披露', () => {
  assert.equal(buildDossierSection(null, 'zh'), null);
  const dossier = {
    generated_at: '2026-10-12T00:00:00.000Z',
    anchor_date: '2026-10-01',
    ftp_watts: 250,
    cycling: { considered: 12, with_power: 10, flagged_excluded: 1, total_flagged: 2 },
    peak_power: {
      all_time: [
        { window: '5s', value_w: 900, date: '2026-08-01', file_name: 'a.fit' },
        { window: '20min', value_w: 280, date: '2026-09-15', file_name: 'b.fit' },
      ],
      last_90d: [{ window: '20min', value_w: 280, date: '2026-09-15', file_name: 'b.fit' }],
    },
    climb_profile: { climbs_analyzed: 5, median_grade_pct: 5.2, median_pct_ftp: 88.3, median_avg_hr: 152 },
    cadence_profile: { rides_analyzed: 8, style_counts: { low: 4, normal: 3, high: 1 } },
    intensity_structure: {
      zone_pct: { Z1: 30, Z2: 25, Z3: 20, Z4: 15, Z5: 7, Z6: 2.5, Z7: 0.5 },
      intensity_types: [{ month: '2026-09', type: 'pyramidal' }],
    },
    load_shape: {
      weeks: Array.from({ length: 8 }, (_, i) => ({ start: `w${i}`, end: `w${i}e`, tss: 200, duration_sec: 36000, rides: 3 })),
      hr_drift: { median_pct: 3.4, rides: 9 },
    },
  };
  const s = buildDossierSection(dossier, 'zh');
  assert.match(s, /^## 个人训练档案（本地自动汇总的长期基线）/);
  assert.match(s, /截至 2026-10-01，近 90 天 12 次骑行（10 次带功率）/);
  assert.match(s, /历史最佳：5s 900 \/ 1min — \/ 5min — \/ 20min 280/); // 缺窗口显式 —
  assert.match(s, /近 90 天最佳：5s — \/ 1min — \/ 5min — \/ 20min 280/); // 缺窗口显式 —
  assert.match(s, /坡度 5\.2%、强度 88\.3%FTP、心率 152 bpm/);
  assert.match(s, /低踏频 50%、正常 37\.5%、高踏频 12\.5%/);
  assert.match(s, /Z1–Z2 55%、Z3–Z4 35%、Z5–Z7 10%/);
  assert.match(s, /月度强度类型：2026-09 pyramidal/);
  assert.match(s, /周均 TSS 200（峰值 200），周均骑行 10 小时/);
  assert.match(s, /心率漂移中位 3\.4%（9 次样本/);
  assert.match(s, /功率可信度：2 次骑行被标记功率不可信/);
  const en = buildDossierSection(dossier, 'en');
  assert.match(en, /^## Athlete Dossier/);
});

test('复盘提示词注入档案段（新末参，缺省不影响旧调用）', () => {
  const base = buildReviewPrompt(sampleSummary(), ATHLETE, null, null, 'zh', new Date('2026-03-26T10:00:00'));
  assert.doesNotMatch(base, /个人训练档案/);
  const withDossier = buildReviewPrompt(
    sampleSummary(), ATHLETE, null, null, 'zh', new Date('2026-03-26T10:00:00'),
    '## 个人训练档案（本地自动汇总的长期基线）\n\n测试段',
  );
  assert.match(withDossier, /## 个人训练档案（本地自动汇总的长期基线）/);
  // 档案段在训练数据段之前（profile 之后、数据段之前）
  assert.ok(withDossier.indexOf('个人训练档案') < withDossier.indexOf('## 训练数据'));
});

test('agentic 工具指引段：16 个工具与 6 条规则（含 FTP 更新/重新分析/训练计划）', () => {
  const s = buildAgenticSection('zh');
  for (const name of ['list_activities', 'get_activity_summary', 'get_activity_records', 'get_form_series', 'get_monthly_summary', 'get_athlete_profile', 'estimate_ftp', 'simulate_form', 'generate_workout', 'update_ftp', 'reanalyze_activity', 'get_dossier', 'get_training_plan', 'update_training_plan', 'set_power_flag', 'recalibrate_activity_power']) {
    assert.ok(s.includes(`- ${name}：`), name);
  }
  // update_training_plan 的「整体重发」约束须在指引段硬性出现（follow_up 不注 skills，
  // 工具清单是该场景唯一的约束来源——code-review P2-1）
  assert.match(s, /必须整体重发全部课次/);
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
  assert.match(en, /ALWAYS resend every session/);
});

test('对话指令与当前时间段：双语切换', () => {
  assert.match(buildChatInstruction('follow_up', 'zh'), /每次回答控制在 200 字以内/);
  assert.match(buildChatInstruction('chat', 'zh'), /你是用户的随身 AI 训练顾问/);
  assert.match(buildChatInstruction('plan', 'zh'), /训练计划」对话中/);
  assert.match(buildChatInstruction('plan', 'zh'), /update_training_plan/);
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

test('compactReportForPrompt：短报告原样、长报告保首末章中间只留标题', () => {
  const short = '# 复盘报告\n\n本次训练 NP 180W…';
  assert.equal(compactReportForPrompt(short, 'zh'), short); // ≤6000 字符不裁

  const long = [
    '# 复盘报告',
    '\n总体看这是一次完成度很高的训练' + '。补充叙述'.repeat(80),
    '\n\n## 分段细节\n\n' + '前半段功率平稳，后半段出现衰减，'.repeat(300),
    '\n\n## 建议\n\n' + '下周安排一次低强度长骑恢复，'.repeat(300),
  ].join('');
  assert.ok(long.length > 6000);
  const c = compactReportForPrompt(long, 'zh');
  assert.match(c, /^# 复盘报告/); // 首章（含引言）全文
  assert.match(c, /补充叙述/);
  assert.match(c, /中间章节仅保留标题/); // 省略说明
  assert.match(c, /## 分段细节/); // 中间章标题保留…
  assert.doesNotMatch(c, /功率平稳/); // …正文省略
  assert.match(c, /## 建议\n\n下周安排/); // 末章全文
  const en = compactReportForPrompt(long, 'en');
  assert.match(en, /middle sections below are headings only/);

  const noHeading = '无标题长文'.repeat(2000); // 10000 字符、无 markdown 标题
  const f = compactReportForPrompt(noHeading, 'zh');
  assert.ok(f.length < noHeading.length);
  assert.match(f, /^无标题长文/); // 首部保留
  assert.ok(f.includes('……')); // 无章节可依：字符截断 + 省略号衔接（不出章节措辞的说明）

  // code-review P1 回归：单标题长报告不得被复制成两份（首末章指向同一标题）
  const oneHeading = '# 复盘报告\n\n' + '正文叙述'.repeat(1500); // 12000 字符、仅 1 个标题
  const one = compactReportForPrompt(oneHeading, 'zh');
  assert.ok(one.length < oneHeading.length, '单标题长报告应截断而非复制');
  assert.equal(one.split('# 复盘报告').length - 1, 1, '标题只出现一次');
  // 两个标题：首末各全保（等于全文）、无中间章说明
  const twoHeading = '# 报告\n\n' + '前半'.repeat(800) + '\n\n## 尾声\n\n' + '后半'.repeat(800);
  const two = compactReportForPrompt(twoHeading, 'zh');
  assert.equal(two.length, twoHeading.length); // 首末章即全文
  assert.doesNotMatch(two, /中间章节仅保留标题/);
});

test('headlineSummaryForPrompt：留标量核心与区间占比，丢列表载荷', () => {
  const s = sampleSummary({
    power: { normalized_power: 180, avg: 160, intensity_factor: 0.85, tss: 60, peak_curve: [{ min: 1, watts: 300 }], zone_distribution_pct: { z1: 40, z2: 35 }, calibration_scale: 1.02 },
    activity: { date: '2026-03-25', sport: 'cycling', duration_sec: 3600, category: 'training', avg_speed_kmh: 28.5, elevation_gain_source: 'device' },
    segments: [{ name: 'seg1' }, { name: 'seg2' }],
    anomalies: [{ type: 'timer_pause', at: 'x' }],
    climbs: [{ name: '爬坡' }],
    interval_set: { sets: [] },
    data_quality: { record_count: 3600, power_coverage_pct: 99 },
  });
  const h = headlineSummaryForPrompt(s, 'zh');
  assert.equal(h.power.normalized_power, 180);
  assert.equal(h.power.calibration_scale, 1.02); // 功率口径留痕：headline 仍带（常量体积标量）
  assert.equal(h.activity.avg_speed_kmh, 28.5);
  assert.equal(h.activity.elevation_gain_source, 'device');
  assert.deepEqual(h.power.zone_distribution_pct, { z1: 40, z2: 35 }); // 小型映射保留
  assert.equal(h.data_quality.record_count, 3600);
  assert.equal(h.athlete_context.ctl, 50);
  assert.equal('segments' in h, false); // 列表载荷不进 headline
  assert.equal('anomalies' in h, false);
  assert.equal('climbs' in h, false);
  assert.equal('interval_set' in h, false);
  assert.equal('peak_curve' in h.power, false);
  assert.deepEqual(h, headlineSummaryForPrompt(s, 'en')); // 双语同形（无文案）
});

test('对话系统段（follow_up）第 2 轮起：summary 降 headline、长报告瘦身为首末章', () => {
  const base = {
    mode: 'follow_up',
    agentic: true,
    athlete: ATHLETE,
    profile: null,
    skills: null,
    memories: [],
    now: new Date('2026-03-26T10:00:00'),
    summary: sampleSummary({
      power: { normalized_power: 180, avg: 160, tss: 60, peak_curve: [{ min: 1, watts: 300 }] },
      segments: [{ name: 'seg1' }],
    }),
  };
  const round2 = buildChatSystemSection({ ...base, historyTurns: 1 }, 'zh');
  assert.match(round2, /"normalized_power":180/); // headline 仍可定位训练量级
  assert.doesNotMatch(round2, /"segments"/);
  assert.doesNotMatch(round2, /"peak_curve"/);
  const round1 = buildChatSystemSection({ ...base, historyTurns: 0 }, 'zh');
  assert.match(round1, /"peak_curve"/); // 首轮 summary 走 compactSummaryForPrompt 全量（不裁 peak_curve，短 segments 原样）
  assert.match(round1, /"segments"/);
  const legacy = buildChatSystemSection(base, 'zh'); // 未传 historyTurns 视为首轮（向后兼容）
  assert.match(legacy, /"segments"/);

  const longReport = [
    '# 复盘报告',
    '\n总体评价' + '。展开'.repeat(80),
    '\n\n## 心率与漂移\n\n' + '心率漂移偏大，'.repeat(900),
    '\n\n## 建议\n\n休息',
  ].join('');
  const trimmed = buildChatSystemSection({ ...base, historyTurns: 1, reportMarkdown: longReport }, 'zh');
  assert.match(trimmed, /中间章节仅保留标题/);
  assert.doesNotMatch(trimmed, /心率漂移偏大/); // 中间章正文不进系统段
  assert.match(trimmed, /## 建议\n\n休息/);
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

test('对话系统段（plan）：与 chat 同构（角色/口径/skills/profile），指令为计划会话口径', () => {
  const s = buildChatSystemSection(
    {
      mode: 'plan',
      agentic: true,
      athlete: ATHLETE,
      profile: null,
      skills: '## 专业知识库\n\n### 技能甲\n\n内容',
      memories: [],
      now: new Date('2026-03-26T10:00:00'),
    },
    'zh',
  );
  assert.match(s, /^## 角色/);
  assert.match(s, /## 专业知识库/); // plan 会话注入 skills（同 chat）
  assert.match(s, /训练计划」对话中/); // 计划会话专属指令
  assert.match(s, /get_training_plan/);
  assert.match(s, /update_training_plan/);
  assert.doesNotMatch(s, /训练分析报告：/); // 无 follow_up 的报告正文段
});

test('对话系统段：agentic 关闭时无工具指引与记忆段', () => {
  const s = buildChatSystemSection(
    { mode: 'chat', agentic: false, athlete: ATHLETE, profile: null, skills: null, memories: [], now: new Date() },
    'zh',
  );
  assert.doesNotMatch(s, /## 数据查询与计算工具/);
  assert.doesNotMatch(s, /## 用户记忆/);
});

test('周期规划提示词：既有计划处理段 + plan-json 输出格式段（双语，v2 计划载体）', () => {
  const data = { months: [], formSeries: [], recentActivities: [] };
  const zh = buildPlanPrompt(data, ATHLETE, null, null, 'zh', new Date('2026-03-26T10:00:00'));
  assert.match(zh, /## 既有计划处理/);
  assert.match(zh, /get_training_plan/);
  assert.match(zh, /「续订」还是「替换」/);
  assert.match(zh, /## 计划输出格式（硬性要求）/);
  assert.match(zh, /```plan-json/); // 示例骨架围栏
  assert.match(zh, /一天至多一课/);
  assert.match(zh, /减量周/);
  const en = buildPlanPrompt(data, ATHLETE, null, null, 'en', new Date('2026-03-26T10:00:00'));
  assert.match(en, /## Handling an Existing Plan/);
  assert.match(en, /## Plan Output Format \(mandatory\)/);
  assert.match(en, /at most one session per day/);
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

/**
 * training-plan.test.mjs — 结构化训练计划核心层测试（node:test）
 *
 * 覆盖：plan-json 围栏提取（缺块/坏 JSON/多处取末）、单课 TSS 估算与回填、
 * 双档校验全分支（格式硬错逐类；合理性三规则在 create→warnings / adjust→violations
 * 两档的行为差异）、有效期判定、ISO 周锚点、周聚合与减量周标记、周视图切片、
 * simulateForm 负荷推演、合理性提示的双语渲染。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePlanWeeks,
  diffDays,
  estimateSessionTss,
  extractPlanFromMarkdown,
  formatPlanIssue,
  planValidity,
  projectPlanForm,
  resolvePlanTss,
  slicePlanWeek,
  weekStartOf,
  validateTrainingPlan,
} from '../src/core/training-plan.ts';
import { localDay } from '../src/core/local-day.ts';

const TODAY = '2026-10-13'; // 周二

/** 课次夹具（缺省：60 分钟有氧耐力课） */
const session = (date, type = 'endurance', duration_min = 60, extra = {}) => ({
  date,
  type,
  duration_min,
  intensity: null,
  tss: null,
  note: null,
  ...extra,
});

/** 计划夹具（缺省：2026-10-12（周一）起两周） */
const plan = (overrides = {}, sessions = []) => ({
  valid_from: '2026-10-12',
  valid_to: '2026-10-25',
  goal: '打好有氧基础',
  sessions,
  ...overrides,
});

test('extractPlanFromMarkdown: 无围栏块返回 tp.no_block', () => {
  const r = extractPlanFromMarkdown('# 报告\n正文，没有数据块', 'zh');
  assert.equal(r.plan, null);
  assert.match(r.error, /plan-json/);
});

test('extractPlanFromMarkdown: 坏 JSON 返回错误并带原因', () => {
  const r = extractPlanFromMarkdown('```plan-json\n{"valid_from": }\n```', 'zh');
  assert.equal(r.plan, null);
  assert.match(r.error, /合法 JSON/);
});

test('extractPlanFromMarkdown: 正常提取；多处出现取最后一处', () => {
  const md = [
    '前文',
    '```plan-json\n{"valid_from":"2026-10-12","valid_to":"2026-10-25","goal":"旧","sessions":[]}\n```',
    '```plan-json\n{"valid_from":"2026-10-12","valid_to":"2026-10-25","goal":"新","sessions":[]}\n```',
  ].join('\n');
  const r = extractPlanFromMarkdown(md, 'zh');
  assert.equal(r.error, null);
  assert.equal(r.plan.goal, '新');
});

test('estimateSessionTss: 阈值 60min = 100；rest/缺时长为 0；甜区按 IF² 折算', () => {
  assert.equal(estimateSessionTss('threshold', 60), 100);
  assert.equal(estimateSessionTss('rest', 60), 0);
  assert.equal(estimateSessionTss('endurance', null), 0);
  assert.equal(estimateSessionTss('sweet_spot', 75), 103.5); // 75×60×0.91²/36
});

test('resolvePlanTss: 缺失回填、有效值保留、非有限值回填', () => {
  const out = resolvePlanTss([
    session('2026-10-12', 'threshold', 60, { tss: null }),
    session('2026-10-13', 'endurance', 60, { tss: 80 }),
    session('2026-10-14', 'rest', null, { tss: NaN }),
  ]);
  assert.equal(out[0].tss, 100);
  assert.equal(out[1].tss, 80);
  assert.equal(out[2].tss, 0);
});

test('validateTrainingPlan: 非对象输入报结构错误', () => {
  for (const raw of [null, 'x', 42, []]) {
    const r = validateTrainingPlan(raw, TODAY, 'create');
    assert.equal(r.ok, false);
    assert.equal(r.plan, null);
    assert.match(r.errors[0], /结构不完整|structure/);
  }
});

test('validateTrainingPlan: 有效期日期非法', () => {
  const r = validateTrainingPlan(plan({ valid_from: '2026/10/12' }), TODAY, 'create');
  assert.match(r.errors[0], /YYYY-MM-DD/);
});

test('validateTrainingPlan: 窗长越界（43 天过长 / 1 天过短）', () => {
  const long = validateTrainingPlan(plan({ valid_to: '2026-11-23' }), TODAY, 'create');
  assert.ok(long.errors.some((e) => e.includes('42')));
  const short = validateTrainingPlan(plan({ valid_to: '2026-10-12' }), TODAY, 'create');
  assert.ok(short.errors.some((e) => e.includes('3–42')));
});

test('validateTrainingPlan: valid_from 早于 7 天容错窗', () => {
  const r = validateTrainingPlan(plan({ valid_from: '2026-10-05' }), TODAY, 'create');
  assert.ok(r.errors.some((e) => e.includes('7')));
});

test('validateTrainingPlan: valid_to 已过去（计划必须覆盖未来）', () => {
  const r = validateTrainingPlan(
    plan({ valid_from: '2026-10-08', valid_to: '2026-10-12' }, [session('2026-10-12')]),
    TODAY,
    'create',
  );
  assert.ok(r.errors.some((e) => e.includes('2026-10-13')));
});

test('validateTrainingPlan: today 非法时 from_past 兜底、to_past 跳过', () => {
  const r = validateTrainingPlan(plan(), null, 'create');
  assert.ok(r.errors.some((e) => e.includes('valid_from')));
  assert.ok(!r.errors.some((e) => e.includes('覆盖未来') || e.includes('cover the future')));
});

test('validateTrainingPlan: sessions 缺失或为空数组', () => {
  assert.match(validateTrainingPlan(plan({ sessions: undefined }), TODAY, 'create').errors[0], /sessions/);
  assert.match(validateTrainingPlan(plan({}, []), TODAY, 'create').errors[0], /sessions/);
});

test('validateTrainingPlan: 课次逐类硬错', () => {
  const cases = [
    [[ 'not-an-object' ], /第 1 条/],
    [[session('2026-10-32')], /YYYY-MM-DD/],
    [[session('2026-10-12'), session('2026-10-12')], /一天至多一课/],
    [[session('2026-10-12', 'racing')], /racing/],
    [[session('2026-10-12', 'threshold', null)], /10–600/],
    [[session('2026-10-12', 'threshold', 9)], /10–600/],
    [[session('2026-10-12', 'threshold', 601)], /10–600/],
    [[session('2026-10-12', 'threshold', 60.5)], /10–600/],
    [[session('2026-10-12', 'endurance', 60, { tss: -1 })], /tss/],
    [[session('2026-10-12', 'endurance', 60, { tss: 501 })], /tss/],
  ];
  for (const [sessions, re] of cases) {
    const r = validateTrainingPlan(plan({}, sessions), TODAY, 'create');
    assert.equal(r.ok, false, JSON.stringify(sessions));
    assert.match(r.errors.join('\n'), re);
  }
});

test('validateTrainingPlan: 课次越窗仅在计划级校验全过时检查', () => {
  const r = validateTrainingPlan(
    plan({ valid_to: '2026-10-18' }, [session('2026-10-22')]),
    TODAY,
    'create',
  );
  assert.match(r.errors.join('\n'), /超出计划有效期/);
});

test('validateTrainingPlan: 通过路径——规范化（排序/截断/rest 归零/tss 回填/字符串 tss 收敛）', () => {
  const goal = 'g'.repeat(260);
  const r = validateTrainingPlan(
    plan(
      { goal },
      [
        session('2026-10-14', 'endurance', 60, { intensity: 'i'.repeat(120), note: 'n'.repeat(300) }),
        session('2026-10-13', 'threshold', 60, { tss: '85' }),
        session('2026-10-12', 'rest', null, { tss: 30, duration_min: 999 }),
      ],
    ),
    TODAY,
    'create',
  );
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.plan.goal.length, 200);
  assert.deepEqual(r.plan.sessions.map((s) => s.date), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(r.plan.sessions[0].type, 'rest');
  assert.equal(r.plan.sessions[0].duration_min, null); // rest 课忽略时长
  assert.equal(r.plan.sessions[0].tss, 0); // rest 课负荷恒 0
  assert.equal(r.plan.sessions[1].tss, 85); // 字符串数值收敛
  assert.equal(r.plan.sessions[2].tss, 46.2); // 缺失回填：60min endurance（100×0.68²）
  assert.equal(r.plan.sessions[1].intensity, null);
  assert.equal(r.plan.sessions[2].intensity.length, 80);
  assert.equal(r.plan.sessions[2].note.length, 200);
});

test('validateTrainingPlan: 质量课间隔不足——create 记警告、adjust 记违规', () => {
  const sessions = [
    session('2026-10-13', 'threshold', 60),
    session('2026-10-14', 'threshold', 60),
  ];
  const created = validateTrainingPlan(plan({}, sessions), TODAY, 'create');
  assert.equal(created.ok, true);
  assert.equal(created.warnings.length, 1);
  assert.equal(created.warnings[0].code, 'quality_gap');
  assert.equal(created.violations.length, 0);
  const adjusted = validateTrainingPlan(plan({}, sessions), TODAY, 'adjust');
  assert.equal(adjusted.violations.length, 1);
  assert.equal(adjusted.warnings.length, 0);
});

test('validateTrainingPlan: 质量课间隔恰为 2 天（≥48h 日粒度边界）不提示', () => {
  const r = validateTrainingPlan(
    plan({}, [
      session('2026-10-13', 'threshold', 60),
      session('2026-10-15', 'vo2max', 60),
    ]),
    TODAY,
    'adjust',
  );
  assert.equal(r.violations.length, 0);
});

test('validateTrainingPlan: 整周无休息日——显式满周触发，留一天空缺豁免，残周不查', () => {
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
  const full = validateTrainingPlan(plan({}, week.map((d) => session(d))), TODAY, 'create');
  assert.ok(full.warnings.some((w) => w.code === 'no_rest'));

  const sixDays = validateTrainingPlan(
    plan({}, week.slice(0, 6).map((d) => session(d))),
    TODAY,
    'create',
  );
  assert.ok(!sixDays.warnings.some((w) => w.code === 'no_rest'));

  const partial = validateTrainingPlan(
    plan({ valid_to: '2026-10-15' }, ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'].map((d) => session(d))),
    TODAY,
    'create',
  );
  assert.ok(!partial.warnings.some((w) => w.code === 'no_rest'));

  const explicitRest = validateTrainingPlan(
    plan({}, [...week.slice(0, 6).map((d) => session(d)), session('2026-10-18', 'rest', null)]),
    TODAY,
    'create',
  );
  assert.ok(!explicitRest.warnings.some((w) => w.code === 'no_rest'));
});

test('validateTrainingPlan: 减量周节奏——连续 4 周等负荷触发，含减量周豁免，不足 4 周不查', () => {
  const flatWeek = (start, tss) =>
    [0, 2, 4].map((k) => session(addDaysStr(start, k), 'endurance', 60, { tss }));

  const flat = validateTrainingPlan(
    plan(
      { valid_to: '2026-11-08' },
      [
        ...flatWeek('2026-10-12', 200),
        ...flatWeek('2026-10-19', 200),
        ...flatWeek('2026-10-26', 200),
        ...flatWeek('2026-11-02', 200),
      ],
    ),
    TODAY,
    'create',
  );
  assert.equal(flat.warnings.filter((w) => w.code === 'no_recovery').length, 1);

  const withDown = validateTrainingPlan(
    plan(
      { valid_to: '2026-11-08' },
      [
        ...flatWeek('2026-10-12', 200),
        ...flatWeek('2026-10-19', 200),
        ...flatWeek('2026-10-26', 200),
        ...flatWeek('2026-11-02', 100), // ≤ 最大周 200×0.7
      ],
    ),
    TODAY,
    'create',
  );
  assert.ok(!withDown.warnings.some((w) => w.code === 'no_recovery'));

  const threeWeeks = validateTrainingPlan(
    plan(
      { valid_to: '2026-11-01' },
      [...flatWeek('2026-10-12', 200), ...flatWeek('2026-10-19', 200), ...flatWeek('2026-10-26', 200)],
    ),
    TODAY,
    'create',
  );
  assert.ok(!threeWeeks.warnings.some((w) => w.code === 'no_recovery'));
});

test('validateTrainingPlan: 六周无减量——滑动窗逐个标注（3 个重叠窗）', () => {
  const flatWeek = (start) => [0, 2, 4].map((k) => session(addDaysStr(start, k), 'endurance', 60, { tss: 200 }));
  const r = validateTrainingPlan(
    plan(
      { valid_from: '2026-10-12', valid_to: '2026-11-22' },
      ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'].flatMap(flatWeek),
    ),
    TODAY,
    'create',
  );
  assert.equal(r.warnings.filter((w) => w.code === 'no_recovery').length, 3);
});

test('planValidity: upcoming / valid / expired 三态与天数', () => {
  assert.deepEqual(planValidity({ valid_from: '2026-10-20', valid_to: '2026-11-02' }, TODAY), {
    state: 'upcoming',
    days_left: 7,
  });
  assert.deepEqual(planValidity({ valid_from: '2026-10-12', valid_to: '2026-10-25' }, TODAY), {
    state: 'valid',
    days_left: 12,
  });
  assert.deepEqual(planValidity({ valid_from: '2026-10-12', valid_to: '2026-10-25' }, '2026-10-25'), {
    state: 'valid',
    days_left: 0,
  });
  assert.deepEqual(planValidity({ valid_from: '2026-09-28', valid_to: '2026-10-11' }, TODAY), {
    state: 'expired',
    days_left: 2,
  });
});

test('weekStartOf: 周日归前一周周一，周一为自身', () => {
  assert.equal(weekStartOf('2026-10-18'), '2026-10-12'); // 周日
  assert.equal(weekStartOf('2026-10-13'), '2026-10-12'); // 周二
  assert.equal(weekStartOf('2026-10-12'), '2026-10-12'); // 周一
});

test('aggregatePlanWeeks: 周聚合（课次/质量课/TSS 合计/减量周标记）', () => {
  const rows = aggregatePlanWeeks([
    session('2026-10-12', 'threshold', 60), // 100
    session('2026-10-13', 'rest', null),
    session('2026-10-15', 'endurance', 90), // 69.4
    session('2026-10-17', 'sweet_spot', 60), // 82.8
    session('2026-10-20', 'vo2max', 45), // 95.8
    session('2026-10-22', 'recovery', 30), // 12.5
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].week_start, '2026-10-12');
  assert.equal(rows[0].week_end, '2026-10-18');
  assert.equal(rows[0].sessions, 3); // rest 不计课次
  assert.equal(rows[0].quality, 2);
  assert.equal(rows[0].tss, 252.2);
  assert.equal(rows[0].recovery, false);
  assert.equal(rows[1].tss, 108.3);
  assert.equal(rows[1].recovery, true); // ≤ 最大周 252.2×0.7
  assert.equal(aggregatePlanWeeks([]).length, 0);
});

test('slicePlanWeek: 按周一切片（含两端边界）', () => {
  const p = {
    valid_from: '2026-10-12',
    valid_to: '2026-10-25',
    goal: 'g',
    sessions: [
      session('2026-10-11'), // 上一周日——不入选
      session('2026-10-12'),
      session('2026-10-18'),
      session('2026-10-19'), // 下一周一——不入选
    ],
  };
  const week = slicePlanWeek(p, '2026-10-12');
  assert.deepEqual(week.map((s) => s.date), ['2026-10-12', '2026-10-18']);
});

test('projectPlanForm: 高负荷计划触发 TSB 持续过低旗标，轻负荷不触发', () => {
  const heavyDays = Array.from({ length: 14 }, (_, k) =>
    session(addDaysStr('2026-10-12', k), 'threshold', 120),
  );
  const heavy = projectPlanForm(
    { valid_from: '2026-10-12', valid_to: '2026-10-25', goal: 'g', sessions: heavyDays },
    50,
    50,
  );
  assert.ok(heavy.risk_flags.some((f) => f.type === 'tsb_low_sustained'));
  assert.ok(heavy.end_form && heavy.end_form.tsb < -30);

  const lightDays = [0, 3, 6, 9, 12].map((k) => session(addDaysStr('2026-10-12', k), 'recovery', 45));
  const light = projectPlanForm(
    { valid_from: '2026-10-12', valid_to: '2026-10-25', goal: 'g', sessions: lightDays },
    50,
    50,
  );
  assert.equal(light.risk_flags.length, 0);
});

test('formatPlanIssue: 合理性提示按语言渲染', () => {
  const issue = { code: 'quality_gap', vars: { a: '2026-10-13', b: '2026-10-14', n: 1 } };
  assert.match(formatPlanIssue(issue, 'zh'), /2026-10-13/);
  assert.match(formatPlanIssue(issue, 'zh'), /≥48h/);
  assert.match(formatPlanIssue(issue, 'en'), /48h/);
});

test('validateTrainingPlan: 窗首残周覆盖 ≥5 天也参与休息日检查（回归：窗前日不再整周跳过）', () => {
  // 窗口周三（10-14）起，覆盖 10-14..10-18 共 5 天，全为课次且无休息日
  const r = validateTrainingPlan(
    plan(
      { valid_from: '2026-10-14', valid_to: '2026-10-18' },
      ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'].map((d) => session(d)),
    ),
    TODAY,
    'create',
  );
  assert.ok(r.warnings.some((w) => w.code === 'no_rest'));
});

test('localDay: 取本地日历日而非 UTC 日（按 Date 的本地分量断言，时区无关）', () => {
  const d = new Date('2026-10-13T16:30:00Z'); // UTC+8 下是 10-14 凌晨，UTC 下仍是 10-13
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  assert.equal(localDay(d), expected);
  assert.match(localDay(), /^\d{4}-\d{2}-\d{2}$/);
});

test('diffDays: 同日为 0，跨日按 UTC 日差', () => {
  assert.equal(diffDays('2026-10-12', '2026-10-12'), 0);
  assert.equal(diffDays('2026-10-12', '2026-10-25'), 13);
  assert.equal(diffDays('2026-10-25', '2026-10-12'), -13);
});

/** 测试内加天工具（与实现同口径，仅供夹具构造） */
function addDaysStr(dateStr, n) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

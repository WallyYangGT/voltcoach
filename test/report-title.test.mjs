/**
 * report-title.test.mjs — AI 报告标题装配测试（node:test，M5）
 *
 * 覆盖：四种模式 × zh/en 的正常标题、起骑时刻缺失时退化到日期、运动类型未知走泛称、
 * 训练已删除走「（训练已删除）」、规划窗口（周一起 28 天 + 跨年补年份）、
 * 以及词典完整性（core/reportTitle 声明的每个 key 在 zh/en 都存在）。
 *
 * 时区无关性：所有期望值都用**本地时间构造的 ISO**（new Date(y,m,d,h,mi)），
 * 再经标题内部转回本地，因此在任意 TZ 下断言一致。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { planWindow, reportTitle, PLAN_WINDOW_DAYS } from '../src/core/reportTitle.ts';
import { DICT } from '../src/i18n/dict.ts';

/** 镜像 src/i18n 的 t（含 {var} 插值）；顺带断言 key 在该语言下存在 */
const makeT = (lang) => (key, vars) => {
  const template = DICT[lang][key];
  assert.ok(template, `词典缺少 ${lang}.${key}`);
  return String(template).replace(/\{(\w+)\}/g, (m, name) => (name in (vars ?? {}) ? String(vars[name]) : m));
};

/** 本地时刻 → ISO（UTC）字符串，跨时区断言一致的基础 */
const localIso = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

const cycling = { sport: '骑行', startAt: localIso(2026, 9, 20, 8, 15), date: '2026-09-20' };

test('reportTitle(review): 运动类型 + 起骑时刻（本地）拼成标题', () => {
  assert.equal(
    reportTitle({ mode: 'review', lang: 'zh', ride: cycling }, makeT('zh')),
    '复盘骑行 2026年09月20日 08时',
  );
  assert.equal(
    reportTitle({ mode: 'review', lang: 'en', ride: { ...cycling, sport: 'Cycling' } }, makeT('en')),
    'Cycling review · Sep 20, 2026 08:15',
  );
});

test('reportTitle(review): 缺 records 首帧时退化到只显示日期', () => {
  const zh = makeT('zh');
  assert.equal(
    reportTitle({ mode: 'review', lang: 'zh', ride: { ...cycling, startAt: null } }, zh),
    '复盘骑行 2026年09月20日',
  );
});

test('reportTitle(review): 运动类型未知走泛称模板', () => {
  const zh = makeT('zh');
  assert.equal(
    reportTitle({ mode: 'review', lang: 'zh', ride: { ...cycling, sport: null } }, zh),
    '训练复盘 2026年09月20日 08时',
  );
});

test('reportTitle(review): 训练已删除（取不到骑行信息）不产生空标题', () => {
  assert.equal(
    reportTitle({ mode: 'review', lang: 'zh', ride: null }, makeT('zh')),
    '复盘骑行（训练已删除）',
  );
  assert.equal(
    reportTitle({ mode: 'review', lang: 'zh', ride: { sport: '骑行', date: null } }, makeT('zh')),
    '复盘骑行（训练已删除）',
  );
});

test('planWindow: 生成时刻所在自然周的周一起 28 天', () => {
  // 2026-09-23（周三 UTC 中午；±12h 内仍落在同一自然周）→ 周一 09-21 ～ 10-18
  const w = planWindow('2026-09-23 12:00:00');
  assert.equal(w.start.day(), 1); // 周一
  assert.equal(w.end.diff(w.start, 'day'), PLAN_WINDOW_DAYS - 1);
  assert.equal(w.start.format('YYYY-MM-DD'), '2026-09-21');
  assert.equal(w.end.format('YYYY-MM-DD'), '2026-10-18');
});

test('planWindow: 生成时刻就是周一时从当天起算；缺失/非法返回 null', () => {
  const w = planWindow('2026-09-21 12:00:00'); // 周一
  assert.equal(w.start.format('YYYY-MM-DD'), '2026-09-21');
  assert.equal(planWindow(null), null);
  assert.equal(planWindow(''), null);
  assert.equal(planWindow('not-a-date'), null);
});

test('reportTitle(plan): 区间文本（跨年两端都带年份）', () => {
  assert.equal(
    reportTitle({ mode: 'plan', lang: 'zh', createdAt: '2026-09-23 12:00:00' }, makeT('zh')),
    '周期规划 2026年09月21日-10月18日',
  );
  assert.equal(
    reportTitle({ mode: 'plan', lang: 'en', createdAt: '2026-09-23 12:00:00' }, makeT('en')),
    'Training plan · Sep 21 – Oct 18, 2026',
  );
  assert.equal(
    reportTitle({ mode: 'plan', lang: 'zh', createdAt: '2026-12-30 12:00:00' }, makeT('zh')),
    '周期规划 2026年12月28日-2027年01月24日',
  );
  assert.equal(
    reportTitle({ mode: 'plan', lang: 'en', createdAt: '2026-12-30 12:00:00' }, makeT('en')),
    'Training plan · Dec 28, 2026 – Jan 24, 2027',
  );
  assert.equal(reportTitle({ mode: 'plan', lang: 'zh', createdAt: null }, makeT('zh')), '周期规划');
});

test('reportTitle(taper): 比赛日期；缺失时退化为模式名', () => {
  assert.equal(
    reportTitle({ mode: 'taper', lang: 'zh', raceDate: '2026-10-05' }, makeT('zh')),
    '赛前减量 2026年10月05日',
  );
  assert.equal(
    reportTitle({ mode: 'taper', lang: 'en', raceDate: '2026-10-05' }, makeT('en')),
    'Race taper · Oct 5, 2026',
  );
  assert.equal(reportTitle({ mode: 'taper', lang: 'zh', raceDate: null }, makeT('zh')), '赛前减量');
});

test('reportTitle(compare): 两次骑行日期；任一侧缺失退化为泛称', () => {
  const a = { sport: '骑行', startAt: localIso(2026, 9, 20, 8, 15), date: '2026-09-20' };
  const b = { sport: '骑行', startAt: localIso(2026, 9, 13, 7, 30), date: '2026-09-13' };
  assert.equal(
    reportTitle({ mode: 'compare', lang: 'zh', ride: a, other: b }, makeT('zh')),
    '对比 2026年09月20日 08时 vs 2026年09月13日 07时',
  );
  assert.equal(
    reportTitle({ mode: 'compare', lang: 'zh', ride: a, other: null }, makeT('zh')),
    '两次骑行对比',
  );
});

test('词典完整性：reportTitle 用到的 key 在 zh/en 都存在', () => {
  const keys = [
    'ai.report.title.review',
    'ai.report.title.review_nosport',
    'ai.report.title.review_gone',
    'ai.report.title.plan',
    'ai.report.title.plan_norange',
    'ai.report.title.taper',
    'ai.report.title.taper_plain',
    'ai.report.title.compare',
    'ai.report.title.compare_plain',
  ];
  for (const lang of ['zh', 'en']) {
    const t = makeT(lang);
    for (const key of keys) assert.equal(typeof t(key, { sport: 'x', time: 'y', range: 'z', date: 'd', a: '1', b: '2' }), 'string');
  }
});

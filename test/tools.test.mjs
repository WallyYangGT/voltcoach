/**
 * tools.test.mjs — src/tools agentic 工具层回归测试。
 * 自 fit-reader Web 版 test/web.test.mjs 工具相关断言同源搬运（db 换假 ToolIo 注入）：
 * 参数校验/白名单、路径穿越拒绝、结果截断、save_memory 的 source 标记、
 * simulate_form 参数清洗与起始值缺省、executeTool 异常兜 {error}。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { toolDefs } = await import('../src/tools/defs.ts');
const { createExecuteTool } = await import('../src/tools/execute.ts');
const { AGENTIC } = await import('../src/core/settings.ts');

/** 内存版 ToolIo（最小数据集，按需覆写） */
function fakeIo(overrides = {}) {
  const io = {
    listActivities: async () => [
      { file_name: 'a.fit', date: '2026-03-25', sport: 'cycling', category: 'race', duration_sec: 3600, distance_km: 90, tss: 120, np: 200, intensity_factor: 0.9 },
      { file_name: 'b.fit', date: '2026-03-20', sport: 'cycling', category: 'training', duration_sec: 5400, distance_km: 120, tss: 90, np: 160, intensity_factor: 0.75 },
      { file_name: 'c.fit', date: '2026-03-18', sport: 'running', category: 'training', duration_sec: 1800, distance_km: 15, tss: 30, np: null, intensity_factor: null },
    ],
    getActivitySummary: async (name) =>
      name === 'a.fit'
        ? { activity: { date: '2026-03-25', category: 'race' }, power: { np: 200, tss: 120 }, anomalies: [] }
        : null,
    loadRecords: async (name, opts) => {
      if (name !== 'a.fit') return null;
      // 10 秒数据，stride 按 maxPoints 推算
      const points = Array.from({ length: 10 }, (_, i) => ({
        t: `2026-03-25T03:00:${String(i).padStart(2, '0')}.000Z`,
        power: 200 + i, heart_rate: 140, cadence: 90, altitude: 100, speed: 25, distance_m: i * 7, temperature: null,
      }));
      const stride = Math.max(1, Math.ceil(points.length / opts.maxPoints));
      return { points: points.filter((_, i) => i % stride === 0), total_seconds: points.length, stride };
    },
    recentFormDaily: async (days) => [{ date: '2026-03-25', tss: 100, ctl: 50, atl: 45, tsb: 5, _days: days }],
    monthlySummary: async (months) => [{ month: '2026-03', tss: 900, _months: months }],
    getAthleteState: async () => ({ athlete: { ftp_watts: 210, max_hr: 190, weight_kg: 65 }, configured: true }),
    getProfile: async () => ({ identity: '上班族骑手', goal: '200km 骑游' }),
    cyclingSummariesSince: async () => [],
    computeForm: async () => ({ ctl: 55, atl: 48 }),
    saveMemory: async (input, lang) => {
      if (!String(input.content ?? '').trim()) throw new Error('记忆内容不能为空');
      io._savedMemory = input; // 供断言 source 标记
      return 42;
    },
    applyFtpUpdate: async (lang) => {
      io._ftpUpdateLang = lang;
      return { applied: true, old_ftp_w: 210, new_ftp_w: 224, updated_at: '2026-03-25T10:00:00.000Z' };
    },
    reanalyzeActivity: async (name, lang) => {
      if (name !== 'a.fit') throw new Error(`训练库中找不到: ${name}`);
      io._reanalyze = { name, lang };
      return {
        ok: true, file_name: name, date: '2026-03-25', sport: 'cycling',
        ftp_used: 224, max_hr_used: 190, weight_used: 65,
        changes: { tss: { old: 120, new: 128 } }, form: { ctl: 55, atl: 48, tsb: 7 },
      };
    },
    ...overrides,
  };
  return io;
}

test('toolDefs：12 个工具、双语描述、schema 关键字段', () => {
  const zh = toolDefs('zh');
  assert.equal(zh.length, 12);
  const names = zh.map((d) => d.function.name);
  for (const n of ['list_activities', 'get_activity_summary', 'get_activity_records', 'get_form_series', 'get_monthly_summary', 'get_athlete_profile', 'estimate_ftp', 'simulate_form', 'generate_workout', 'save_memory', 'update_ftp', 'reanalyze_activity']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(zh.every((d) => d.type === 'function'), true);
  const en = toolDefs('en');
  assert.match(en[0].function.description, /catalog page/);
  assert.match(zh[0].function.description, /目录页/);
  // limit 描述注入 AGENTIC.list_limit
  const listDef = zh[0].function.parameters.properties.limit;
  assert.match(listDef.description, new RegExp(`最大 ${AGENTIC.list_limit}`));
  // save_memory 必填 content；simulate_form 必填 plan；reanalyze_activity 必填 file_name
  const byName = Object.fromEntries(zh.map((d) => [d.function.name, d]));
  assert.deepEqual(byName.save_memory.function.parameters.required, ['content']);
  assert.deepEqual(byName.reanalyze_activity.function.parameters.required, ['file_name']);
  assert.deepEqual(Object.keys(byName.update_ftp.function.parameters.properties), []); // 零参
});

test('list_activities：日期范围/运动/分类过滤 + limit 截断 + 非法日期报错', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const all = JSON.parse(await exec('list_activities', {}));
  assert.equal(all.count, 3);
  const ranged = JSON.parse(await exec('list_activities', { start_date: '2026-03-20', end_date: '2026-03-24' }));
  assert.equal(ranged.count, 1);
  assert.equal(ranged.activities[0].file_name, 'b.fit');
  const sport = JSON.parse(await exec('list_activities', { sport: 'running' }));
  assert.equal(sport.activities[0].file_name, 'c.fit');
  const cat = JSON.parse(await exec('list_activities', { category: 'race' }));
  assert.equal(cat.activities[0].file_name, 'a.fit');
  const limited = JSON.parse(await exec('list_activities', { limit: 999 }));
  assert.equal(limited.count, 3); // 夹到库里只有 3 条
  const bad = JSON.parse(await exec('list_activities', { start_date: '20260320' }));
  assert.match(bad.error, /start_date 需为 YYYY-MM-DD/);
});

test('get_activity_summary：压缩后返回；不存在与路径穿越报错', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const ok = JSON.parse(await exec('get_activity_summary', { file_name: 'a.fit' }));
  assert.equal(ok.power.np, 200);
  const missing = JSON.parse(await exec('get_activity_summary', { file_name: 'x.fit' }));
  assert.match(missing.error, /训练库中找不到: x\.fit/);
  const evil = JSON.parse(await exec('get_activity_summary', { file_name: '../../etc/passwd' }));
  assert.ok(evil.error); // safeName basename 校验拒绝
});

test('get_activity_records：抽稀 + 时间窗 + 时间戳本地化；不存在报错', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const ok = JSON.parse(await exec('get_activity_records', { file_name: 'a.fit', start_sec: 2, end_sec: 4 }));
  // 时间戳已改写为本地偏移表示（不再是 Z 结尾），时刻不变
  assert.ok(ok.points.length >= 1);
  assert.doesNotMatch(ok.points[0].t, /Z$/);
  const missing = JSON.parse(await exec('get_activity_records', { file_name: 'b.fit' }));
  assert.match(missing.error, /找不到时序数据: b\.fit/);
});

test('get_form_series / get_monthly_summary：days/months 传透', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const form = JSON.parse(await exec('get_form_series', { days: 90 }));
  assert.equal(form.days, 90);
  assert.equal(form.series[0]._days, 90);
  const monthly = JSON.parse(await exec('get_monthly_summary', { months: 12 }));
  assert.equal(monthly.months, 12);
  assert.equal(monthly.summary[0]._months, 12);
});

test('get_athlete_profile：骑手参数 + 身份目标', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const p = JSON.parse(await exec('get_athlete_profile', {}));
  assert.deepEqual(p.athlete, { ftp_watts: 210, max_hr: 190, weight_kg: 65 });
  assert.equal(p.athlete_configured, true);
  assert.equal(p.identity, '上班族骑手');
  assert.equal(p.goal, '200km 骑游');
});

test('estimate_ftp：数据不足时返回 insufficient 结构（不报错）', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const r = JSON.parse(await exec('estimate_ftp', {}));
  assert.equal(r.status, 'insufficient'); // 假库无骑行数据
});

test('simulate_form：plan 清洗（排序/tss 夹取）、起始值缺省读库、参数错误兜 {error}', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const ok = JSON.parse(await exec('simulate_form', {
    plan: [{ date: '2026-04-02', tss: 99999 }, { date: '2026-04-01', tss: -50 }],
  }));
  // 起始值缺省取 io.computeForm(today)
  assert.deepEqual(ok.start, { ctl: 55, atl: 48 });
  assert.equal(ok.projection.length, 2);
  assert.equal(ok.projection[0][0], '2026-04-01'); // 按日期排序
  assert.equal(ok.projection[1][0], '2026-04-02');
  // tss 夹到 0–1000
  const day1 = JSON.parse(await exec('simulate_form', { plan: [{ date: '2026-04-01', tss: -50 }], start_ctl: 50, start_atl: 40 }));
  assert.equal(day1.start.ctl, 50); // 显式给起始值时不读库
  const bad = [
    { args: { plan: [] }, msg: /plan 需为非空数组/ },
    { args: { plan: Array.from({ length: 61 }, (_, i) => ({ date: '2026-04-01', tss: 0 })) }, msg: /plan 最多 60 天/ },
    { args: { plan: [{ date: '20260401', tss: 0 }] }, msg: /plan 中 date 需为 YYYY-MM-DD/ },
    { args: { plan: [{ date: '2026-04-01', tss: 'x' }] }, msg: /plan 中 tss 需为数值/ },
  ];
  for (const { args, msg } of bad) {
    const r = JSON.parse(await exec('simulate_form', args));
    assert.match(r.error, msg);
  }
});

test('generate_workout：FTP 取生效骑手参数；时长非法兜 {error}', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const ok = JSON.parse(await exec('generate_workout', { target: 'threshold', duration_minutes: 75 }));
  assert.equal(ok.ftp_watts, 210);
  assert.deepEqual(ok.main_sets.power_watts, [200, 221]); // 95–105% × 210W
  const bad = JSON.parse(await exec('generate_workout', { target: 'threshold', duration_minutes: 'abc' }));
  assert.match(bad.error, /duration_minutes 需为 15–300 的整数/);
  // 超下限的数值被夹到 15（clampInt 口径），装不下间歇课时报"时长不足"
  const clamped = JSON.parse(await exec('generate_workout', { target: 'threshold', duration_minutes: 5 }));
  assert.match(clamped.error, /15 分钟装不下 阈值 课表/);
});

test('save_memory：source 场景标记写入、错误兜 {error} 不抛异常', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { source: 'chat', lang: 'zh' });
  const ok = JSON.parse(await exec('save_memory', { content: '7 月参加环千岛湖', category: 'goal' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.memory_id, 42);
  assert.equal(io._savedMemory.source, 'chat'); // 场景标记随 ctx 注入
  const empty = JSON.parse(await exec('save_memory', { content: '' }));
  assert.match(empty.error, /记忆内容不能为空/); // db 层双语 Error 被兜为 {error}
});

test('update_ftp：零参透传编排层结果，lang 随 ctx 注入；en 场景同构', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { lang: 'zh' });
  const ok = JSON.parse(await exec('update_ftp', {}));
  assert.equal(ok.applied, true);
  assert.equal(ok.new_ftp_w, 224);
  assert.equal(io._ftpUpdateLang, 'zh');
  const ioEn = fakeIo();
  await createExecuteTool(ioEn, { lang: 'en' })('update_ftp', {});
  assert.equal(ioEn._ftpUpdateLang, 'en');
  // 传了参数也不影响（零参工具，多余键被忽略）
  const ignored = JSON.parse(await exec('update_ftp', { ftp_watts: 999 }));
  assert.equal(ignored.applied, true);
});

test('reanalyze_activity：file_name 校验/路径穿越拒绝；不存在兜 {error}；成功返回新旧对比', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { lang: 'zh' });
  const ok = JSON.parse(await exec('reanalyze_activity', { file_name: 'a.fit' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.ftp_used, 224);
  assert.equal(ok.changes.tss.old, 120);
  assert.equal(ok.changes.tss.new, 128);
  assert.equal(io._reanalyze.lang, 'zh');
  const missing = JSON.parse(await exec('reanalyze_activity', { file_name: 'x.fit' }));
  assert.match(missing.error, /工具执行失败: 训练库中找不到: x\.fit/);
  const evil = JSON.parse(await exec('reanalyze_activity', { file_name: '../etc/passwd' }));
  assert.match(evil.error, /file_name 非法/);
});

test('executeTool：未知工具与执行异常均返回 {error}', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const unknown = JSON.parse(await exec('no_such_tool', {}));
  assert.match(unknown.error, /未知工具: no_such_tool/);
  const throwing = createExecuteTool(fakeIo({ listActivities: async () => { throw new Error('boom'); } }), { lang: 'zh' });
  const failed = JSON.parse(await throwing('list_activities', {}));
  assert.match(failed.error, /工具执行失败: boom/);
});

test('结果超长截断：超 AGENTIC.tool_result_max_chars 附截断标记', async () => {
  const big = 'x'.repeat(AGENTIC.tool_result_max_chars + 100);
  const exec = createExecuteTool(fakeIo({ getActivitySummary: async () => ({ blob: big }) }), { lang: 'zh' });
  const raw = await exec('get_activity_summary', { file_name: 'a.fit' });
  assert.ok(raw.length <= AGENTIC.tool_result_max_chars + '（结果已截断）'.length);
  assert.ok(raw.endsWith('（结果已截断）'));
});

test('get_activity_records：60s 全秒窄窗不截断（逐秒核对暂停时刻的可用性，截断放宽回归）', async () => {
  // 60 秒逐秒数据（< records_max_points 抽稀线 → 全秒返回）；旧 4000 上限时这种窗
  // 也会被硬切（roadmap 2026-09-25 留档：逐秒核对暂停时刻基本不可用）
  const points = Array.from({ length: 60 }, (_, i) => ({
    t: `2026-03-25T03:10:${String(i).padStart(2, '0')}.000Z`,
    power: i < 20 ? 0 : 200,
    heart_rate: 140,
    cadence: i < 20 ? 0 : 90,
    altitude: 100,
    speed: i < 20 ? 0.5 : 25,
    distance_m: i * 7,
    temperature: null,
  }));
  const io = fakeIo({ loadRecords: async () => ({ points, total_seconds: points.length, stride: 1 }) });
  const exec = createExecuteTool(io, { lang: 'zh' });
  const raw = await exec('get_activity_records', { file_name: 'a.fit', start_sec: 0, end_sec: 59 });
  assert.ok(raw.length > 4000, '60s 全秒窗应超旧 4000 上限（证明放宽实际生效）');
  const parsed = JSON.parse(raw); // 截断标记会破坏 JSON——能 parse 即未截断
  assert.equal(parsed.points.length, 60);
  assert.ok(raw.length <= AGENTIC.tool_result_max_chars + '（结果已截断）'.length);
});

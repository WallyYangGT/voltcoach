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
const { emptyProfile, normalizeProfilePatch } = await import('../src/core/profile.ts');

/** 活动 uuid 夹具（工具层只认 32 hex） */
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const X = 'f'.repeat(32);

/** 内存版 ToolIo（最小数据集，按需覆写） */
function fakeIo(overrides = {}) {
  const io = {
    listActivities: async () => [
      { uuid: A, file_name: 'a.fit', date: '2026-03-25', sport: 'cycling', category: 'race', duration_sec: 3600, distance_km: 90, tss: 120, np: 200, intensity_factor: 0.9 },
      { uuid: B, file_name: 'b.fit', date: '2026-03-20', sport: 'cycling', category: 'training', duration_sec: 5400, distance_km: 120, tss: 90, np: 160, intensity_factor: 0.75 },
      { uuid: C, file_name: 'c.fit', date: '2026-03-18', sport: 'running', category: 'training', duration_sec: 1800, distance_km: 15, tss: 30, np: null, intensity_factor: null },
    ],
    getActivitySummary: async (id) =>
      id === A
        ? { activity: { date: '2026-03-25', category: 'race' }, power: { np: 200, tss: 120 }, anomalies: [] }
        : null,
    loadRecords: async (id, opts) => {
      if (id !== A) return null;
      // 10 秒数据，stride 按 maxPoints 推算
      const points = Array.from({ length: 10 }, (_, i) => ({
        t: `2026-03-25T03:00:${String(i).padStart(2, '0')}.000Z`,
        power: 200 + i, heart_rate: 140, cadence: 90, altitude: 100, speed: 25, distance_m: i * 7, temperature: null,
      }));
      const stride = Math.max(1, Math.ceil(points.length / opts.maxPoints));
      return { points: points.filter((_, i) => i % stride === 0), total_seconds: points.length, stride };
    },
    // 默认无首帧 → 日期保持 UTC 原值；覆写以验证本地日历日换算（双口径统一）
    readRecordStart: async () => null,
    recentFormDaily: async (days) => [{ date: '2026-03-25', tss: 100, ctl: 50, atl: 45, tsb: 5, _days: days }],
    monthlySummary: async (months) => [{ month: '2026-03', tss: 900, _months: months }],
    getAthleteState: async () => ({ athlete: { ftp_watts: 210, max_hr: 190, weight_kg: 65 }, configured: true }),
    getProfile: async () => ({
      identity: '上班族骑手',
      goal: '200km 骑游',
      ...(io._profile ?? {}),
    }),
    setRiderProfile: async (partial, lang) => {
      const current =
        io._profile ??
        normalizeProfilePatch(emptyProfile(), { identity: '上班族骑手', goal: '200km 骑游' });
      io._profile = normalizeProfilePatch(current, partial, lang);
      return io._profile;
    },
    cyclingSummariesSince: async () => [],
    computeForm: async (date) => {
      io._formDate = date; // 供断言缺省起点用的「今天」口径
      return { ctl: 55, atl: 48 };
    },
    saveMemory: async (input, lang) => {
      if (!String(input.content ?? '').trim()) throw new Error('记忆内容不能为空');
      io._savedMemory = input; // 供断言 source 标记
      return 42;
    },
    applyFtpUpdate: async (lang) => {
      io._ftpUpdateLang = lang;
      return { applied: true, old_ftp_w: 210, new_ftp_w: 224, updated_at: '2026-03-25T10:00:00.000Z' };
    },
    getDossier: async () => io._dossier ?? null,
    setPowerFlag: async (id, flagged, lang, reason) => {
      io._powerFlag = { id, flagged, lang, reason };
      return { ok: true, uuid: id, file_name: 'a.fit', flagged, reason, dossier_updated: true };
    },
    recalibratePower: async (id, scale, lang) => {
      if (id !== A) throw new Error(`训练库中找不到: ${id}`);
      io._recalibrated = { id, scale, lang };
      return { ok: true, uuid: id, file_name: 'a.fit', scale, changes: { np: { old: 200, new: 210 } } };
    },
    reanalyzeActivity: async (id, lang) => {
      if (id !== A) throw new Error(`训练库中找不到: ${id}`);
      io._reanalyze = { id, lang };
      return {
        ok: true, uuid: id, file_name: 'a.fit', date: '2026-03-25', sport: 'cycling',
        ftp_used: 224, max_hr_used: 190, weight_used: 65,
        changes: { tss: { old: 120, new: 128 } }, form: { ctl: 55, atl: 48, tsb: 7 },
      };
    },
    ...overrides,
  };
  return io;
}

test('toolDefs：19 个工具、双语描述、schema 关键字段', () => {
  const zh = toolDefs('zh');
  assert.equal(zh.length, 19);
  const names = zh.map((d) => d.function.name);
  for (const n of ['list_activities', 'get_activity_summary', 'get_activity_records', 'get_form_series', 'get_monthly_summary', 'get_athlete_profile', 'update_rider_profile', 'estimate_ftp', 'simulate_form', 'generate_workout', 'save_memory', 'get_dossier', 'get_training_plan', 'update_training_plan', 'adjust_plan_sessions', 'set_power_flag', 'recalibrate_activity_power', 'update_ftp', 'reanalyze_activity']) {
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
  assert.deepEqual(byName.save_memory.function.parameters.properties.category.enum, ['general', 'injury', 'schedule', 'goal', 'preference', 'strategy']);
  assert.deepEqual(byName.save_memory.function.parameters.properties.scope.enum, ['short', 'long']);
  // 短期失效口径（两周/5 次，2026-10-13 放宽）zh/en 双语同步——告知模型的分层规则
  // 必须与 core/memory.ts 判定实现一致（code-review P2-1：en 侧曾漏改）
  assert.match(byName.save_memory.function.parameters.properties.scope.description, /两周或 5 次训练/);
  // update_rider_profile：清空语义可由 schema 表达（空串清枚举、0 清单次上限）
  assert.deepEqual(byName.update_rider_profile.function.parameters.properties.coach_mode.enum, ['', 'amateur', 'standard']);
  assert.deepEqual(byName.update_rider_profile.function.parameters.properties.weekly_hours.enum, ['', 'lt3', '3to5', '5to8', 'gt8']);
  assert.equal(byName.update_rider_profile.function.parameters.properties.session_max_min.minimum, 0);
  const enByName = Object.fromEntries(en.map((d) => [d.function.name, d]));
  assert.match(enByName.save_memory.function.parameters.properties.scope.description, /two weeks or 5 activities/);
  assert.deepEqual(byName.reanalyze_activity.function.parameters.required, ['activity_id']);
  assert.deepEqual(byName.set_power_flag.function.parameters.required, ['activity_id', 'flagged']);
  assert.deepEqual(byName.recalibrate_activity_power.function.parameters.required, ['activity_id', 'scale_factor']);
  assert.deepEqual(byName.update_training_plan.function.parameters.required, ['plan']);
  assert.deepEqual(byName.adjust_plan_sessions.function.parameters.required, ['ops']);
  assert.match(byName.adjust_plan_sessions.function.description, /肯定答复/); // 确认落实协议进工具描述
  assert.deepEqual(Object.keys(byName.update_ftp.function.parameters.properties), []); // 零参
  assert.deepEqual(Object.keys(byName.get_dossier.function.parameters.properties), []); // 零参
  assert.deepEqual(Object.keys(byName.get_training_plan.function.parameters.properties), []); // 零参
});

test('list_activities：日期范围/运动/分类过滤 + limit 截断 + 非法日期报错', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const all = JSON.parse(await exec('list_activities', {}));
  assert.equal(all.count, 3);
  // 模型句柄字段名与工具入参一致：activity_id（内部 uuid 不外露）
  assert.equal(all.activities[0].activity_id, A);
  assert.equal(all.activities[0].uuid, undefined);
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

  // 双口径统一：返回行的 date 换算为本地日历日（有首帧的行），无首帧保持 UTC 原值。
  // 时区无关断言：预期值用 Date 本地分量现算（20:00Z 在 +8 已是次日，CI=UTC 仍是同日）
  const expectDay = (utcText) => {
    const d = new Date(Date.parse(utcText));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const ioTz = fakeIo({ readRecordStart: async (id) => (id === A ? '2026-03-25T20:00:00Z' : null) });
  const localized = JSON.parse(await createExecuteTool(ioTz, { lang: 'zh' })('list_activities', {}));
  assert.equal(localized.activities.find((a) => a.file_name === 'a.fit').date, expectDay('2026-03-25T20:00:00Z'));
  assert.equal(localized.activities.find((a) => a.file_name === 'b.fit').date, '2026-03-20');
});

test('get_activity_summary：压缩后返回；不存在与路径穿越报错', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const ok = JSON.parse(await exec('get_activity_summary', { activity_id: A }));
  assert.equal(ok.power.np, 200);
  const missing = JSON.parse(await exec('get_activity_summary', { activity_id: X }));
  assert.match(missing.error, new RegExp(`训练库中找不到: ${X}`));
  const evil = JSON.parse(await exec('get_activity_summary', { activity_id: 'not-a-uuid' }));
  assert.match(evil.error, /activity_id 非法/);

  // 双口径统一：activity.date 按首帧时刻换算为本地日历日（时区无关断言同 list_activities）
  const expectDay = (utcText) => {
    const d = new Date(Date.parse(utcText));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const ioTz = fakeIo({ readRecordStart: async () => '2026-03-25T20:00:00Z' });
  const okTz = JSON.parse(await createExecuteTool(ioTz, { lang: 'zh' })('get_activity_summary', { activity_id: A }));
  assert.equal(okTz.activity.date, expectDay('2026-03-25T20:00:00Z'));
});

test('get_activity_records：抽稀 + 时间窗 + 时间戳本地化；不存在报错', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const ok = JSON.parse(await exec('get_activity_records', { activity_id: A, start_sec: 2, end_sec: 4 }));
  // 时间戳已改写为本地偏移表示（不再是 Z 结尾），时刻不变
  assert.ok(ok.points.length >= 1);
  assert.doesNotMatch(ok.points[0].t, /Z$/);
  const missing = JSON.parse(await exec('get_activity_records', { activity_id: B }));
  assert.match(missing.error, new RegExp(`找不到时序数据: ${B}`));
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

test('get_athlete_profile：骑手参数 + 身份目标 + 教练模式/时间预算字段', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const p = JSON.parse(await exec('get_athlete_profile', {}));
  assert.deepEqual(p.athlete, { ftp_watts: 210, max_hr: 190, weight_kg: 65 });
  assert.equal(p.athlete_configured, true);
  assert.equal(p.identity, '上班族骑手');
  assert.equal(p.goal, '200km 骑游');
  // 未设置时显式 null/[]（模型据 coach_mode_configured 决定是否首次询问）
  assert.equal(p.coach_mode, null);
  assert.equal(p.coach_mode_configured, false);
  assert.equal(p.weekly_hours, null);
  assert.deepEqual(p.available_days, []);
  assert.equal(p.session_max_min, null);
});

test('update_rider_profile：仅对话放行、至少一项、白名单字段、校验错误兜 {error}', async () => {
  const io = fakeIo();
  // 报告生成场景（无 chat 标记）拒绝
  const reportExec = createExecuteTool(io, { lang: 'zh', source: 'plan' });
  const denied = JSON.parse(await reportExec('update_rider_profile', { coach_mode: 'amateur' }));
  assert.match(denied.error, /只能在对话中修改/);

  const exec = createExecuteTool(io, { lang: 'zh', chat: true });
  const empty = JSON.parse(await exec('update_rider_profile', {}));
  assert.match(empty.error, /至少提供一项/);
  // 未知字段被白名单丢弃 → 等同空
  const unknown = JSON.parse(await exec('update_rider_profile', { foo: 1 }));
  assert.match(unknown.error, /至少提供一项/);

  const ok = JSON.parse(
    await exec('update_rider_profile', {
      coach_mode: 'amateur',
      weekly_hours: '3to5',
      available_days: [1, 3, 3, 7],
      session_max_min: 90,
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.coach_mode, 'amateur');
  assert.equal(ok.weekly_hours, '3to5');
  assert.deepEqual(ok.available_days, [1, 3, 7]);
  assert.equal(ok.session_max_min, 90);
  // 回读一致
  const read = JSON.parse(await exec('get_athlete_profile', {}));
  assert.equal(read.coach_mode, 'amateur');
  assert.equal(read.coach_mode_configured, true);
  assert.equal(read.weekly_hours, '3to5');
  assert.deepEqual(read.available_days, [1, 3, 7]);
  assert.equal(read.session_max_min, 90);

  // 枚举非法经 core/profile 抛双语 Error，工具层兜为 {error}
  const bad = JSON.parse(await exec('update_rider_profile', { weekly_hours: '2h' }));
  assert.match(bad.error, /weekly_hours 取值非法/);
});

test('update_rider_profile：部分更新不清空其他字段；空串/0/空数组清空语义', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh', chat: true });
  await exec('update_rider_profile', {
    coach_mode: 'amateur',
    weekly_hours: '5to8',
    available_days: [1, 4],
    session_max_min: 120,
  });
  // 只改每周时长档：其余教练字段与身份/目标保持
  const partial = JSON.parse(await exec('update_rider_profile', { weekly_hours: '3to5' }));
  assert.equal(partial.coach_mode, 'amateur');
  assert.equal(partial.weekly_hours, '3to5');
  assert.deepEqual(partial.available_days, [1, 4]);
  assert.equal(partial.session_max_min, 120);
  const read = JSON.parse(await exec('get_athlete_profile', {}));
  assert.equal(read.identity, '上班族骑手');
  assert.equal(read.goal, '200km 骑游');

  // 清空：空串清模式/时长档，0 清单次上限，空数组清可用日
  const cleared = JSON.parse(
    await exec('update_rider_profile', {
      coach_mode: '',
      weekly_hours: '',
      session_max_min: 0,
      available_days: [],
    }),
  );
  assert.equal(cleared.coach_mode, null);
  assert.equal(cleared.weekly_hours, null);
  assert.equal(cleared.session_max_min, null);
  assert.deepEqual(cleared.available_days, []);
  const reRead = JSON.parse(await exec('get_athlete_profile', {}));
  assert.equal(reRead.coach_mode, null);
  assert.equal(reRead.coach_mode_configured, false);
  assert.equal(reRead.identity, '上班族骑手'); // 清空教练字段不影响身份目标
});

test('estimate_ftp：数据不足时返回 insufficient 结构（不报错）', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const r = JSON.parse(await exec('estimate_ftp', {}));
  assert.equal(r.status, 'insufficient'); // 假库无骑行数据
});

test('simulate_form：业余模式用放宽阈值（同计划标准报风险、业余不报）', async () => {
  const plan14 = Array.from({ length: 14 }, (_, i) => ({ date: day(i), tss: 90 }));
  const std = JSON.parse(
    await createExecuteTool(fakeIo(), { lang: 'zh' })('simulate_form', {
      plan: plan14,
      start_ctl: 50,
      start_atl: 100,
    }),
  );
  assert.ok(std.risk_flags.some((f) => f.type === 'tsb_low_sustained'));
  const amateurIo = fakeIo({
    getProfile: async () => ({ identity: '', goal: '', coach_mode: 'amateur' }),
  });
  const am = JSON.parse(
    await createExecuteTool(amateurIo, { lang: 'zh' })('simulate_form', {
      plan: plan14,
      start_ctl: 50,
      start_atl: 100,
    }),
  );
  assert.equal(am.risk_flags.some((f) => f.type === 'tsb_low_sustained'), false);
  // 档案读取失败按标准阈值降级（工具不因档案异常失败）
  const brokenIo = fakeIo({
    getProfile: async () => {
      throw new Error('db down');
    },
  });
  const broken = JSON.parse(
    await createExecuteTool(brokenIo, { lang: 'zh' })('simulate_form', {
      plan: plan14,
      start_ctl: 50,
      start_atl: 100,
    }),
  );
  assert.ok(broken.risk_flags.some((f) => f.type === 'tsb_low_sustained'));
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
  // 超下限的数值被夹到 15（clampInt 口径），连短课版也装不下时报"时长不足"
  const clamped = JSON.parse(await exec('generate_workout', { target: 'threshold', duration_minutes: 5 }));
  assert.match(clamped.error, /15 分钟连短课版也装不下/);
});

test('save_memory：source 场景标记写入、错误兜 {error} 不抛异常', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { source: 'chat', lang: 'zh' });
  const ok = JSON.parse(await exec('save_memory', { content: '7 月参加环千岛湖', category: 'goal' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.memory_id, 42);
  assert.equal(io._savedMemory.source, 'chat'); // 场景标记随 ctx 注入
  assert.equal(io._savedMemory.scope, undefined); // 未传 scope 不臆造
  const empty = JSON.parse(await exec('save_memory', { content: '' }));
  assert.match(empty.error, /记忆内容不能为空/); // db 层双语 Error 被兜为 {error}
});

test('save_memory：scope 短期透传', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { source: 'chat', lang: 'zh' });
  await exec('save_memory', { content: '本周三出差', scope: 'short' });
  assert.equal(io._savedMemory.scope, 'short');
});

test('get_dossier：档案透传；空库返回 dossier_empty 错误', async () => {
  const io = fakeIo();
  io._dossier = { anchor_date: '2026-10-01', peak_power: { all_time: [] } };
  const exec = createExecuteTool(io, { lang: 'zh' });
  const ok = JSON.parse(await exec('get_dossier', {}));
  assert.equal(ok.anchor_date, '2026-10-01');
  const empty = createExecuteTool(fakeIo(), { lang: 'zh' });
  const err = JSON.parse(await empty('get_dossier', {}));
  assert.match(err.error, /暂无骑行数据/);
});

test('本地日口径（双口径统一）：save_memory 返回 date、simulate_form 缺省起点、get_dossier 锚日与周界', async () => {
  const { localDay } = await import('../src/core/local-day.ts');
  const { addDaysStr } = await import('../src/core/dossier.ts');
  // save_memory 返回 date 为本地日历日（清晨写入不再向模型报告「昨天」）
  const saved = JSON.parse(
    await createExecuteTool(fakeIo(), { lang: 'zh' })('save_memory', { content: '目标环千岛湖' }),
  );
  assert.equal(saved.date, localDay());
  // simulate_form 缺省起点读的是本地「今天」的库内快照
  const ioForm = fakeIo();
  await createExecuteTool(ioForm, { lang: 'zh' })('simulate_form', { plan: [{ date: '2026-04-01', tss: 60 }] });
  assert.equal(ioForm._formDate, localDay());

  // get_dossier：锚日与 8 周周界按锚骑行首帧换算为本地日历日（周界结构保持连续、锚日收尾）
  const expectDay = (utcText) => {
    const d = new Date(Date.parse(utcText));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const anchor = '2026-03-25';
  const ioDos = fakeIo({
    getDossier: async () => ({
      anchor_date: anchor,
      load_shape: {
        weeks: Array.from({ length: 3 }, (_, i) => ({
          start: addDaysStr(anchor, -7 * i - 6),
          end: addDaysStr(anchor, -7 * i),
          tss: 100,
          duration_sec: 3600,
          rides: 2,
        })),
      },
    }),
    readRecordStart: async () => '2026-03-25T20:00:00Z',
  });
  const out = JSON.parse(await createExecuteTool(ioDos, { lang: 'zh' })('get_dossier', {}));
  const localAnchor = expectDay('2026-03-25T20:00:00Z');
  assert.equal(out.anchor_date, localAnchor);
  assert.equal(out.load_shape.weeks[0].end, localAnchor);
  assert.equal(out.load_shape.weeks[0].start, addDaysStr(localAnchor, -6));
  assert.equal(out.load_shape.weeks[2].end, addDaysStr(localAnchor, -14));
  // 无首帧（readRecordStart 缺省 null）：锚日与周界保持 UTC 原值
  const ioPlain = fakeIo({
    getDossier: async () => ({ anchor_date: anchor, load_shape: { weeks: [{ start: addDaysStr(anchor, -6), end: anchor }] } }),
  });
  const plain = JSON.parse(await createExecuteTool(ioPlain, { lang: 'zh' })('get_dossier', {}));
  assert.equal(plain.anchor_date, anchor);
  assert.equal(plain.load_shape.weeks[0].end, anchor);
});

test('set_power_flag：布尔校验、reason 截断透传；activity_id 形状拒绝', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { lang: 'zh' });
  const ok = JSON.parse(await exec('set_power_flag', { activity_id: A, flagged: true, reason: 'x'.repeat(500) }));
  assert.equal(ok.ok, true);
  assert.equal(io._powerFlag.flagged, true);
  assert.equal(io._powerFlag.reason.length, 200); // 截到 200 字
  const notBool = JSON.parse(await exec('set_power_flag', { activity_id: A, flagged: 'yes' }));
  assert.match(notBool.error, /flagged 需为布尔值/);
  const trav = JSON.parse(await exec('set_power_flag', { activity_id: 'not-a-uuid', flagged: true }));
  assert.match(trav.error, /activity_id 非法/);
});

test('recalibrate_activity_power：数值校验、透传服务层；训练不存在兜 {error}', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { lang: 'zh' });
  const ok = JSON.parse(await exec('recalibrate_activity_power', { activity_id: A, scale_factor: 1.05 }));
  assert.equal(ok.ok, true);
  assert.equal(io._recalibrated.scale, 1.05);
  const notNum = JSON.parse(await exec('recalibrate_activity_power', { activity_id: A, scale_factor: 'abc' }));
  assert.match(notNum.error, /scale_factor 需为数值/);
  const missing = JSON.parse(await exec('recalibrate_activity_power', { activity_id: 'e'.repeat(32), scale_factor: 1.05 }));
  assert.match(missing.error, /训练库中找不到/);
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

test('reanalyze_activity：activity_id 形状校验；不存在兜 {error}；成功返回新旧对比', async () => {
  const io = fakeIo();
  const exec = createExecuteTool(io, { lang: 'zh' });
  const ok = JSON.parse(await exec('reanalyze_activity', { activity_id: A }));
  assert.equal(ok.ok, true);
  assert.equal(ok.ftp_used, 224);
  assert.equal(ok.changes.tss.old, 120);
  assert.equal(ok.changes.tss.new, 128);
  assert.equal(io._reanalyze.lang, 'zh');
  const missing = JSON.parse(await exec('reanalyze_activity', { activity_id: X }));
  assert.match(missing.error, new RegExp(`工具执行失败: 训练库中找不到: ${X}`));
  const evil = JSON.parse(await exec('reanalyze_activity', { activity_id: 'not-a-uuid' }));
  assert.match(evil.error, /activity_id 非法/);
});

test('executeTool：未知工具与执行异常均返回 {error}', async () => {
  const exec = createExecuteTool(fakeIo(), { lang: 'zh' });
  const unknown = JSON.parse(await exec('no_such_tool', {}));
  assert.match(unknown.error, /未知工具: no_such_tool/);
  const throwing = createExecuteTool(fakeIo({ listActivities: async () => { throw new Error('boom'); } }), { lang: 'zh' });
  const failed = JSON.parse(await throwing('list_activities', {}));
  assert.match(failed.error, /工具执行失败: boom/);
});

test('结果超长：结构化降级为合法 JSON（长文本截短 + _truncated 元信息）', async () => {
  const big = 'x'.repeat(AGENTIC.tool_result_max_chars + 100);
  const exec = createExecuteTool(fakeIo({ getActivitySummary: async () => ({ blob: big }) }), { lang: 'zh' });
  const raw = await exec('get_activity_summary', { activity_id: A });
  assert.ok(raw.length <= AGENTIC.tool_result_max_chars, `len=${raw.length}`);
  const parsed = JSON.parse(raw); // 能 parse 即未从中间切坏
  assert.ok(parsed.blob.length < big.length);
  assert.equal(parsed._truncated.original_chars, JSON.stringify({ blob: big }).length);
  assert.match(parsed._truncated.note, /结果超限已压缩/);
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
  const raw = await exec('get_activity_records', { activity_id: A, start_sec: 0, end_sec: 59 });
  assert.ok(raw.length > 4000, '60s 全秒窗应超旧 4000 上限（证明放宽实际生效）');
  const parsed = JSON.parse(raw); // 截断标记会破坏 JSON——能 parse 即未截断
  assert.equal(parsed.points.length, 60);
  assert.ok(raw.length <= AGENTIC.tool_result_max_chars + '（结果已截断）'.length);
});

// ---------------- 训练计划工具（get_training_plan / update_training_plan） ----------------

const { localDay } = await import('../src/core/local-day.ts');

/** 相对今天偏移 n 天的本地日历日（计划窗夹住今天，有效期判定确定化） */
const day = (offset) =>
  new Date(Date.parse(localDay() + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

/** 课次夹具 */
const pSession = (date, type = 'endurance', duration_min = 60, extra = {}) => ({
  date, type, duration_min, intensity: null, tss: null, note: null, ...extra,
});

/** 两周计划窗夹具（valid_to 相对 today +13，恒为 valid 态） */
const planObj = (sessions) => ({
  valid_from: day(-1),
  valid_to: day(13),
  goal: '有氧基础',
  sessions,
});

test('get_training_plan：无计划返回 has_plan=false；有计划回有效态/课次/来源', async () => {
  const none = createExecuteTool(fakeIo({ getTrainingPlan: async () => null }), { lang: 'zh' });
  assert.deepEqual(JSON.parse(await none('get_training_plan', {})), { has_plan: false });

  const stored = {
    origin: 'generate',
    created_at: '2026-10-13T08:00:00.000Z',
    plan: {
      valid_from: day(-1),
      valid_to: day(13),
      goal: '有氧基础',
      sessions: [pSession(day(0), 'threshold', 60, { tss: 100 })],
    },
  };
  const exec = createExecuteTool(fakeIo({ getTrainingPlan: async () => stored }), { lang: 'zh' });
  const out = JSON.parse(await exec('get_training_plan', {}));
  assert.equal(out.has_plan, true);
  assert.equal(out.state, 'valid');
  assert.equal(out.goal, '有氧基础');
  assert.equal(out.origin, 'generate');
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].tss, 100);

  // 满额课次载荷裁剪后不越 16k 截断线（截断标记会把 JSON 从中间切坏——code-review P2-3）
  const fat = {
    origin: 'generate',
    created_at: '2026-10-13T08:00:00.000Z',
    plan: {
      valid_from: day(-1),
      valid_to: day(40),
      goal: 'g'.repeat(200),
      sessions: Array.from({ length: 42 }, (_, i) => ({
        date: day(i),
        type: 'endurance',
        duration_min: 60,
        intensity: 'i'.repeat(80),
        tss: 68,
        note: 'n'.repeat(200),
      })),
    },
  };
  const raw = await createExecuteTool(fakeIo({ getTrainingPlan: async () => fat }), { lang: 'zh' })('get_training_plan', {});
  assert.ok(raw.length < AGENTIC.tool_result_max_chars, `载荷 ${raw.length} 应在截断线内`);
  const parsed = JSON.parse(raw); // 能 parse 即未被截断破坏
  assert.equal(parsed.sessions.length, 42);
  assert.ok(parsed.sessions[0].note.length <= 60);
  assert.ok(parsed.sessions[0].intensity.length <= 40);
});

test('update_training_plan：非对话类调用拒写（报告场景名与会话模式名都可能是 plan，以 chat 标记区分）', async () => {
  const io = fakeIo({});
  io.savePlanVersion = async () => {
    throw new Error('不应落库');
  };
  for (const source of ['review', 'plan', 'taper', 'compare', null]) {
    const raw = await createExecuteTool(io, { source, lang: 'zh' })('update_training_plan', {
      plan: planObj([pSession(day(0))]),
    });
    assert.match(JSON.parse(raw).error, /只能在对话中调整/);
  }
});

test('update_training_plan：格式硬错返回 error；合理性违规 adjust 档硬拒并附原因与提示', async () => {
  const io = fakeIo({});
  io.savePlanVersion = async () => {
    throw new Error('不应落库');
  };
  const exec = createExecuteTool(io, { source: 'plan', chat: true, lang: 'zh' });

  const badDate = JSON.parse(await exec('update_training_plan', { plan: { valid_from: 'nope' } }));
  assert.match(badDate.error, /YYYY-MM-DD/);

  const clash = JSON.parse(
    await exec('update_training_plan', {
      plan: planObj([pSession(day(0), 'threshold', 60), pSession(day(1), 'threshold', 60)]),
      change_note: '连上两天质量课',
    }),
  );
  assert.equal(clash.ok, false);
  assert.match(clash.violations[0], /48h/);
  assert.match(clash.hint, /替代调整方案/);
});

test('update_training_plan：合规调整落库——TSS 回填/rest 归零/change_note 裁剪/返回总版本数', async () => {
  const io = fakeIo({});
  let saved = null;
  io.savePlanVersion = async (plan, meta) => {
    saved = { plan, meta };
    return 2;
  };
  const exec = createExecuteTool(io, { source: 'plan', chat: true, lang: 'zh' });
  const out = JSON.parse(
    await exec('update_training_plan', {
      plan: planObj([pSession(day(0), 'threshold', 60), pSession(day(2), 'rest', null)]),
      change_note: '  微调周节奏  ',
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.versions_total, 2);
  assert.equal(out.sessions, 2);
  assert.equal(out.note, '微调周节奏');
  assert.equal(saved.meta.origin, 'adjust');
  assert.equal(saved.plan.sessions[0].tss, 100); // 缺失回填：阈值 60min
  assert.equal(saved.plan.sessions[1].tss, 0); // rest 课负荷归零
});

test('update_training_plan：业余模式软约束只回传 warnings，不硬拒（超出只提示）', async () => {
  const io = fakeIo({
    getProfile: async () => ({
      identity: '',
      goal: '保持健康',
      coach_mode: 'amateur',
      weekly_hours: '3to5',
      available_days: [],
      session_max_min: 60,
    }),
  });
  let saved = null;
  io.savePlanVersion = async (plan, meta) => {
    saved = { plan, meta };
    return 2;
  };
  const exec = createExecuteTool(io, { source: 'plan', chat: true, lang: 'zh' });
  // 三节质量课放进同一个自然周（下周一/三/五），保证周质量课上限提示稳定出现
  const dow = new Date(localDay() + 'T00:00:00Z').getUTCDay(); // 0=周日
  const nextMon = ((1 - dow + 7) % 7) || 7;
  const out = JSON.parse(
    await exec('update_training_plan', {
      plan: planObj([
        pSession(day(nextMon), 'threshold', 90),
        pSession(day(nextMon + 2), 'sweet_spot', 90),
        pSession(day(nextMon + 4), 'threshold', 90),
      ]),
      change_note: '业余三节质量课',
    }),
  );
  assert.equal(out.ok, true); // 软约束不阻断
  assert.equal(out.violations, undefined);
  // 1 条周质量课上限 + 3 条单课超时
  assert.equal(out.warnings.length, 4);
  assert.equal(saved.meta.warnings.length, 4);
});

// ---------------- adjust_plan_sessions：课次级局部调整（U1 收尾） ----------------

test('adjust_plan_sessions：非对话拒写；无计划返回 no_plan', async () => {
  const io = fakeIo({});
  io.savePlanVersion = async () => {
    throw new Error('不应落库');
  };
  const raw = await createExecuteTool(io, { source: 'plan', lang: 'zh' })('adjust_plan_sessions', {
    ops: [{ op: 'remove', date: day(1) }],
  });
  assert.match(JSON.parse(raw).error, /只能在对话中调整/);

  const noPlan = createExecuteTool(fakeIo({ getTrainingPlan: async () => null }), { source: 'plan', chat: true, lang: 'zh' });
  assert.match(JSON.parse(await noPlan('adjust_plan_sessions', { ops: [{ op: 'remove', date: day(1) }] })).error, /没有训练计划/);
});

test('adjust_plan_sessions：操作级错误与合理性违规都整批拒、不落库', async () => {
  const stored = { plan: planObj([pSession(day(0), 'threshold', 60), pSession(day(2), 'endurance', 90)]), created_at: 'x', origin: 'generate', source_report_id: null, change_note: null, warnings: [] };
  const io = fakeIo({ getTrainingPlan: async () => stored });
  io.savePlanVersion = async () => {
    throw new Error('不应落库');
  };
  const exec = createExecuteTool(io, { source: 'plan', chat: true, lang: 'zh' });

  const occupied = JSON.parse(
    await exec('adjust_plan_sessions', { ops: [{ op: 'move', from: day(0), to: day(2) }] }),
  );
  assert.match(occupied.error, /已有课/);

  // 两节质量课只隔 1 天 → violations 硬拒（锚定两课日期）附替代提示
  const clash = JSON.parse(
    await exec('adjust_plan_sessions', {
      ops: [{ op: 'insert', date: day(1), type: 'threshold', duration_min: 60 }],
    }),
  );
  assert.equal(clash.ok, false);
  assert.match(clash.violations[0], /48h/);
  assert.match(clash.hint, /替代调整方案/);
});

test('adjust_plan_sessions：合规局部调整落库 origin=adjust——applied 回传、TSS 重估、change_note 裁剪', async () => {
  const stored = {
    // 进行中计划（valid_from = today-10）：钉 ops 链路不受 valid_from 回看墙影响（P1-1）
    plan: {
      ...planObj([
        pSession(day(0), 'threshold', 60),
        pSession(day(2), 'endurance', 90),
        pSession(day(4), 'rest', null),
      ]),
      valid_from: day(-10),
    },
    created_at: 'x', origin: 'generate', source_report_id: null, change_note: null, warnings: [],
  };
  const io = fakeIo({ getTrainingPlan: async () => stored });
  let saved = null;
  io.savePlanVersion = async (plan, meta) => {
    saved = { plan, meta };
    return 3;
  };
  const exec = createExecuteTool(io, { source: 'plan', chat: true, lang: 'zh' });
  const out = JSON.parse(
    await exec('adjust_plan_sessions', {
      ops: [
        { op: 'move', from: day(2), to: day(3) },
        { op: 'set_duration', date: day(3), duration_min: 120 },
      ],
      change_note: 'x'.repeat(260),
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.versions_total, 3);
  assert.deepEqual(out.applied, [
    { op: 'move', from: day(2), to: day(3) },
    { op: 'set_duration', date: day(3), duration_min: 120 },
  ]);
  assert.equal(out.note, 'x'.repeat(200)); // 截断到 200
  assert.equal(saved.meta.origin, 'adjust');
  const moved = saved.plan.sessions.find((x) => x.date === day(3));
  assert.equal(moved.duration_min, 120);
  assert.equal(moved.tss, 92.5); // endurance 120min 重估：120×60×0.68²/36
});

test('adjust_plan_sessions：业余模式软约束只回传 warnings（ops 档不硬拒）', async () => {
  // 三节质量课放进同一自然周（下周一/三/五）：插入周五课后周质量课 = 3 > 2
  const dow = new Date(localDay() + 'T00:00:00Z').getUTCDay();
  const nextMon = ((1 - dow + 7) % 7) || 7;
  const mon = day(nextMon);
  const stored = {
    plan: planObj([pSession(mon, 'threshold', 60), pSession(day(nextMon + 2), 'threshold', 60)]),
    created_at: 'x', origin: 'generate', source_report_id: null, change_note: null, warnings: [],
  };
  const io = fakeIo({
    getTrainingPlan: async () => stored,
    getProfile: async () => ({
      identity: '',
      goal: '保持健康',
      coach_mode: 'amateur',
      weekly_hours: '3to5',
      available_days: [],
      session_max_min: 60,
    }),
  });
  let saved = null;
  io.savePlanVersion = async (plan, meta) => {
    saved = { plan, meta };
    return 4;
  };
  const exec = createExecuteTool(io, { source: 'plan', chat: true, lang: 'zh' });
  const out = JSON.parse(
    await exec('adjust_plan_sessions', {
      ops: [{ op: 'insert', date: day(nextMon + 4), type: 'threshold', duration_min: 90 }],
    }),
  );
  assert.equal(out.ok, true); // 软约束不阻断
  assert.equal(out.violations, undefined);
  // 1 条周质量课上限 + 1 条单课超时（90 > 60）
  assert.equal(out.warnings.length, 2);
  assert.equal(saved.meta.warnings.length, 2);
});

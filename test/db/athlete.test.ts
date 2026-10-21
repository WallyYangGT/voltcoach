/// <reference types="node" />
/**
 * athlete.test.ts — 骑手参数/档案域真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：athlete 行合并保活、FTP 溯源戳盖/不盖/撤销恢复、
 * isFtpCalibrated 判据（decisions §35）、ai_ftp_update 快照、profile 行空档删除。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import {
  getAthleteState,
  getAiFtpUpdate,
  getEffectiveAthlete,
  getFtpMeta,
  getProfile,
  isFtpCalibrated,
  setAiFtpUpdate,
  setAthlete,
  setProfile,
} from '@/db/athlete';
import { getRawDb, resetTestDb, seedActivityRow } from '../helpers/sqlite-port';
import { ATHLETE } from '@/core/settings';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

beforeEach(() => {
  resetTestDb();
});
describe('getEffectiveAthlete / getAthleteState', () => {
  test('无 athlete 行时回落出厂默认，configured=false', async () => {
    const athlete = await getEffectiveAthlete();
    expect(athlete.ftp_watts).toBe(ATHLETE.ftp_watts);
    const state = await getAthleteState();
    expect(state.configured).toBe(false);
    expect(await isFtpCalibrated()).toBe(false);
  });
  test('部分字段更新合并保活其余默认值，configured=true', async () => {
    await setAthlete({ ftp_watts: 250, max_hr: 190 });
    const athlete = await getEffectiveAthlete();
    expect(athlete.ftp_watts).toBe(250);
    expect(athlete.max_hr).toBe(190);
    expect((await getAthleteState()).configured).toBe(true);
  });
});
describe('FTP 溯源戳', () => {
  test('FTP 值实际变更时盖戳（manual 缺省），值未变不刷新时间戳', async () => {
    await setAthlete({ ftp_watts: 250 });
    const first = await getFtpMeta();
    expect(first.source).toBe('manual');
    expect(first.updated_at).toBeTruthy();
    await setAthlete({ ftp_watts: 250 }); // 值未变
    const second = await getFtpMeta();
    expect(second.updated_at).toBe(first.updated_at);
  });
  test('source 可显式指定（estimate/ai_coach）', async () => {
    await setAthlete({ ftp_watts: 240 }, 'zh', { source: 'estimate' });
    expect((await getFtpMeta()).source).toBe('estimate');
  });
  test('只改体重：有行但 FTP 未校准（decisions §35 判据）', async () => {
    await setAthlete({ weight_kg: 75 });
    expect((await getAthleteState()).configured).toBe(true);
    expect(await isFtpCalibrated()).toBe(false);
  });
  test('stamps 显式清除（撤销路径）：回到无戳态，判未校准', async () => {
    await setAthlete({ ftp_watts: 250 });
    expect(await isFtpCalibrated()).toBe(true);
    await setAthlete({ ftp_watts: ATHLETE.ftp_watts }, 'zh', {
      stamps: { updated_at: null, source: null },
    });
    expect(await getFtpMeta()).toEqual({ updated_at: null, source: null });
    expect(await isFtpCalibrated()).toBe(false);
  });
  test('非法值抛错且不落库', async () => {
    await expect(setAthlete({ ftp_watts: 9999 })).rejects.toThrow();
    await expect(setAthlete({ max_hr: 10 })).rejects.toThrow();
    await expect(setAthlete({})).rejects.toThrow();
    expect((await getEffectiveAthlete()).ftp_watts).toBe(ATHLETE.ftp_watts);
  });
});
describe('ai_ftp_update 快照', () => {
  test('写入/读取/清除，且保活溯源戳等扩展字段', async () => {
    await setAthlete({ ftp_watts: 250 });
    const stamped = await getFtpMeta();
    await setAiFtpUpdate({
      old_ftp_w: ATHLETE.ftp_watts,
      new_ftp_w: 250,
      updated_at: '2026-10-21T00:00:00.000Z',
      requested_w: 245,
      range_low_w: 230,
      range_high_w: 260,
    });
    const snap = await getAiFtpUpdate();
    expect(snap?.new_ftp_w).toBe(250);
    expect(snap?.requested_w).toBe(245);
    // 快照整写回不丢溯源戳（Object.assign 保活口径）
    expect((await getFtpMeta()).updated_at).toBe(stamped.updated_at ?? null);
    await setAiFtpUpdate(null);
    expect(await getAiFtpUpdate()).toBeNull();
  });
  test('行损坏/字段不全返回 null（不抛错）', async () => {
    getRawDb()
      .prepare(`INSERT INTO settings (key, value) VALUES ('athlete', ?)`)
      .run(JSON.stringify({ ai_ftp_update: { old_ftp_w: 'broken' } }));
    expect(await getAiFtpUpdate()).toBeNull();
  });
});
describe('骑手档案 profile', () => {
  test('写入后 configured=true；全空时删除行', async () => {
    await setProfile({ identity: '40 岁业余骑手', goal: '今年完成 200km 不掉队' });
    const saved = await getProfile();
    expect(saved.configured).toBe(true);
    expect(saved.identity).toBe('40 岁业余骑手');
    await setProfile({ identity: '', goal: '' });
    const cleared = await getProfile();
    expect(cleared.configured).toBe(false);
    const row = getRawDb().prepare(`SELECT value FROM settings WHERE key = 'profile'`).get();
    expect(row).toBeUndefined(); // 行物理删除
  });
  test('coach_mode 写入后可读回（业余教练模式载体）', async () => {
    await setProfile({ coach_mode: 'amateur', weekly_hours: '3to5' });
    const saved = await getProfile();
    expect(saved.coach_mode).toBe('amateur');
    expect(saved.weekly_hours).toBe('3to5');
  });
});
describe('跨域读取（dossier 依赖面）', () => {
  test('getEffectiveAthlete 与活动表互不影响（档案指纹的 ftp 分量）', async () => {
    seedActivityRow();
    await setAthlete({ ftp_watts: 260 });
    expect((await getEffectiveAthlete()).ftp_watts).toBe(260);
    expect((await getFtpMeta()).source).toBe('manual');
  });
});
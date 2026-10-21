/// <reference types="node" />
/**
 * plans.test.ts — 结构化训练计划域真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：版本落库（旧版挪历史 + 裁剪 history_keep）、
 * undoLastPlanVersion 的 current↔history[0] 事务交换、报告→计划锚链接的
 * 事务读改写与 200 条上限、损坏行按无计划自愈。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import {
  getCurrentPlan,
  getPlanHistory,
  getPlanReportLink,
  recordPlanReportLink,
  savePlanVersion,
  undoLastPlanVersion,
} from '@/db/plans';
import { getRawDb, resetTestDb } from '../helpers/sqlite-port';
import { PLAN_VALIDATION } from '@/core/settings';
import type { TrainingPlan } from '@/core/training-plan';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

beforeEach(() => {
  resetTestDb();
});
let seq = 0;
/** 最小可用计划（parseStoredPlan 只查 plan.sessions 数组形状；余字段断言放宽） */
const makePlan = (): TrainingPlan =>
  ({ sessions: [{ id: `s${(seq += 1)}` }] }) as unknown as TrainingPlan;
describe('版本落库与历史', () => {
  test('空库 getCurrentPlan/getPlanHistory 返回 null/[]', async () => {
    expect(await getCurrentPlan()).toBeNull();
    expect(await getPlanHistory()).toEqual([]);
  });
  test('首版入库 total=1；第二版把旧版挪入历史头部', async () => {
    expect(await savePlanVersion(makePlan(), { origin: 'generate' })).toBe(1);
    const v2 = makePlan();
    expect(await savePlanVersion(v2, { origin: 'adjust', change_note: '减量周' })).toBe(2);
    const current = await getCurrentPlan();
    expect(current?.origin).toBe('adjust');
    expect(current?.change_note).toBe('减量周');
    const history = await getPlanHistory();
    expect(history).toHaveLength(1);
    expect(history[0].origin).toBe('generate');
  });
  test(`历史上限 ${PLAN_VALIDATION.history_keep} 版裁剪（最旧被挤掉）`, async () => {
    for (let i = 0; i < PLAN_VALIDATION.history_keep + 3; i += 1) {
      await savePlanVersion(makePlan(), { origin: 'generate' });
    }
    expect(await getPlanHistory()).toHaveLength(PLAN_VALIDATION.history_keep);
    const current = await getCurrentPlan();
    expect(current).not.toBeNull();
  });
  test('损坏行按无计划处理（shape 不符→null），下次写入自愈', async () => {
    getRawDb()
      .prepare(`INSERT INTO settings (key, value) VALUES ('training_plan', '{broken')`)
      .run();
    expect(await getCurrentPlan()).toBeNull();
    await savePlanVersion(makePlan(), { origin: 'generate' });
    expect(await getCurrentPlan()).not.toBeNull();
  });
});
describe('undoLastPlanVersion', () => {
  test('current ↔ history[0] 交换；连续两次撤销可换回；无历史返回 false', async () => {
    expect(await undoLastPlanVersion()).toBe(false); // 无计划
    const v1 = makePlan();
    await savePlanVersion(v1, { origin: 'generate', change_note: '第一版' });
    await savePlanVersion(makePlan(), { origin: 'adjust', change_note: '第二版' });
    expect((await getCurrentPlan())?.change_note).toBe('第二版');
    expect(await undoLastPlanVersion()).toBe(true);
    expect((await getCurrentPlan())?.change_note).toBe('第一版'); // 撤销回 v1
    expect((await getPlanHistory())[0].change_note).toBe('第二版'); // 被撤销版进历史头部
    expect(await undoLastPlanVersion()).toBe(true);
    expect((await getCurrentPlan())?.change_note).toBe('第二版'); // 再点一次换回
  });
});
describe('报告 ↔ 计划锚链接', () => {
  test('记录/读取往返；事务读改写保留并发写入的既有键', async () => {
    await recordPlanReportLink(11, '2026-10-01T00:00:00.000Z');
    await recordPlanReportLink(12, '2026-10-05T00:00:00.000Z');
    expect(await getPlanReportLink(11)).toBe('2026-10-01T00:00:00.000Z');
    expect(await getPlanReportLink(12)).toBe('2026-10-05T00:00:00.000Z');
    expect(await getPlanReportLink(99)).toBeNull();
  });
  test('超上限剪最旧（PLAN_LINKS_CAP=200）', async () => {
    for (let i = 1; i <= 205; i += 1) {
      await recordPlanReportLink(i, `anchor-${i}`);
    }
    expect(await getPlanReportLink(1)).toBeNull(); // 最旧被剪
    expect(await getPlanReportLink(3)).toBeNull();
    expect(await getPlanReportLink(205)).toBe('anchor-205');
    const links = JSON.parse(
      (getRawDb().prepare(`SELECT value FROM settings WHERE key = 'plan_report_links'`).get() as { value: string })
        .value,
    ) as Record<string, string>;
    expect(Object.keys(links)).toHaveLength(200);
  });
  test('损坏链接行按无关联处理并可覆写自愈', async () => {
    getRawDb()
      .prepare(`INSERT INTO settings (key, value) VALUES ('plan_report_links', '{broken')`)
      .run();
    expect(await getPlanReportLink(1)).toBeNull();
    await recordPlanReportLink(1, 'anchor');
    expect(await getPlanReportLink(1)).toBe('anchor');
  });
});
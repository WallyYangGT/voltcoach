/// <reference types="node" />
/**
 * reports.test.ts — AI 报告域真 SQL 回归（node:sqlite 假库，helpers/sqlite-port）
 *
 * 钉 mock 测不到的 SQL 行为：入库时指纹子查询捕获、每 mode 30 条滚动清理、
 * updateAiReport 的 COALESCE 语义、cancelPendingAiReport 的 pending 守卫。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import {
  cancelPendingAiReport,
  createPendingAiReport,
  getAiReport,
  getLatestReviewReport,
  listAiReports,
  listPendingAiReportRefs,
  saveAiReport,
  updateAiReport,
} from '@/db/reports';
import { getRawDb, makeSummary, resetTestDb, seedActivityRow } from '../helpers/sqlite-port';
import { insertActivity } from '@/db/activities';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));

beforeEach(() => {
  resetTestDb();
});
describe('保存与指纹捕获', () => {
  test('saveAiReport 子查询落活动指纹（v3 重挂前提）', async () => {
    const uuid = await insertActivity({ fileName: 'a.fit', fingerprint: 'fp-r', summary: makeSummary() });
    const id = await saveAiReport('review', { activity_uuid: uuid }, 'p', '正文');
    const row = await getAiReport(id);
    expect(row?.activity_uuid).toBe(uuid);
    expect(row?.activity_fingerprint).toBe('fp-r');
    expect(row?.status).toBe('completed');
  });
  test('getLatestReviewReport 取该活动最新 review（含 pending/failed 候选）', async () => {
    const uuid = seedActivityRow({});
    await saveAiReport('review', { activity_uuid: uuid }, 'p', '旧');
    const newest = await createPendingAiReport('review', { activity_uuid: uuid }, 'p');
    // plan 场景不干扰 review 查询
    await saveAiReport('plan', null, 'p', '计划');
    const found = await getLatestReviewReport(uuid);
    expect(found?.id).toBe(newest);
    expect(found?.status).toBe('pending');
  });
});
describe('每 mode 30 条滚动清理', () => {
  test('第 31 条挤掉最旧一条；mode 间互不干扰', async () => {
    for (let i = 0; i < 31; i += 1) {
      await saveAiReport('review', null, `p${i}`, 'm');
    }
    await saveAiReport('plan', null, 'plan-p', 'plan-m');
    const reviews = await listAiReports('review', 100);
    expect(reviews).toHaveLength(30);
    expect(reviews[0].id).toBe(31); // id DESC：最新在前
    const plans = await listAiReports('plan');
    expect(plans).toHaveLength(1);
  });
});
describe('更新与取消守卫', () => {
  test('updateAiReport 的 COALESCE：null 不覆盖已有值', async () => {
    const id = await saveAiReport('review', null, 'p', '完整正文');
    await updateAiReport(id, { status: 'failed', error: '网关超时' });
    let row = await getAiReport(id);
    expect(row?.markdown).toBe('完整正文'); // markdown 传 null 不覆盖
    expect(row?.status).toBe('failed');
    await updateAiReport(id, { status: 'completed' }); // error 传 null/缺省同样不覆盖（COALESCE 口径）
    row = await getAiReport(id);
    expect(row?.error).toBe('网关超时');
    expect(row?.status).toBe('completed');
  });
  test('cancelPendingAiReport 只取消 pending 行（守卫防覆盖竞态）', async () => {
    const pendingId = await createPendingAiReport('review', null, 'p');
    expect(await cancelPendingAiReport(pendingId)).toBe(true);
    expect((await getAiReport(pendingId))?.status).toBe('cancelled');
    expect(await cancelPendingAiReport(pendingId)).toBe(false); // 已 cancelled，守卫拒绝
    const doneId = await saveAiReport('review', null, 'p', 'm');
    expect(await cancelPendingAiReport(doneId)).toBe(false); // completed 行不可取消
  });
});
describe('列表与续跑扫描', () => {
  test("listAiReports 'all' 混排跨 mode 按 id 倒序", async () => {
    await saveAiReport('review', null, 'p', 'm');
    await saveAiReport('taper', null, 'p', 'm');
    const all = await listAiReports('all');
    expect(all.map((r) => r.mode)).toEqual(['taper', 'review']);
  });
  test('listPendingAiReportRefs 只列 pending 占位', async () => {
    const a = await createPendingAiReport('review', null, 'p');
    const b = await createPendingAiReport('plan', null, 'p');
    await saveAiReport('review', null, 'p', 'm');
    const refs = await listPendingAiReportRefs();
    expect(refs.map((r) => r.id)).toEqual([a, b]);
    expect(refs.every((r) => typeof r.created_at === 'string' && r.created_at.length > 0)).toBe(true);
    expect(getRawDb().prepare(`SELECT COUNT(*) AS c FROM ai_reports`).get()).toEqual({ c: 3 });
  });
});
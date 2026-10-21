/**
 * reports.ts — AI 报告域（ai_reports 表，M3 自 fit-reader Web 版 src/db.js 平移）
 *
 * 报告 CRUD、pending 占位与取消守卫、每 mode 30 条滚动清理、续跑扫描的轻查询。
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from './client';
import { invalidateDb } from './notify';

export type AiReportMode = 'review' | 'plan' | 'taper' | 'compare';

/** 报告上下文（场景参数）：review 带活动 uuid、taper 带比赛日期、compare 带对比活动 uuid */
export interface AiReportContext {
  activity_uuid?: string | null;
  race_date?: string | null;
  compare_uuid?: string | null;
}

/** 报告列表项（不含 prompt/markdown 正文，列表页用） */
export interface AiReportListItem {
  id: number;
  mode: AiReportMode;
  activity_uuid: string | null;
  race_date: string | null;
  compare_uuid: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

/** 完整报告行（含 prompt + markdown + 重挂指纹） */
export interface AiReportRow extends AiReportListItem {
  activity_fingerprint: string | null;
  compare_fingerprint: string | null;
  prompt: string;
  markdown: string;
}

/** 每个 mode 滚动保留最近 30 条报告（pending 占位也参与计数） */
async function trimAiReports(db: SQLiteDatabase, mode: AiReportMode): Promise<void> {
  await db.runAsync(
    `DELETE FROM ai_reports
     WHERE id NOT IN (
       SELECT id FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT 30
     ) AND mode = ?`,
    mode,
    mode,
  );
}

/** 保存完成的 AI 报告；每个 mode 仅保留最近 30 条（id DESC，不受 created_at 秒级精度影响） */
export async function saveAiReport(
  mode: AiReportMode,
  context: AiReportContext | null,
  prompt: string,
  markdown: string,
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_reports
       (mode, activity_uuid, race_date, compare_uuid,
        activity_fingerprint, compare_fingerprint, prompt, markdown, status)
     VALUES (?, ?, ?, ?,
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             ?, ?, 'completed')`,
    mode,
    context?.activity_uuid ?? null,
    context?.race_date ?? null,
    context?.compare_uuid ?? null,
    context?.activity_uuid ?? null,
    context?.compare_uuid ?? null,
    prompt ?? '',
    markdown ?? '',
  );
  const id = Number(info.lastInsertRowId);
  await trimAiReports(db, mode);
  invalidateDb('reports');
  return id;
}

/** 创建 status = pending 的报告占位记录（生成中前端可见进度），返回 id；同样受 30 条滚动限制 */
export async function createPendingAiReport(
  mode: AiReportMode,
  context: AiReportContext | null,
  prompt: string,
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_reports
       (mode, activity_uuid, race_date, compare_uuid,
        activity_fingerprint, compare_fingerprint, prompt, markdown, status)
     VALUES (?, ?, ?, ?,
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             ?, '', 'pending')`,
    mode,
    context?.activity_uuid ?? null,
    context?.race_date ?? null,
    context?.compare_uuid ?? null,
    context?.activity_uuid ?? null,
    context?.compare_uuid ?? null,
    prompt ?? '',
  );
  const id = Number(info.lastInsertRowId);
  await trimAiReports(db, mode);
  invalidateDb('reports');
  return id;
}

/** 更新报告（后台生成成功/失败时回填；COALESCE 语义与旧版一致，null 字段不覆盖） */
export async function updateAiReport(
  id: number,
  patch: { markdown?: string; status?: string; error?: string | null },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE ai_reports
     SET markdown = COALESCE(?, markdown),
         status = COALESCE(?, status),
         error = COALESCE(?, error)
     WHERE id = ?`,
    patch.markdown ?? null,
    patch.status ?? null,
    patch.error ?? null,
    id,
  );
  invalidateDb('reports');
}

/**
 * 用户取消报告生成（2026-10 取消按钮）：只把仍处 pending 的占位行置为 cancelled。
 * WHERE 守卫防覆盖——「触发生成」与「取消」存在竞态（fire 在 cancel 落库后才真正
 * 开跑），有守卫时后到的生成任务不会把用户刚取消的行又拉回 completed。
 * 返回是否有行被取消（编排层据此区分「已停止在跑任务」与「行本就不是 pending」）。
 */
export async function cancelPendingAiReport(id: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE ai_reports SET status = 'cancelled', error = NULL WHERE id = ? AND status = 'pending'`,
    id,
  );
  if (r.changes > 0) invalidateDb('reports');
  return r.changes > 0;
}

/**
 * 报告列表：mode 传具体场景时只列该 mode（旧版口径），传 'all' 时全部混排
 * （会话中心统一历史列表用，按 id 倒序跨 mode 排序）。
 */
export async function listAiReports(
  mode: AiReportMode | 'all' = 'all',
  n = 30,
): Promise<AiReportListItem[]> {
  const db = await getDb();
  const rows =
    mode === 'all'
      ? await db.getAllAsync<AiReportListItem & { prompt: string; markdown: string }>(
          `SELECT id, mode, activity_uuid, race_date, compare_uuid, status, error, created_at
           FROM ai_reports ORDER BY id DESC LIMIT ?`,
          n,
        )
      : await db.getAllAsync<AiReportListItem & { prompt: string; markdown: string }>(
          `SELECT id, mode, activity_uuid, race_date, compare_uuid, status, error, created_at
           FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT ?`,
          mode,
          n,
        );
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    activity_uuid: r.activity_uuid,
    race_date: r.race_date,
    compare_uuid: r.compare_uuid,
    status: r.status,
    error: r.error,
    created_at: r.created_at,
  }));
}

/** 按 id 取单条完整报告（含 prompt + markdown + status + error），不存在返回 null */
export async function getAiReport(id: number): Promise<AiReportRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<
    AiReportListItem & { prompt: string; markdown: string }
  >(`SELECT * FROM ai_reports WHERE id = ?`, id);
  return row ? toAiReportRow(row) : null;
}

/**
 * 某次训练的最新 review 报告（训练详情页内嵌展示用，口径同 Web 版
 * views/activities.js：按活动 uuid 过滤 review 列表取最新一条，含 pending/failed）。
 */
export async function getLatestReviewReport(activityUuid: string): Promise<AiReportRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<
    AiReportListItem & { prompt: string; markdown: string }
  >(
    `SELECT * FROM ai_reports WHERE mode = 'review' AND activity_uuid = ?
     ORDER BY id DESC LIMIT 1`,
    activityUuid,
  );
  return row ? toAiReportRow(row) : null;
}

/** ai_reports 行 → AiReportRow（SELECT * 或列裁剪结果皆可） */
function toAiReportRow(
  row: AiReportListItem & {
    prompt: string;
    markdown: string;
    activity_fingerprint?: string | null;
    compare_fingerprint?: string | null;
  },
): AiReportRow {
  return {
    id: row.id,
    mode: row.mode,
    activity_uuid: row.activity_uuid,
    race_date: row.race_date,
    compare_uuid: row.compare_uuid,
    activity_fingerprint: row.activity_fingerprint ?? null,
    compare_fingerprint: row.compare_fingerprint ?? null,
    prompt: row.prompt,
    markdown: row.markdown,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
  };
}

/**
 * 待恢复的报告占位（status=pending 的 id + created_at）。只读轻查询，供根布局
 * 回前台/冷启动时的自动续跑扫描用（进程内是否已在跑由编排层注册表判断）。
 */
export async function listPendingAiReportRefs(): Promise<
  { id: number; created_at: string }[]
> {
  const db = await getDb();
  return db.getAllAsync<{ id: number; created_at: string }>(
    `SELECT id, created_at FROM ai_reports WHERE status = 'pending' ORDER BY id`,
  );
}

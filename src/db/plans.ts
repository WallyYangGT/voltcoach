/**
 * plans.ts — 结构化训练计划域（settings 表 training_plan / training_plan_history 行，v2 训练计划载体）
 * + 报告 ↔ 计划结构化关联（U1 收尾③，settings 松散引用行）
 *
 * 存储拍板（decisions §19）：单逻辑文档 + 版本历史，无 SQL 级查询需求——settings
 * JSON 行而非新表（dossier 先例），不动 SCHEMA_VERSION；settings 是通用 KV，备份
 * 整库拷贝透明携带，旧版 App 忽略未知键，新备份仍可被旧版导入（新表方案会让备份包
 * 版本闸门拒收旧版）。结构演进靠 shape 递增（同 dossier 的 code-review P2-4 口径）。
 *
 * 报告关联拍板（2026-10-15）：不加列、不动 SCHEMA_VERSION 与备份包闸门——沿
 * ai_ftp_update 快照先例走 settings JSON 行。锚 = StoredPlan.created_at（位置无关，
 * 版本被替换/挪历史后仍可定位）；版本号展示按位置推导（locatePlanVersion）。上限
 * 条数防 reports 滚动保留期间链接行无界增长（ai_reports 每 mode 留 30，四 mode
 * 最多 ~120 行链接）。
 */

import { getDb } from './client';
import { invalidateDb } from './notify';
import { PLAN_VALIDATION } from '@/core/settings';
import type { PlanIssue, TrainingPlan } from '@/core/training-plan';

const PLAN_STORE_SHAPE = 1;
const PLAN_CURRENT_KEY = 'training_plan';
const PLAN_HISTORY_KEY = 'training_plan_history';

/** 已入库的一版计划（plan 已过 validateTrainingPlan 并回填 TSS；warnings 随版存档供展示） */
export interface StoredPlan {
  plan: TrainingPlan;
  created_at: string; // 入库时刻 ISO 串（展示用）
  origin: 'generate' | 'adjust'; // 周期规划生成 / 会话调整
  source_report_id: number | null; // generate：来源 plan 报告 id（计划页「查看生成报告」跳转）
  change_note: string | null; // adjust：模型给出的变更说明
  warnings: PlanIssue[]; // 入库时的合理性提示（create 档 R1–R3；业余软约束三档都可能有）
}

/** 当前计划行（热键只放当前版本，历史走独立冷键隔离读放大） */
interface PlanCurrentEntry {
  shape: number;
  current: StoredPlan;
}

/** 历史版本行（versions[0] 最近被替换的版本，上限 PLAN_VALIDATION.history_keep） */
interface PlanHistoryEntry {
  shape: number;
  versions: StoredPlan[];
}

const parseStoredPlan = (v: unknown): StoredPlan | null => {
  const p = v as StoredPlan | null;
  return p && typeof p === 'object' && p.plan && Array.isArray(p.plan.sessions) ? p : null;
};

/**
 * 当前训练计划（首页卡 / 计划页 / get_training_plan 工具共用入口）。
 * 无计划或行损坏（shape 不符/结构缺失）返回 null——损坏按无计划处理，
 * 下一次生成/调整会覆盖写入，自愈。
 */
export async function getCurrentPlan(): Promise<StoredPlan | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    PLAN_CURRENT_KEY,
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as PlanCurrentEntry;
    if (parsed?.shape === PLAN_STORE_SHAPE) return parseStoredPlan(parsed.current);
  } catch {
    // 行损坏按无计划处理
  }
  return null;
}

/** 计划版本历史（新序在前，只含被替换的旧版本，不含当前版；无/损坏返回空数组） */
export async function getPlanHistory(): Promise<StoredPlan[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    PLAN_HISTORY_KEY,
  );
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as PlanHistoryEntry;
    if (parsed?.shape === PLAN_STORE_SHAPE && Array.isArray(parsed.versions)) {
      return parsed.versions.map(parseStoredPlan).filter((v): v is StoredPlan => v != null);
    }
  } catch {
    // 行损坏按无历史处理
  }
  return [];
}

/**
 * 落一版计划：写当前行；已有当前版则先挪入历史头部（裁剪到 PLAN_VALIDATION.history_keep）。
 * 调用方负责先过 validateTrainingPlan（generate 钩子 / update_training_plan 工具），本层不重校验。
 * 返回落地后的总版本数（当前 1 + 历史条数，UI「第 N 版」用）。
 */
export async function savePlanVersion(
  plan: TrainingPlan,
  meta: {
    origin: 'generate' | 'adjust';
    source_report_id?: number | null;
    change_note?: string | null;
    warnings?: PlanIssue[];
  },
): Promise<number> {
  const db = await getDb();
  const entry: StoredPlan = {
    plan,
    created_at: new Date().toISOString(),
    origin: meta.origin,
    source_report_id: meta.source_report_id ?? null,
    change_note: meta.change_note ?? null,
    warnings: meta.warnings ?? [],
  };
  // 事务包住「旧版挪历史 + 写当前」两步：进程中断在中途会留下当前版同时出现在
  // history[0] 的重复版本（code-review P3），事务内读写保证原子
  let versionsTotal = 1;
  await db.withTransactionAsync(async () => {
    const [current, history] = await Promise.all([getCurrentPlan(), getPlanHistory()]);
    const versions = current
      ? [current, ...history].slice(0, PLAN_VALIDATION.history_keep)
      : history;
    if (current) {
      await db.runAsync(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        PLAN_HISTORY_KEY,
        JSON.stringify({ shape: PLAN_STORE_SHAPE, versions } satisfies PlanHistoryEntry),
      );
    }
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_CURRENT_KEY,
      JSON.stringify({ shape: PLAN_STORE_SHAPE, current: entry } satisfies PlanCurrentEntry),
    );
    versionsTotal = 1 + versions.length;
  });
  invalidateDb('plans');
  return versionsTotal;
}

// ---------------- 报告 ↔ 计划结构化关联（U1 收尾③，settings 松散引用行） ----------------

const PLAN_LINKS_KEY = 'plan_report_links';
const PLAN_LINKS_CAP = 200;

/** 报告关联的计划锚（该报告生成完成时锚定的 StoredPlan.created_at；无关联返回 null） */
export async function getPlanReportLink(reportId: number): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    PLAN_LINKS_KEY,
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Record<string, string>;
    const anchor = parsed[String(reportId)];
    return typeof anchor === 'string' ? anchor : null;
  } catch {
    return null; // 行损坏按无关联处理
  }
}

/** 记一条报告→计划锚（generateReport 收尾调用；超上限剪最旧）。读改写包事务：
 *  resumeInterruptedGenerations 会并行 fire 多条 generateReport，两条报告毫秒级窗口内
 *  先后完成时非事务的读改写会丢一次更新（code-review P2-1，照 savePlanVersion 先例） */
export async function recordPlanReportLink(reportId: number, planCreatedAt: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM settings WHERE key = ?`,
      PLAN_LINKS_KEY,
    );
    let links: Record<string, string> = {};
    if (row) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object') links = parsed;
      } catch {
        links = {}; // 行损坏重开
      }
    }
    links[String(reportId)] = planCreatedAt;
    const keys = Object.keys(links);
    for (const k of keys.slice(0, Math.max(0, keys.length - PLAN_LINKS_CAP))) delete links[k];
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_LINKS_KEY,
      JSON.stringify(links),
    );
  });
  invalidateDb('plans');
}

/**
 * 撤销最近一次计划版本替换（U1 收尾④「披露与可逆」的撤销半边）：事务内
 * current ↔ history[0] 交换——被撤销的版本进历史头部（再点一次撤销可换回，
 * 无数据丢失）；history_keep 裁剪口径不变。无历史版本或状态异常返回 false。
 */
export async function undoLastPlanVersion(): Promise<boolean> {
  const db = await getDb();
  let undone = false;
  await db.withTransactionAsync(async () => {
    const [current, history] = await Promise.all([getCurrentPlan(), getPlanHistory()]);
    // 只有历史而没有当前版属异常状态（savePlanVersion 先有当前版才有历史），不动
    if (!current || history.length === 0) return;
    const restored = history[0];
    const versions = [current, ...history.slice(1)].slice(0, PLAN_VALIDATION.history_keep);
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_HISTORY_KEY,
      JSON.stringify({ shape: PLAN_STORE_SHAPE, versions } satisfies PlanHistoryEntry),
    );
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_CURRENT_KEY,
      JSON.stringify({ shape: PLAN_STORE_SHAPE, current: restored } satisfies PlanCurrentEntry),
    );
    undone = true;
  });
  if (undone) invalidateDb('plans');
  return undone;
}

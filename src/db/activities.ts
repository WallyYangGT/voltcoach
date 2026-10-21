/**
 * activities.ts — 训练记录域（v3：uuid 对外身份，file_name 为来源元数据）
 *
 * 活动 CRUD / 清单 / 分类备注 / 功率可信度标记 / 去重删除合并（跨表事务就地写，
 * 不引其他域的函数）+ CTL/ATL/TSB、月度汇总、FTP 估算的取数查询（递推与归并
 * 计算都在 core 纯函数层，本层只做查询）。
 */

import * as Crypto from 'expo-crypto';
import { getDb } from './client';
import { invalidateDb } from './notify';
import type { Summary } from '@/core/analyze';
import { fillDailyTss, formSeriesDaily, formSnapshotAtEnd } from '@/core/form';
import type { CyclingRideInput } from '@/core/ftp';
import { isActivityUuid } from '@/core/identity';
import { t, type Lang } from '@/core/i18n';
import { localDay } from '@/core/local-day';
import { monthlySummaryFromRows, type MonthlyItem, type MonthlyRow } from '@/core/monthly';

/** 活动对外身份：32 位小写 hex（形状校验单源在 core/identity） */
export { isActivityUuid };

/** 生成新活动 uuid（RFC 4122 randomUUID 去连字符 → 32 hex） */
export function newActivityUuid(): string {
  return Crypto.randomUUID().replace(/-/g, '').toLowerCase();
}

/** 活动总数（备份 manifest counts 与导入结果展示用） */
export async function countActivities(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM activities;');
  return row?.c ?? 0;
}

/** summary → activities 列值（插入/更新共用，口径与旧 upsert 一致） */
function activityRowValues(summary: Summary) {
  const a = summary.activity;
  // 无功率数据的运动（跑步/游泳）没有 power 段；类型上以 Partial 放宽（旧版同款运行时口径）
  const p = (summary.power ?? {}) as Partial<NonNullable<Summary['power']>>;
  return {
    date: a.date,
    sport: a.sport ?? null,
    duration_sec: a.duration_sec ?? null,
    distance_km: a.distance_km ?? null,
    elevation_gain_m: a.elevation_gain_m ?? null,
    tss: p.tss ?? null,
    np: p.normalized_power ?? null,
    avg_power: p.avg ?? null,
    intensity_factor: p.intensity_factor ?? null,
    summary_json: JSON.stringify(summary),
  };
}

/** 新活动入库（身份由本层生成，返回 uuid；同名不再覆盖——导入决策见 core/dedupe） */
export async function insertActivity(input: {
  fileName: string;
  fingerprint: string;
  source?: string | null;
  summary: Summary;
}): Promise<string> {
  const db = await getDb();
  const uuid = newActivityUuid();
  const v = activityRowValues(input.summary);
  await db.runAsync(
    `INSERT INTO activities
       (uuid, file_name, source, fingerprint, date, sport, duration_sec, distance_km,
        elevation_gain_m, tss, np, avg_power, intensity_factor, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuid,
    input.fileName,
    input.source ?? null,
    input.fingerprint,
    v.date,
    v.sport,
    v.duration_sec,
    v.distance_km,
    v.elevation_gain_m,
    v.tss,
    v.np,
    v.avg_power,
    v.intensity_factor,
    v.summary_json,
  );
  invalidateDb('activities', uuid); // 列表/首页/详情/AI 标题按行失效
  return uuid;
}

/**
 * 更新已有活动的分析结果（重导入/重算/功率校准共用）：保留 uuid、created_at、
 * 分类/备注/功率标记；fingerprint 仅在显式提供时更新（重算不改变骑行身份）。
 */
export async function updateActivitySummary(
  uuid: string,
  summary: Summary,
  opts?: { fingerprint?: string; lang?: Lang },
): Promise<void> {
  const db = await getDb();
  const v = activityRowValues(summary);
  const info = await db.runAsync(
    `UPDATE activities SET
       date = ?, sport = ?, duration_sec = ?, distance_km = ?, elevation_gain_m = ?,
       tss = ?, np = ?, avg_power = ?, intensity_factor = ?, summary_json = ?,
       fingerprint = COALESCE(?, fingerprint)
     WHERE uuid = ?`,
    v.date,
    v.sport,
    v.duration_sec,
    v.distance_km,
    v.elevation_gain_m,
    v.tss,
    v.np,
    v.avg_power,
    v.intensity_factor,
    v.summary_json,
    opts?.fingerprint ?? null,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(opts?.lang ?? 'zh', 'activity.not_found'));
  invalidateDb('activities', uuid);
}

/**
 * 路由/深链标识 → 活动 uuid：uuid 形状直接校验存在；否则按 file_name 回退
 * （兼容 v2 时代的 `/activity/<file_name>` 旧链接）。不存在返回 null。
 */
export async function resolveActivityUuid(identifier: string): Promise<string | null> {
  const db = await getDb();
  if (isActivityUuid(identifier)) {
    const row = await db.getFirstAsync<{ uuid: string }>(
      `SELECT uuid FROM activities WHERE uuid = ?`,
      identifier,
    );
    return row?.uuid ?? null;
  }
  const row = await db.getFirstAsync<{ uuid: string }>(
    `SELECT uuid FROM activities WHERE file_name = ? ORDER BY id DESC LIMIT 1`,
    identifier,
  );
  return row?.uuid ?? null;
}

/** 按 uuid 取来源文件名（服务层向用户/模型转述时用；不存在返回 null） */
export async function getActivityFileName(uuid: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ file_name: string }>(
    `SELECT file_name FROM activities WHERE uuid = ?`,
    uuid,
  );
  return row?.file_name ?? null;
}

/** 训练清单（含 uuid/file_name/运动类型/分类，界面列表展示，按日期倒序） */
export interface ActivityListItem {
  /** 对外稳定身份（路由、列表 key、AI 工具句柄） */
  uuid: string;
  file_name: string;
  date: string;
  sport: string;
  category: string;
  duration_sec: number | null;
  distance_km: number | null;
  elevation_gain_m: number | null;
  tss: number | null;
  np: number | null;
  avg_power: number | null;
  intensity_factor: number | null;
  /** 功率被标记不可信（from list 查询；旧调用方缺省视为 false） */
  power_flagged?: boolean;
}

/** 列表查询上限单源（listActivities 默认值与记录页触顶提示共用，防两处漂移） */
export const ACTIVITY_LIST_LIMIT = 200;

export async function listActivities(n: number = ACTIVITY_LIST_LIMIT): Promise<ActivityListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    sport: string | null;
    category: string | null;
    duration_sec: number | null;
    distance_km: number | null;
    elevation_gain_m: number | null;
    tss: number | null;
    np: number | null;
    avg_power: number | null;
    intensity_factor: number | null;
    power_flagged: number | null;
  }>(
    `SELECT uuid, file_name, date, sport, category, duration_sec, distance_km, elevation_gain_m,
            tss, np, avg_power, intensity_factor, power_flagged
     FROM activities ORDER BY date DESC LIMIT ?`,
    n,
  );
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
    uuid: r.uuid,
    file_name: r.file_name,
    date: r.date,
    sport: r.sport ?? 'unknown',
    category: r.category ?? 'training',
    duration_sec: r.duration_sec,
    distance_km: r1(r.distance_km),
    elevation_gain_m: r.elevation_gain_m == null ? null : Math.round(r.elevation_gain_m),
    tss: r.tss == null ? null : Math.round(r.tss),
    np: r.np == null ? null : Math.round(r.np),
    avg_power: r.avg_power == null ? null : Math.round(r.avg_power),
    // IF 保留库内 2 位精度：健康活动量等判定依赖 0.9/0.55 阈值，取整到 1 位会把
    // 0.85–0.89 误判为高强度（code-review P1-1）
    intensity_factor: r.intensity_factor,
    power_flagged: !!r.power_flagged,
  }));
}

/**
 * 按存储 UTC 日期范围取训练清单（计划执行视图 U1② 用）：fromDay/toDay 为 YYYY-MM-DD
 * UTC 日串（闭区间）。调用方传入本地周界 ±1 天的缓冲（跨时区起骑时刻可能落在相邻
 * UTC 日），行级本地日归并由调用方经 resolveRideDateLabels 完成。
 */
export async function listActivitiesInRange(fromDay: string, toDay: string): Promise<ActivityListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    sport: string | null;
    category: string | null;
    duration_sec: number | null;
    distance_km: number | null;
    elevation_gain_m: number | null;
    tss: number | null;
    np: number | null;
    avg_power: number | null;
    intensity_factor: number | null;
    power_flagged: number | null;
  }>(
    `SELECT uuid, file_name, date, sport, category, duration_sec, distance_km, elevation_gain_m,
            tss, np, avg_power, intensity_factor, power_flagged
     FROM activities WHERE date >= ? AND date <= ? ORDER BY date DESC`,
    fromDay,
    toDay,
  );
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
    uuid: r.uuid,
    file_name: r.file_name,
    date: r.date,
    sport: r.sport ?? 'unknown',
    category: r.category ?? 'training',
    duration_sec: r.duration_sec,
    distance_km: r1(r.distance_km),
    elevation_gain_m: r.elevation_gain_m == null ? null : Math.round(r.elevation_gain_m),
    tss: r.tss == null ? null : Math.round(r.tss),
    np: r.np == null ? null : Math.round(r.np),
    avg_power: r.avg_power == null ? null : Math.round(r.avg_power),
    intensity_factor: r.intensity_factor, // 保留 2 位精度（健康活动量阈值判定用）
    power_flagged: !!r.power_flagged,
  }));
}

/** 按 uuid 取单条训练的完整 summary（详情页用），并把 category 与 note 合并进 activity；不存在返回 null */
export async function getActivitySummary(uuid: string): Promise<Summary | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ summary_json: string; category: string | null; note: string | null }>(
    `SELECT summary_json, category, note FROM activities WHERE uuid = ?`,
    uuid,
  );
  if (!row) return null;
  try {
    const summary = JSON.parse(row.summary_json) as Summary;
    if (summary?.activity && row.category) {
      summary.activity.category = row.category;
    }
    if (summary?.activity && row.note) {
      summary.activity.note = row.note; // 用户备注（体感/路况等），AI 复盘时纳入考量
    }
    return summary;
  } catch {
    return null;
  }
}

const VALID_CATEGORIES = new Set(['training', 'race', 'recovery', 'leisure']);

/** 分类枚举（有序，供详情页分类 chips 等界面遍历；与 VALID_CATEGORIES 同源） */
export const CATEGORY_KEYS = [...VALID_CATEGORIES] as const;

/** 校验训练分类是否合法 */
export function isValidCategory(category: unknown): boolean {
  return VALID_CATEGORIES.has(category as string);
}

/** 更新训练分类（训练/比赛/恢复/休闲），非法值或训练不存在抛 Error */
export async function setActivityCategory(uuid: string, category: string, lang: Lang = 'zh'): Promise<void> {
  if (!isValidCategory(category)) throw new Error(t(lang, 'category.invalid'));
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET category = ? WHERE uuid = ?`,
    category,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
  invalidateDb('activities', uuid);
}

// 备注长度上限（自由文本：体感/路况等），防止误贴大段内容撑爆训练库与提示词
const NOTE_MAX_LEN = 2000;

/** 更新训练备注（空串/纯空白清除）；训练不存在抛 Error */
export async function setActivityNote(uuid: string, note: string, lang: Lang = 'zh'): Promise<void> {
  const text = String(note ?? '').trim();
  if (text.length > NOTE_MAX_LEN)
    throw new Error(t(lang, 'note.too_long', { n: NOTE_MAX_LEN }));
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET note = ? WHERE uuid = ?`,
    text || null,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
  invalidateDb('activities', uuid);
}

// ---------------- 功率可信度标记（v2：activities.power_flagged） ----------------

/**
 * 标记/取消某骑行的「功率不可信」（用户在详情页或 AI 经 set_power_flag 触发）。
 * 语义是"功率失真"而非"整趟作废"：档案聚合层据此把该骑行从功率派生基线
 * （峰功率/分区/爬坡/踏频风格/周 TSS）排除，心率漂移与时长仍采信。
 * 训练不存在抛 Error；调用方负责随后触发 rebuildDossierQuietly。
 */
export async function setActivityPowerFlag(
  uuid: string,
  flagged: boolean,
  lang: Lang = 'zh',
): Promise<void> {
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET power_flagged = ? WHERE uuid = ?`,
    flagged ? 1 : 0,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
  // 功率标记改变档案聚合口径（详情页横幅 + 首页健康瓦片 + 档案页都要重取）
  invalidateDb('activities', uuid);
}

/** 该骑行是否被标记功率不可信（详情页横幅展示用；不存在返回 false） */
export async function getActivityPowerFlag(uuid: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ power_flagged: number }>(
    `SELECT power_flagged FROM activities WHERE uuid = ?`,
    uuid,
  );
  return !!row?.power_flagged;
}

// ---------------- 训练记录的去重 / 删除 / 合并（M5，v3 改 uuid） ----------------

/**
 * 全表骑行键（含用户数据列）：导入查重（core/dedupe.decideImport）、数据管理页的
 * 重复检查、AI 报告标题取骑行信息共用。表规模为个人训练量（数百行），一次全量
 * 取回后在内存里比对，比在 SQL 里表达带容差的指纹简洁得多。
 * id 仅作「最早入库」排序；uuid 是对外身份；fingerprint 供精确重挂。
 */
export interface ActivityRideKey {
  id: number;
  uuid: string;
  file_name: string;
  fingerprint: string;
  date: string;
  sport: string;
  duration_sec: number | null;
  distance_km: number | null;
  category: string;
  note: string | null;
}

/** 全部训练的骑行键（按 id 升序 = 入库先后，合并重复时以最先入库者为保留项） */
export async function listActivityRideKeys(): Promise<ActivityRideKey[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    uuid: string;
    file_name: string;
    fingerprint: string;
    date: string;
    sport: string | null;
    duration_sec: number | null;
    distance_km: number | null;
    category: string | null;
    note: string | null;
  }>(
    `SELECT id, uuid, file_name, fingerprint, date, sport, duration_sec, distance_km, category, note
     FROM activities ORDER BY id ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    file_name: r.file_name,
    fingerprint: r.fingerprint,
    date: r.date,
    sport: r.sport ?? 'unknown',
    duration_sec: r.duration_sec,
    distance_km: r.distance_km,
    category: r.category ?? 'training',
    note: r.note,
  }));
}

/**
 * 删除单条训练（行 + 分类/备注随之消失），返回删除条数（0 = 不存在）。
 * 删除前把活动指纹覆盖到报告/对话引用上——外键 ON DELETE SET NULL
 * 会把 uuid 清空，但指纹留下，重新导入同一趟骑行时才能自动重挂（v3）。
 * 逐秒 records 文件不在本层处理（调用方按 uuid 删）。
 */
export async function deleteActivity(uuid: string): Promise<number> {
  const db = await getDb();
  let changes = 0;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ fingerprint: string }>(
      `SELECT fingerprint FROM activities WHERE uuid = ?`,
      uuid,
    );
    if (!row) return;
    await db.runAsync(
      `UPDATE ai_reports SET activity_fingerprint = ? WHERE activity_uuid = ?`,
      row.fingerprint,
      uuid,
    );
    await db.runAsync(
      `UPDATE ai_reports SET compare_fingerprint = ? WHERE compare_uuid = ?`,
      row.fingerprint,
      uuid,
    );
    await db.runAsync(
      `UPDATE ai_chats SET activity_fingerprint = ? WHERE activity_uuid = ?`,
      row.fingerprint,
      uuid,
    );
    const info = await db.runAsync(`DELETE FROM activities WHERE uuid = ?`, uuid);
    changes = info.changes;
  });
  // 事务已提交才发（订阅方重查要看到已提交状态）；删除同时改了报告/对话的引用列
  if (changes > 0) {
    invalidateDb('activities', uuid);
    invalidateDb('reports');
    invalidateDb('chats');
  }
  return changes;
}

/**
 * 孤儿报告/对话自动重挂：活动删除后引用变 NULL 但指纹留下；同一趟骑行重新导入
 * （新 uuid）后，按精确指纹把悬空引用挂回新活动。返回重挂的引用条数。
 */
export async function reattachOrphanRefs(fingerprint: string, uuid: string): Promise<number> {
  if (!fingerprint) return 0;
  const db = await getDb();
  let total = 0;
  await db.withTransactionAsync(async () => {
    for (const sql of [
      `UPDATE ai_reports SET activity_uuid = ?
       WHERE activity_uuid IS NULL AND activity_fingerprint = ?`,
      `UPDATE ai_reports SET compare_uuid = ?
       WHERE compare_uuid IS NULL AND compare_fingerprint = ?`,
      `UPDATE ai_chats SET activity_uuid = ?
       WHERE activity_uuid IS NULL AND activity_fingerprint = ?`,
    ]) {
      const info = await db.runAsync(sql, uuid, fingerprint);
      total += info.changes;
    }
  });
  // 重挂把孤儿报告/对话挂回活动：报告标题与活动列表的关联展示都要重取
  if (total > 0) {
    invalidateDb('activities', uuid);
    invalidateDb('reports');
    invalidateDb('chats');
  }
  return total;
}

/**
 * 合并重复的 DB 侧原子操作（extras → 引用重挂 → 删副本，一个事务）：
 * 任一步失败整体回滚，避免「引用已改、行未删」的中间态。records 文件由调用方在
 * 事务前后用 uuid 处理（复制在前、删除在后）。
 * 返回被重挂的报告数。
 */
export async function mergeActivityRows(keepUuid: string, dropUuid: string): Promise<number> {
  const db = await getDb();
  let reports = 0;
  await db.withTransactionAsync(async () => {
    const drop = await db.getFirstAsync<{ fingerprint: string; category: string | null; note: string | null; power_flagged: number }>(
      `SELECT fingerprint, category, note, power_flagged FROM activities WHERE uuid = ?`,
      dropUuid,
    );
    if (!drop) return;
    await db.runAsync(
      `UPDATE activities SET
         category = CASE WHEN ? <> 'training' AND category = 'training' THEN ? ELSE category END,
         note     = CASE WHEN ? IS NOT NULL AND (note IS NULL OR note = '') THEN ? ELSE note END,
         power_flagged = CASE WHEN ? = 1 THEN 1 ELSE power_flagged END
       WHERE uuid = ?`,
      drop.category ?? 'training',
      drop.category ?? 'training',
      drop.note,
      drop.note,
      drop.power_flagged,
      keepUuid,
    );
    const keepFp = await db.getFirstAsync<{ fingerprint: string }>(
      `SELECT fingerprint FROM activities WHERE uuid = ?`,
      keepUuid,
    );
    if (!keepFp) throw new Error(t('zh', 'activity.not_found'));
    const moved = await db.runAsync(
      `UPDATE ai_reports SET activity_uuid = ?, activity_fingerprint = ?
       WHERE activity_uuid = ?`,
      keepUuid,
      keepFp.fingerprint,
      dropUuid,
    );
    reports = moved.changes;
    await db.runAsync(
      `UPDATE ai_reports SET compare_uuid = ?, compare_fingerprint = ?
       WHERE compare_uuid = ?`,
      keepUuid,
      keepFp.fingerprint,
      dropUuid,
    );
    await db.runAsync(
      `UPDATE ai_chats SET activity_uuid = ?, activity_fingerprint = ?
       WHERE activity_uuid = ?`,
      keepUuid,
      keepFp.fingerprint,
      dropUuid,
    );
    await db.runAsync(`DELETE FROM activities WHERE uuid = ?`, dropUuid);
  });
  // 合并改了保留项的 extras、删了副本、把引用重挂到保留项：三条域都要重取
  invalidateDb('activities', keepUuid);
  invalidateDb('activities', dropUuid);
  invalidateDb('reports');
  invalidateDb('chats');
  return reports;
}

// ---------------- CTL/ATL/TSB（递推在 core/form，本层查询注入） ----------------

/** [起始, endDate] 范围内逐日 TSS（按天聚合，缺天补 0）→ 连续逐日序列 */
async function dailyTssSeries(endDate: string) {
  const db = await getDb();
  const rows = await db.getAllAsync<{ date: string; tss: number }>(
    `SELECT date, SUM(COALESCE(tss, 0)) AS tss
     FROM activities WHERE date <= ? GROUP BY date ORDER BY date`,
    endDate,
  );
  return fillDailyTss(rows, endDate);
}

/** 到 date（含）当天的 CTL/ATL/TSB 快照（口径与旧版 computeForm 一致）；训练库为空返回 null */
export async function computeForm(date: string, lang: Lang = 'zh') {
  const series = await dailyTssSeries(date);
  return formSnapshotAtEnd(series, lang);
}

/**
 * 最近 N 天逐日负荷序列 [{ date, tss, ctl, atl, tsb }]（口径与旧版 recentFormDaily 一致）。
 * 递推用 core/form 的 formSeriesDaily；序列末端延伸到今天（无训练日 TSS=0 照常参与
 * 衰减），趋势图与「当前体能指数」反映今天而不是停在最后一次训练的日期。
 * 默认 90 天为仪表盘趋势图口径（Web 版 dashboard 同款）。
 * 今天锚取本地日历日（双口径统一，2026-10）：末端=本地今天，清晨骑行计入今日负荷；
 * 内部日行标签仍沿 activities.date 的 UTC 日口径（聚合桶，段落/图轴只到月粒度）。
 */
export async function recentFormDaily(days = 90): Promise<{ date: string; tss: number; ctl: number; atl: number; tsb: number }[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ d: string | null }>(`SELECT MAX(date) AS d FROM activities`);
  if (!row?.d) return [];
  const today = localDay();
  const series = await dailyTssSeries(row.d < today ? today : row.d);
  return formSeriesDaily(series).slice(-days);
}

// ---------------- 月度汇总（归并计算在 core/monthly，本层只查询） ----------------

/** 最近 n 个月汇总（月 TSS/时长/距离/次数 + 强度占比与类型，口径与旧版 monthlySummary 一致） */
export async function monthlySummary(n = 6): Promise<MonthlyItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MonthlyRow>(
    `SELECT date, duration_sec, distance_km, tss, summary_json
     FROM activities ORDER BY date DESC`,
  );
  return monthlySummaryFromRows(rows, n);
}

// ---------------- FTP 历史估算取数（估算算法在 core/ftp，本层只查询） ----------------

/** 最近 N 天内的骑行训练完整 summary（FTP 估算输入，按日期倒序；口径与旧版 cyclingSummariesSince 一致） */
export async function cyclingSummariesSince(days = 42): Promise<CyclingRideInput[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ d: string | null }>(`SELECT MAX(date) AS d FROM activities`);
  if (!row?.d) return [];
  const since = new Date(row.d + 'T00:00:00Z');
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    duration_sec: number | null;
    power_flagged: number;
    summary_json: string;
  }>(
    `SELECT uuid, file_name, date, duration_sec, power_flagged, summary_json
     FROM activities
     WHERE sport = 'cycling' AND date >= ?
     ORDER BY date DESC`,
    sinceStr,
  );
  const out: CyclingRideInput[] = [];
  for (const r of rows) {
    try {
      out.push({
        uuid: r.uuid,
        file_name: r.file_name,
        date: r.date,
        duration_sec: r.duration_sec,
        power_flagged: !!r.power_flagged,
        summary: JSON.parse(r.summary_json),
      });
    } catch {
      // 存档 JSON 损坏时跳过该条
    }
  }
  return out;
}

// ---------------- 同步/备份辅助查询 ----------------

/** 全部活动文件名（同步按文件名幂等去重的本地集合） */
export async function listActivityFileNames(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ file_name: string }>('SELECT file_name FROM activities');
  return rows.map((r) => r.file_name);
}

/** 全部活动 uuid（备份导出按它过滤 records 孤儿文件） */
export async function listActivityUuids(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM activities');
  return rows.map((r) => r.uuid);
}

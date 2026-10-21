/**
 * dossier.ts — 个人训练档案缓存域（settings 表 dossier 行，v2）
 *
 * 聚合计算在 core/dossier（确定性、零 token），本层负责缓存行读写：指纹
 * （活动总数 + FTP）命中直接返回，miss 自愈重建；数据变更触发点调
 * rebuildDossierQuietly（fire-and-forget + 并发合并）。
 */

import { getDb } from './client';
import type { Summary } from '@/core/analyze';
import { buildDossier, type AthleteDossier } from '@/core/dossier';
import { countActivities, monthlySummary } from './activities';
import { getEffectiveAthlete } from './athlete';

/** 档案缓存行结构：dossier + 指纹（活动总数 + FTP）+ 结构版本（Dossier 字段演进时递增，旧结构直接重建，防深层取值崩掉报告生成链路——code-review P2-4）
 * v2（2026-10-17）：intensity_structure 增加 hr_zone_pct（业余单锚点降级）——旧缓存没
 * 这个字段，不升版会让新心率结构行在下次数据变更前一直缺失。 */
const DOSSIER_CACHE_SHAPE = 2;
interface DossierCacheEntry {
  shape: number;
  dossier: AthleteDossier;
  fingerprint: { rides: number; ftp: number };
}

/**
 * 当前个人训练档案（提示词注入与档案页共用入口）。
 * 缓存命中条件 = 指纹一致（活动总数与 FTP 均未变）；导入/删除/合并/改 FTP/
 * 标记功率/重算等变更点各自显式调 rebuildDossierQuietly，指纹只兜底覆盖
 * 遗漏路径（备份导入后首次读取、缓存行损坏等）——miss 时同步重建并写回。
 * 无骑行数据返回 null（提示词侧整段省略、UI 显示空态）。
 */
export async function getDossier(): Promise<AthleteDossier | null> {
  const db = await getDb();
  const [row, total, athlete] = await Promise.all([
    db.getFirstAsync<{ value: string }>(`SELECT value FROM settings WHERE key = 'dossier'`),
    countActivities(),
    getEffectiveAthlete(),
  ]);
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as DossierCacheEntry;
      if (
        parsed?.dossier &&
        parsed?.shape === DOSSIER_CACHE_SHAPE &&
        parsed?.fingerprint?.rides === total &&
        parsed?.fingerprint?.ftp === athlete.ftp_watts
      ) {
        return parsed.dossier;
      }
    } catch {
      // 缓存行损坏走重建
    }
  }
  return rebuildDossier();
}

/** 全部骑行行 → 档案聚合输入（损坏 summary 行按无数据参与，计数仍准确） */
async function loadDossierRides() {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    sport: string | null;
    duration_sec: number | null;
    tss: number | null;
    power_flagged: number;
    summary_json: string;
  }>(
    `SELECT uuid, file_name, date, sport, duration_sec, tss, power_flagged, summary_json
     FROM activities WHERE sport = 'cycling'
     ORDER BY date ASC, id ASC`,
  );
  return rows.map((r) => {
    let summary: Summary | null = null;
    try {
      summary = JSON.parse(r.summary_json) as Summary;
    } catch {
      // 存档 JSON 损坏：该行按无 summary 参与（只进时长/计数口径）
    }
    return {
      uuid: r.uuid,
      file_name: r.file_name,
      date: r.date,
      sport: r.sport ?? 'unknown',
      power_flagged: !!r.power_flagged,
      duration_sec: r.duration_sec,
      tss: r.tss,
      summary,
    };
  });
}

/** 重建档案并写缓存（getDossier 与 rebuildDossierQuietly 的共用实现） */
async function rebuildDossier(): Promise<AthleteDossier | null> {
  const [rides, athlete, monthly, total] = await Promise.all([
    loadDossierRides(),
    getEffectiveAthlete(),
    monthlySummary(6),
    countActivities(),
  ]);
  const dossier = buildDossier(
    rides,
    athlete.ftp_watts,
    monthly.map((m) => ({ month: m.month, type: m.intensity_type })),
    new Date(),
  );
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('dossier', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify({
      shape: DOSSIER_CACHE_SHAPE,
      dossier,
      fingerprint: { rides: total, ftp: athlete.ftp_watts },
    }),
  );
  return dossier;
}

let dossierRolling = false;
let dossierRerollPending = false;

/**
 * 静默重建档案（数据变更触发点的 fire-and-forget 入口：导入成功/删除/合并/
 * FTP 变更/功率标记变更/重算/校准之后调用；失败仅警告——下次读取时指纹仍会
 * 自愈重建，不得影响主流程结果，口径同本地快照滚动）。并发合并：批量导入/
 * 顽鹿同步连发 N 次触发只在链尾多补一次，不做 N 次全库重算。
 */
export async function rebuildDossierQuietly(): Promise<void> {
  if (dossierRolling) {
    dossierRerollPending = true;
    return;
  }
  dossierRolling = true;
  try {
    do {
      dossierRerollPending = false;
      try {
        await rebuildDossier();
      } catch (e) {
        console.warn('训练档案重建失败（下次读取时自愈）:', e);
      }
    } while (dossierRerollPending);
  } finally {
    dossierRolling = false;
  }
}

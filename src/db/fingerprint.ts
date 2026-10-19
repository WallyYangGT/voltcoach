/**
 * fingerprint.ts — 存量室内骑行的内容指纹回填（v3 迁移补齐）
 *
 * 背景：v2 迁移回填指纹时没有 records 首帧可读，只能写
 * `date|duration|distance`；而 v3 新导入的无距离（室内）骑行指纹是
 * `date|duration||start_at`。不补齐的话，升级前已有的室内骑行在「删除 →
 * 重新导入」后指纹永远不相等，孤儿报告/追问无法重挂（code-review P1-1）。
 *
 * 本函数在 records 布局迁移完成后运行：对无有效距离且指纹仍是旧格式的活动，
 * 读 records 首帧重算指纹，并同步仍挂着旧值的报告/对话引用（按 uuid 精确定位，
 * 避免同日同时长的两场室内课互相覆盖）。records 缺失的活动保持旧指纹（无法重挂，
 * 与「v3 前孤儿无指纹」同一已知边界）。
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { rideFingerprint } from '../core/dedupe.ts';
import { isActivityUuid } from '../core/identity.ts';

export interface FingerprintRow {
  uuid: string;
  date: string;
  duration_sec: number | null;
  distance_km: number | null;
  fingerprint: string;
}

/**
 * 回填室内骑行指纹，返回修正条数。幂等：已含起骑时刻（第 4 段）的行直接跳过；
 * 读不到 records 首帧的行保留旧值并告警。失败由调用方兜底（下次开库重试）。
 */
export async function backfillIndoorFingerprints(
  db: Pick<SQLiteDatabase, 'getAllAsync' | 'runAsync' | 'withTransactionAsync'>,
  readStart: (uuid: string) => Promise<string | null>,
): Promise<number> {
  const rows = await db.getAllAsync<FingerprintRow>(
    `SELECT uuid, date, duration_sec, distance_km, fingerprint
     FROM activities
     WHERE distance_km IS NULL OR distance_km <= 0`,
  );
  let fixed = 0;
  for (const r of rows) {
    if (!isActivityUuid(r.uuid)) continue;
    // 新格式多一段起骑时刻；旧格式（迁移回填）只有 3 段
    if (r.fingerprint.split('|').length >= 4) continue;
    const startAt = await readStart(r.uuid);
    if (!startAt) {
      console.warn(`室内骑行指纹回填跳过（缺 records 首帧）: ${r.uuid}`);
      continue;
    }
    const next = rideFingerprint({
      date: r.date,
      duration_sec: r.duration_sec,
      distance_km: r.distance_km,
      start_at: startAt,
    });
    if (next === r.fingerprint) continue;
    // 四表更新放同一事务：活动先变 4 段、引用仍 3 段时被杀，重跑会因活动已新格式
    // 而跳过（code-review P3）。事务失败整体回滚，下次开库重试。
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `UPDATE activities SET fingerprint = ? WHERE uuid = ? AND fingerprint = ?`,
        next,
        r.uuid,
        r.fingerprint,
      );
      await db.runAsync(
        `UPDATE ai_reports SET activity_fingerprint = ?
         WHERE activity_uuid = ? AND activity_fingerprint = ?`,
        next,
        r.uuid,
        r.fingerprint,
      );
      await db.runAsync(
        `UPDATE ai_reports SET compare_fingerprint = ?
         WHERE compare_uuid = ? AND compare_fingerprint = ?`,
        next,
        r.uuid,
        r.fingerprint,
      );
      await db.runAsync(
        `UPDATE ai_chats SET activity_fingerprint = ?
         WHERE activity_uuid = ? AND activity_fingerprint = ?`,
        next,
        r.uuid,
        r.fingerprint,
      );
    });
    fixed += 1;
  }
  return fixed;
}

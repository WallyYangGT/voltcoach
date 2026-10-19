/**
 * records-store.ts — 逐秒 records 的落盘与读取（每活动一个 gzip 压缩 CSV）
 *
 * 旧版（reference）写 `<base>.records.csv` 明文到 output/ 目录；App 端按
 * M4 起改为 gzip 压缩存储（单次 4h 骑行 gzip 后约 50–150KB，
 * 不入库防止训练库膨胀）：CSV 序列化在 core/analyze.recordsToCsv（列序与旧版
 * 逐字一致，解压后即旧版格式），压缩/解压用 pako（纯 JS，Hermes 可跑）。
 *
 * 文件布局（v3，2026-10-19，decisions §34）：
 *   documentDirectory/records/<activity uuid>.records.csv.gz
 * v2 及以前是 `<file_name 去扩展名>`，由 ensureRecordFileLayout 在开库后一次性
 * 迁移（旧基名可能被多条活动共享，逐条复制后再删旧文件）。
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
// pako 3 只有命名导出（无 default export），default 导入在 Metro 下为 undefined
import { gzip, ungzip } from 'pako';
import { recordsToCsv, type SecRecord } from '@/core/analyze';
import {
  firstRecordTimestampFromGz,
  isActivityRecordBase,
  parseRecordsCsv,
  planRecordLayout,
  safeName,
} from '@/core/records';
import { backfillIndoorFingerprints } from '@/db/fingerprint';

/** records 存放目录（注意：目录用 Directory.create()——File.create() 建的是文件） */
function recordsDir(): Directory {
  return new Directory(Paths.document, 'records');
}

/** 活动 uuid → records 存储文件（非 uuid 一律拒绝：开发者向 invariant，正常不触发） */
function recordsFile(uuid: string): File | null {
  if (!isActivityRecordBase(uuid)) return null;
  return new File(recordsDir(), `${uuid}.records.csv.gz`);
}

/** 逐秒记录 → CSV → gzip → 落盘（原子覆盖写：同一 uuid 的重导入/重算即更新） */
export async function saveRecords(uuid: string, records: SecRecord[]): Promise<void> {
  if (!isActivityRecordBase(uuid)) throw new Error(`Invalid records activity id: ${uuid}`);
  const gz = gzip(recordsToCsv(records));
  // 复用 writeStoredRecordGz 的“临时文件 + 原子改名”，避免被杀时留下截断文件
  await writeStoredRecordGz(uuid, gz as unknown as Uint8Array);
}

/** 读取并解压为逐秒记录数组；文件不存在返回 null（详情页/图表降级口径） */
export async function loadStoredRecords(uuid: string): Promise<SecRecord[] | null> {
  const file = recordsFile(uuid);
  if (!file || !file.exists) return null;
  const gz = await file.bytes();
  const csv = ungzip(gz, { toText: true }); // pako 3：toText 解码为 UTF-8 文本
  return parseRecordsCsv(csv);
}

// ---------------- 备份打包/恢复支撑（M4，records 整目录进出备份包） ----------------

/** 列出已存储 records 的 base 名（备份打包用；目录不存在返回空表） */
export async function listStoredRecordBases(): Promise<string[]> {
  const dir = recordsDir();
  if (!dir.exists) return [];
  const bases: string[] = [];
  for (const entry of dir.list()) {
    if (!(entry instanceof File)) continue;
    if (!entry.name.endsWith('.records.csv.gz')) continue;
    const base = entry.name.slice(0, -'.records.csv.gz'.length);
    if (safeName(base) === base) bases.push(base);
  }
  return bases.sort();
}

/** 读取已存储 records 的 gzip 原始字节（备份打包用，不解压；缺失返回 null） */
export async function readStoredRecordGz(base: string): Promise<Uint8Array | null> {
  const safe = safeName(base);
  if (!safe || safe !== base) return null;
  const file = new File(recordsDir(), `${safe}.records.csv.gz`);
  if (!file.exists) return null;
  return file.bytes();
}

/** 直写 gzip 字节（备份导入恢复/布局迁移用；不解压，base 过 safeName 防穿越）。
 *  先写 `.tmp` 再原子改名：进程在写盘中途被杀不会留下「已存在但截断」的目标文件，
 *  布局迁移因而可以安全地以「目标存在」作为已完成判据并在之后删除旧基名。 */
export async function writeStoredRecordGz(base: string, gz: Uint8Array): Promise<void> {
  const safe = safeName(base);
  if (!safe || safe !== base) throw new Error(`Invalid records file name: ${base}`);
  const dir = recordsDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const tmpName = `${safe}.records.csv.gz.tmp`;
  const tmp = new File(dir, tmpName);
  tmp.write(gz as unknown as Uint8Array);
  try {
    await tmp.move(new File(dir, `${safe}.records.csv.gz`), { overwrite: true });
  } finally {
    // move 成功后实例 uri 会指向目标文件：清理必须用新实例，绝不能删已就位的目标
    const residue = new File(dir, tmpName);
    if (residue.exists) {
      try {
        residue.delete();
      } catch {
        // 残留 tmp 不阻塞读取（listStoredRecordBases 只认 .records.csv.gz）
      }
    }
  }
}

/** 删除一个 records 基名文件（布局迁移清理旧基名用；不存在幂等） */
export function deleteStoredRecordBase(base: string): void {
  const safe = safeName(base);
  if (!safe || safe !== base) return;
  const file = new File(recordsDir(), `${safe}.records.csv.gz`);
  if (file.exists) file.delete();
}

/** 清空 records 目录（备份导入整库替换用；目录不存在幂等） */
export function clearStoredRecords(): void {
  const dir = recordsDir();
  if (dir.exists) dir.delete();
}

// ---------------- 单条删除/接管（M5：删除训练与合并重复；v3 按 uuid） ----------------

/** 该活动是否有落盘的逐秒数据（合并重复时判断保留项是否缺数据） */
export function hasStoredRecord(uuid: string): boolean {
  const file = recordsFile(uuid);
  return !!file && file.exists;
}

/** 删除单条训练的逐秒数据（不存在幂等，不抛错）；uuid 非法直接返回 */
export function deleteStoredRecord(uuid: string): void {
  const file = recordsFile(uuid);
  if (file && file.exists) file.delete();
}

/**
 * 把 to 的逐秒数据接管自 from（合并重复：保留项没有 records、副本有时用）。
 * 返回是否真的复制了；to 已有数据时不覆盖。
 */
export async function copyStoredRecord(fromUuid: string, toUuid: string): Promise<boolean> {
  if (!isActivityRecordBase(toUuid)) return false;
  if (hasStoredRecord(toUuid)) return false;
  const src = recordsFile(fromUuid);
  if (!src || !src.exists) return false;
  // 原子写：复制中断不会让目标文件“存在但截断”（否则下次合并会误判已接管并删源）
  await writeStoredRecordGz(toUuid, await src.bytes());
  return true;
}

/** 读取首帧时间戳（起骑时刻，ISO UTC；AI 报告标题用）；无文件/数据异常返回 null */
export async function readStoredRecordStart(uuid: string): Promise<string | null> {
  const file = recordsFile(uuid);
  if (!file || !file.exists) return null;
  try {
    return firstRecordTimestampFromGz(await file.bytes());
  } catch (e) {
    console.warn(`records 首帧时间读取失败: ${uuid}:`, e);
    return null;
  }
}

// ---------------- v2 → v3 文件布局迁移（开库后跑一次，幂等） ----------------

const RECORDS_LAYOUT_KEY = 'records_layout_version';
// 2 = uuid 布局；3 = 布局 + 室内指纹回填（同一 reconciler 幂等重跑一次）
const RECORDS_LAYOUT_VERSION = '3';

/**
 * 把 v2 的 `<file_name>.records.csv.gz` 迁移到 `<uuid>.records.csv.gz`：
 *  - settings 标记 `records_layout_version=3` 后直接返回（每次开库只做一次）；
 *  - 先复制全部旧基名到各自 uuid（共享基名复制多份），全部成功后再删旧文件；
 *  - 任一步失败只告警、不写标记，下次开库重试；详情页按既有“records 缺失”降级。
 * 备份导入在 staged 库上预迁移并按映射写 uuid 文件，本函数是设备升级路径的兜底。
 */
export async function ensureRecordFileLayout(db: SQLiteDatabase): Promise<void> {
  try {
    const marker = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM settings WHERE key = ?`,
      RECORDS_LAYOUT_KEY,
    );
    if (marker?.value === RECORDS_LAYOUT_VERSION) return;
    const activities = await db.getAllAsync<{ uuid: string; file_name: string }>(
      `SELECT uuid, file_name FROM activities`,
    );
    const existing = await listStoredRecordBases();
    const plan = planRecordLayout(activities, existing);
    for (const copy of plan.copies) {
      const gz = await readStoredRecordGz(copy.from);
      if (gz) await writeStoredRecordGz(copy.to, gz);
    }
    for (const base of plan.deletes) deleteStoredRecordBase(base);
    // 布局就位后再补齐室内骑行指纹（旧回填格式没有起骑时刻，重挂会精确匹配失败）
    const fingerprinted = await backfillIndoorFingerprints(db, readStoredRecordStart);
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      RECORDS_LAYOUT_KEY,
      RECORDS_LAYOUT_VERSION,
    );
    if (plan.copies.length || plan.deletes.length)
      console.info(
        `records 布局迁移完成: 复制 ${plan.copies.length} 条，清理旧基名 ${plan.deletes.length} 个`,
      );
    if (fingerprinted) console.info(`室内骑行指纹回填完成: ${fingerprinted} 条`);
  } catch (e) {
    console.warn('records 文件布局迁移失败（下次开库重试）:', e);
  }
}

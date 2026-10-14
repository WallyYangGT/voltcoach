/**
 * records-store.ts — 逐秒 records 的落盘与读取（每活动一个 gzip 压缩 CSV）
 *
 * 旧版（reference）写 `<base>.records.csv` 明文到 output/ 目录；App 端按
 * M4 起改为 gzip 压缩存储（单次 4h 骑行 gzip 后约 50–150KB，
 * 不入库防止训练库膨胀）：CSV 序列化在 core/analyze.recordsToCsv（列序与旧版
 * 逐字一致，解压后即旧版格式），压缩/解压用 pako（纯 JS，Hermes 可跑）。
 *
 * 文件布局：documentDirectory/records/<base>.records.csv.gz
 * M5 追加单条删除/接管/首帧时间读取（删除训练与合并重复、AI 报告标题用）。
 */

import { Directory, File, Paths } from 'expo-file-system';
// pako 3 只有命名导出（无 default export），default 导入在 Metro 下为 undefined
import { gzip, ungzip } from 'pako';
import { recordsToCsv, type SecRecord } from '@/core/analyze';
import { firstRecordTimestampFromGz, parseRecordsCsv, safeName } from '@/core/records';

/** records 存放目录（注意：目录用 Directory.create()——File.create() 建的是文件） */
function recordsDir(): Directory {
  return new Directory(Paths.document, 'records');
}

/** 训练文件名 → records 存储文件（basename 安全化 + 去扩展名，防止路径穿越） */
function recordsFile(fileName: string): File | null {
  const safe = safeName(fileName);
  if (!safe) return null;
  const base = safe.replace(/\.[^.]+$/, '');
  return new File(recordsDir(), `${base}.records.csv.gz`);
}

/** 逐秒记录 → CSV → gzip → 落盘（覆盖写，重复导入同文件名即更新） */
export async function saveRecords(fileName: string, records: SecRecord[]): Promise<void> {
  const file = recordsFile(fileName);
  // 开发者向 invariant（文件名来自导入管线，正常不触发）：非用户文案，不走 i18n
  if (!file) throw new Error(`Invalid records file name: ${fileName}`);
  const dir = recordsDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const gz = gzip(recordsToCsv(records));
  file.write(gz as unknown as Uint8Array);
}

/** 读取并解压为逐秒记录数组；文件不存在返回 null（详情页/图表降级口径） */
export async function loadStoredRecords(fileName: string): Promise<SecRecord[] | null> {
  const file = recordsFile(fileName);
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

/** 直写 gzip 字节（备份导入恢复用；不解压，base 过 safeName 防穿越） */
export async function writeStoredRecordGz(base: string, gz: Uint8Array): Promise<void> {
  const safe = safeName(base);
  if (!safe) throw new Error(`Invalid records file name: ${base}`);
  const dir = recordsDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  new File(dir, `${safe}.records.csv.gz`).write(gz as unknown as Uint8Array);
}

/** 清空 records 目录（备份导入整库替换用；目录不存在幂等） */
export function clearStoredRecords(): void {
  const dir = recordsDir();
  if (dir.exists) dir.delete();
}

// ---------------- 单条删除/接管（M5：删除训练与合并重复） ----------------

/** 该训练是否有落盘的逐秒数据（合并重复时判断保留项是否缺数据） */
export function hasStoredRecord(fileName: string): boolean {
  const file = recordsFile(fileName);
  return !!file && file.exists;
}

/** 删除单条训练的逐秒数据（不存在幂等，不抛错）；文件名非法直接返回 */
export function deleteStoredRecord(fileName: string): void {
  const file = recordsFile(fileName);
  if (file && file.exists) file.delete();
}

/**
 * 把 to 的逐秒数据接管自 from（合并重复：保留项没有 records、副本有时用）。
 * 返回是否真的复制了；to 已有数据时不覆盖。
 */
export async function copyStoredRecord(fromFileName: string, toFileName: string): Promise<boolean> {
  if (hasStoredRecord(toFileName)) return false;
  const src = recordsFile(fromFileName);
  const dst = recordsFile(toFileName);
  if (!src || !dst || !src.exists) return false;
  const dir = recordsDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  dst.write(await src.bytes());
  return true;
}

/** 读取首帧时间戳（起骑时刻，ISO UTC；AI 报告标题用）；无文件/数据异常返回 null */
export async function readStoredRecordStart(fileName: string): Promise<string | null> {
  const file = recordsFile(fileName);
  if (!file || !file.exists) return null;
  try {
    return firstRecordTimestampFromGz(await file.bytes());
  } catch (e) {
    console.warn(`records 首帧时间读取失败: ${fileName}:`, e);
    return null;
  }
}

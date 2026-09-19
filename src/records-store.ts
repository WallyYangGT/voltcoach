/**
 * records-store.ts — 逐秒 records 的落盘与读取（每活动一个 gzip 压缩 CSV）
 *
 * 旧版（reference）写 `<base>.records.csv` 明文到 output/ 目录；App 端按
 * MIGRATION_PLAN §7.2 改为 gzip 压缩存储（单次 4h 骑行 gzip 后约 50–150KB，
 * 不入库防止训练库膨胀）：CSV 序列化在 core/analyze.recordsToCsv（列序与旧版
 * 逐字一致，解压后即旧版格式），压缩/解压用 pako（纯 JS，Hermes 可跑）。
 *
 * 文件布局：documentDirectory/records/<base>.records.csv.gz
 */

import { Directory, File, Paths } from 'expo-file-system';
// pako 3 只有命名导出（无 default export），default 导入在 Metro 下为 undefined
import { gzip, ungzip } from 'pako';
import { recordsToCsv, type SecRecord } from '@/core/analyze';
import { parseRecordsCsv, safeName } from '@/core/records';

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
  if (!file) throw new Error(`非法文件名: ${fileName}`);
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

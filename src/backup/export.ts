/**
 * export.ts — 备份导出与本地快照（MIGRATION_PLAN §7.2）
 *
 * 两条产出路径：
 *  - buildBackup/exportBackupToCache：完整备份包 → cache/exports/，由 UI 经
 *    expo-sharing 系统分享落用户自选位置（文件管理器/网盘/微信，§7.1 方案 A）；
 *  - createLocalSnapshot：无口令（本机 key 随包）滚动快照写 document/backups/，
 *    由导入服务在每次入库后 fire-and-forget 触发（§7.2 触发点，空间换安全）。
 *
 * 口令语义（§7.2 SQLCipher 交互定稿）：设口令 → 包内库用口令派生密钥重加密，
 * manifest.db_key=null（导入需重输口令）；不设 → 包内库用本机 key，db_key 随包
 * 写入（防随手翻文件，不防拿到完整包的人）。备份不含 AI Key 与顽鹿账号——
 * 它们存系统 Keystore（expo-secure-store），按设计不随包迁移。
 */

import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { countActivities, getDb, getDbKey, SCHEMA_VERSION } from '@/db';
import { listStoredRecordBases, readStoredRecordGz } from '@/records-store';
import { bytesToUtf8, packBackup } from './archive';
import type { BackupManifest } from './manifest';
import { buildPackageDbBytes, hasSqlCipher } from './sqlite.ts';

/** 本地快照状态摘要（读写 auto-latest.json 旁车文件，避免为展示时间解包整个备份） */
export interface SnapshotInfo {
  exported_at: string;
  app_version: string;
  device: string;
  counts: { activities: number; records: number };
}

/** 备份产出物：包字节 + 清单（清单供 UI 预览与命名） */
export interface BuiltBackup {
  bytes: Uint8Array;
  manifest: BackupManifest;
}

function backupsDir(): Directory {
  return new Directory(Paths.document, 'backups');
}

function snapshotFile(): File {
  return new File(backupsDir(), 'auto-latest.fitbackup');
}

function snapshotInfoFile(): File {
  return new File(backupsDir(), 'auto-latest.json');
}

/**
 * 构建完整备份包字节。records 逐文件收进包内；单个记录文件缺失（历史脏数据）
 * 跳过不失败——manifest.counts.records 记录实际收包数，UI 可对照 activities 数。
 */
export async function buildBackup(passphrase: string | null): Promise<BuiltBackup> {
  const db = await getDb();
  const sqlcipher = await hasSqlCipher(db);
  const dbKey = sqlcipher ? await getDbKey() : null;
  const pkgKey = passphrase || dbKey; // 口令优先，其次本机 key；无 SQLCipher 为 null（明文库）

  const [dbBytes, bases, activities] = await Promise.all([
    buildPackageDbBytes(pkgKey),
    listStoredRecordBases(),
    countActivities(),
  ]);

  const records: { name: string; gz: Uint8Array }[] = [];
  for (const base of bases) {
    const gz = await readStoredRecordGz(base);
    if (gz) records.push({ name: base, gz });
  }

  const manifest: BackupManifest = {
    format: 'fitbackup',
    schema_version: SCHEMA_VERSION,
    app_version: Constants.expoConfig?.version ?? '0.0.0',
    exported_at: new Date().toISOString(),
    device: `${Platform.OS}/${Device.modelName ?? 'unknown'}`,
    db_key: sqlcipher && !passphrase ? dbKey : null,
    counts: { activities, records: records.length },
  };
  return { bytes: packBackup(manifest, dbBytes, records), manifest };
}

/** 导出备份包到 cache/exports/（文件名带 UTC 时间戳），UI 拿 uri 走系统分享 */
export async function exportBackupToCache(
  passphrase: string | null,
): Promise<{ file: File; manifest: BackupManifest }> {
  const { bytes, manifest } = await buildBackup(passphrase);
  const dir = new Directory(Paths.cache, 'exports');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const stamp = manifest.exported_at.replace(/[-:T]/g, '').slice(0, 14);
  const file = new File(dir, `voltcoach-backup-${stamp}.fitbackup`);
  file.write(bytes);
  return { file, manifest };
}

/** 无口令本地快照落盘（document/backups/auto-latest.fitbackup，覆盖滚动） */
export async function createLocalSnapshot(): Promise<SnapshotInfo> {
  const { bytes, manifest } = await buildBackup(null);
  const dir = backupsDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  snapshotFile().write(bytes);
  const info: SnapshotInfo = {
    exported_at: manifest.exported_at,
    app_version: manifest.app_version,
    device: manifest.device,
    counts: manifest.counts,
  };
  snapshotInfoFile().write(JSON.stringify(info));
  return info;
}

let rolling = false;
let rerollPending = false;

/**
 * 静默滚动快照（§7.2 触发点：每次入库成功后调用）。失败仅警告——快照是便利性
 * 兜底，不得影响导入主流程结果。并发合并：滚动进行中再有入库请求，只在链尾
 * 补滚一次（批量导入/同步 N 个文件时避免 N 次全量打包，O(N×全库) → O(全库)）。
 */
export function rollLocalSnapshotQuietly(): Promise<void> {
  if (rolling) {
    rerollPending = true;
    return Promise.resolve();
  }
  rolling = true;
  return createLocalSnapshot()
    .catch((e) => console.warn('本地快照滚动失败（忽略）:', e))
    .then(() => {
      rolling = false;
      if (rerollPending) {
        rerollPending = false;
        return rollLocalSnapshotQuietly();
      }
    });
}

/** 读取最近本地快照状态（无快照/旁车文件损坏返回 null，UI 显示未创建态） */
export async function readLocalSnapshotInfo(): Promise<SnapshotInfo | null> {
  const file = snapshotInfoFile();
  if (!file.exists) return null;
  try {
    return JSON.parse(bytesToUtf8(await file.bytes())) as SnapshotInfo;
  } catch {
    return null;
  }
}

/** 手动删除本地快照（数据管理页「清除快照」用；文件不存在幂等） */
export function deleteLocalSnapshot(): void {
  if (snapshotFile().exists) snapshotFile().delete();
  if (snapshotInfoFile().exists) snapshotInfoFile().delete();
}

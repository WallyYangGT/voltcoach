/**
 * import.ts — .fitbackup 备份导入（MIGRATION_PLAN §7.2）
 *
 * 覆盖式导入 + 防误清（§7.2 口径）：选包 → 解包校验 manifest → schema 版本闸门
 * （高于本机拒绝并提示升级 App）→ staged 库开包验证（试读，错 key/错口令在此拦下，
 * 原库无损）→ 覆盖前自动导出安全备份（document/backups/pre-import-*.fitbackup，
 * 滚动保留 3 份）→ 关库 → 原子替换（删旧 fitness.db(+wal/shm) → 重加密产物改名）
 * → records 目录清空重写 → 单例复位（各页 useFocusEffect 聚焦自刷新）。
 *
 * 替换发生之前的任何失败都只清理临时文件，原库与 records 不受影响；替换发生之后
 * 仅剩 records 写盘可能部分失败——库已换新，缺的记录文件按既有降级口径显示空图表。
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { closeDb, countActivities, getDbKey, SCHEMA_VERSION } from '@/db';
import { clearStoredRecords, writeStoredRecordGz } from '@/records-store';
import { unpackBackup } from './archive';
import { BackupError, checkSchemaVersion, type BackupManifest } from './manifest';
import { buildBackup } from './export';
import { appDbFile, fileUriToPath, hasSqlCipher, sqliteDir, sqlStr } from './sqlite.ts';

/** 导入结果（UI 成功提示展示数量口径：库内活动数 + 恢复的记录文件数） */
export interface ImportOutcome {
  activities: number;
  records: number;
}

/** 覆盖前自动安全备份的滚动保留份数 */
const PRE_IMPORT_KEEP = 3;

/**
 * 导入 .fitbackup 备份包（uri 来自 DocumentPicker，file:// 缓存路径）。
 * passphrase：用户输入的备份口令（包由口令加密时必填）；manifest 自带 db_key 的
 * 包传 null 即可。成功返回库内活动数与恢复的记录文件数。
 */
export async function importBackupFile(uri: string, passphrase: string | null): Promise<ImportOutcome> {
  const bytes = await new File(uri).bytes();

  // ① 解包 + 校验（结构/清单/版本闸门——任何一步不过即原库无损返回）
  const { manifest, db: dbBytes, records } = unpackBackup(bytes);
  checkSchemaVersion(manifest, SCHEMA_VERSION);

  const dir = sqliteDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  // ② staged 库开包验证：写临时文件 → 按包密钥策略打开试读。
  //    密钥顺序：用户口令 > manifest.db_key > 无 key 明文打开（旧 repo --export /
  //    iOS 导出）。验证失败映射稳定码——有 key 视为口令错误，无 key 视为需要口令。
  //    非 SQLCipher 构建（iOS）带不动加密库：db_key != null 的包在此前置拒绝。
  if (!(await hasSqlCipher()) && manifest.db_key !== null) {
    throw new BackupError('no_sqlcipher', '当前构建无 SQLCipher，无法导入加密备份');
  }
  const staged = new File(dir, `voltcoach-import-staged-${Date.now()}.db`);
  let conn: SQLite.SQLiteDatabase | null = null;
  try {
    staged.write(dbBytes);
    conn = await openStagedVerified(staged, manifest, passphrase);
  } catch (e) {
    cleanup(staged);
    throw e;
  }

  // ③ 覆盖前安全备份（§7.2：防误导入清库；失败即中止导入，不带病替换）
  try {
    await createPreImportBackup();
  } catch (e) {
    await closeQuietly(conn);
    cleanup(staged);
    throw new BackupError('safety_backup_failed', String(e));
  }

  // ④ 重加密到本机 key（staged → import_new），⑤ 关库原子替换，⑥ records 重写
  // 注意：File.move() 会原地改写实例 uri（指向改名后的 fitness.db），因此 finally
  // 的临时文件清理必须用 importedTmp 指向原临时名（move 成功时该名字已不存在，
  // cleanup 自然 no-op）——绝不能 cleanup 改名后的实例，否则成功路径会把刚换上的
  // 新库当"临时文件"删掉（数据销毁且当次会话不可见）。
  const importedTmp = new File(dir, `voltcoach-import-new-${Date.now()}.db`);
  try {
    if (await hasSqlCipher(conn)) {
      const localKey = await getDbKey();
      try {
        await conn.execAsync(
          `ATTACH DATABASE ${sqlStr(fileUriToPath(importedTmp))} AS import_new KEY ${sqlStr(localKey)};`,
        );
        await conn.execAsync(`SELECT sqlcipher_export('import_new');`);
        const uv = await conn.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
        await conn.execAsync(`PRAGMA import_new.user_version = ${uv?.user_version ?? 0};`);
      } finally {
        await conn.execAsync('DETACH DATABASE import_new;');
      }
    } else {
      // 无 SQLCipher 构建（iOS）：staged 已验证为明文库，直接作为替换产物
      importedTmp.write(dbBytes);
    }
    await closeQuietly(conn);
    conn = null;
    if (!importedTmp.exists) throw new BackupError('missing_db', '重加密产物未生成，中止替换');

    // 关库后清 WAL 残留 → 产物改名就位（overwrite 直换，消除"删旧未换新"的进程被杀窗口）
    await closeDb();
    removeWalSiblings();
    await importedTmp.move(appDbFile(), { overwrite: true });

    clearStoredRecords();
    let restored = 0;
    for (const rec of records) {
      try {
        await writeStoredRecordGz(rec.base, rec.gz);
        restored += 1;
      } catch (e) {
        console.warn(`records 恢复失败（详情页图表将无数据）: ${rec.base}:`, e);
      }
    }
    return { activities: await countActivities(), records: restored };
  } finally {
    await closeQuietly(conn);
    cleanup(staged);
    cleanup(importedTmp); // move 成功时该名字已不存在 → no-op；失败路径清理真临时文件
  }
}

/**
 * 按包密钥策略打开 staged 库并试读验证。SQLCipher 构建下开加密库必须先 PRAGMA key；
 * 明文库不能带 key（会被当错误密钥）。验证读 sqlite_master + activities 表在位——
 * 结构不符说明不是本应用的备份，按 bad_manifest 拒绝。
 */
async function openStagedVerified(
  staged: File,
  manifest: BackupManifest,
  passphrase: string | null,
): Promise<SQLite.SQLiteDatabase> {
  const key = passphrase ?? manifest.db_key; // null = 明文打开（口令加密包走 passphrase_required 提示）
  const conn = await SQLite.openDatabaseAsync(staged.name);
  const fail = (e: unknown): never => {
    const keyed = Boolean(key);
    throw new BackupError(keyed ? 'wrong_key' : 'passphrase_required', String(e));
  };
  try {
    if (key) await conn.execAsync(`PRAGMA key = ${sqlStr(key)};`);
    const table = await conn.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activities';",
    );
    if (!table) throw new BackupError('bad_manifest', '库内无 activities 表，不像本应用的备份');
    return conn;
  } catch (e) {
    if (e instanceof BackupError) {
      await closeQuietly(conn);
      throw e;
    }
    await closeQuietly(conn);
    return fail(e);
  }
}

/** 覆盖前自动安全备份：无口令（本机 key 随包）整包写 document/backups/，滚动保留 */
async function createPreImportBackup(): Promise<void> {
  const { bytes } = await buildBackup(null);
  const dir = new Directory(Paths.document, 'backups');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  new File(dir, `pre-import-${stamp}.fitbackup`).write(bytes);
  prunePreImportBackups(dir);
}

/** pre-import-*.fitbackup 按文件名时间戳倒序，超出保留份数删最旧 */
function prunePreImportBackups(dir: Directory): void {
  const olds = dir
    .list()
    .filter((e): e is File => e instanceof File)
    .map((f) => f.name)
    .filter((n) => /^pre-import-\d{14}\.fitbackup$/.test(n))
    .sort()
    .reverse()
    .slice(PRE_IMPORT_KEEP);
  for (const name of olds) {
    try {
      new File(dir, name).delete();
    } catch (e) {
      console.warn(`安全备份清理失败（忽略）: ${name}:`, e);
    }
  }
}

/** 删除主库的 WAL/SHM/ journal 残留（关库后本应消失，防御性清理） */
function removeWalSiblings(): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const f = new File(sqliteDir(), `${appDbFile().name}${suffix}`);
    if (f.exists) f.delete();
  }
}

async function closeQuietly(conn: SQLite.SQLiteDatabase | null): Promise<void> {
  if (!conn) return;
  try {
    await conn.closeAsync();
  } catch {
    // 验证失败路径的兜底关闭，无需处理
  }
}

function cleanup(file: File): void {
  try {
    if (file.exists) file.delete();
    // 临时库的 WAL/SHM 兄弟文件一并清（残留会永驻 SQLite 目录）
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const f = new File(sqliteDir(), `${file.name}${suffix}`);
      if (f.exists) f.delete();
    }
  } catch (e) {
    console.warn('备份导入临时文件清理失败（忽略）:', file.name, e);
  }
}

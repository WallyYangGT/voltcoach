/**
 * manifest.ts — .fitbackup 备份包清单定义与校验（格式规范见 docs/BACKUP_FORMAT.md）
 *
 * 纯函数层：不 import 任何 RN/Expo 模块，node:test 直接覆盖。
 * 备份包 = zip（STORE，payload 已是 gzip/sqlite 不再压缩），内容三部分：
 *   manifest.json                     清单（本文件类型）
 *   fitness.db                        SQLite 整库（SQLCipher 密文或明文）
 *   records/<base>.records.csv.gz     逐活动逐秒数据（<base> = 训练文件名去扩展名）
 *
 * db_key 语义（「SQLCipher 与备份的交互」实现期定稿）：
 *  - string：包内 fitness.db 是 SQLCipher 密文库，`PRAGMA key = '<db_key>'` 可打开。
 *    无口令导出时随包写入本机随机 key——防随手翻文件，不防拿到完整包的人（原口径）；
 *  - null：两种情形——包内是明文库（旧 repo `--export`、无 SQLCipher 的 iOS 导出），
 *    或包内用用户口令派生密钥加密（导入时需用户重输口令）。manifest 层不区分这两种，
 *    由导入流程实际开库判定。
 */

/** 备份包清单（写入 manifest.json / 解包后校验的统一形状） */
export interface BackupManifest {
  format: 'fitbackup';
  /** 建库 schema 版本（与本仓库 src/db SCHEMA_VERSION 同一口径），导入端驱动迁移链 */
  schema_version: number;
  /** 导出方 App 版本（旧 repo --export 填其 package.json version） */
  app_version: string;
  /** ISO 8601 导出时间 */
  exported_at: string;
  /** 导出设备描述，如 'android/Medium_Phone'、'docker-web' */
  device: string;
  /** 包内 db 的 SQLCipher key；null = 明文库或口令加密（导入时交互判定） */
  db_key: string | null;
  counts: {
    activities: number;
    records: number;
  };
}

/** 备份相关错误的稳定码（UI 侧映射 i18n 词条，错误文案不在本层拼装） */
export type BackupErrorCode =
  | 'invalid_zip'
  | 'missing_manifest'
  | 'bad_manifest'
  | 'unsupported_version'
  | 'missing_db'
  | 'wrong_key'
  | 'passphrase_required'
  | 'safety_backup_failed'
  | 'migration_failed'
  | 'no_sqlcipher';

/** 带 code 的备份错误：import/export 层抛出，UI 按 code 出双语提示 */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** manifest.json 必须是 fitbackup 格式——写在包里防止把任意 zip 当备份包导入 */
const FORMAT = 'fitbackup';

/**
 * 校验并规整未知来源的 manifest（解包后调用）。字段缺失/类型不对抛
 * BackupError('bad_manifest')；多余字段忽略（向前兼容：新版 App 导出的包
 * 带新字段时，旧 App 只要 schema_version 允许仍可导入）。
 */
export function validateBackupManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackupError('bad_manifest', 'manifest 不是对象');
  }
  const v = value as Record<string, unknown>;
  if (v.format !== FORMAT) throw new BackupError('bad_manifest', `format 不是 ${FORMAT}`);
  if (typeof v.schema_version !== 'number' || !Number.isInteger(v.schema_version) || v.schema_version < 1) {
    throw new BackupError('bad_manifest', 'schema_version 非法');
  }
  if (typeof v.app_version !== 'string') throw new BackupError('bad_manifest', 'app_version 缺失');
  if (typeof v.exported_at !== 'string' || Number.isNaN(new Date(v.exported_at).getTime())) {
    throw new BackupError('bad_manifest', 'exported_at 不是合法时间');
  }
  if (typeof v.device !== 'string') throw new BackupError('bad_manifest', 'device 缺失');
  if (v.db_key !== null && typeof v.db_key !== 'string') {
    throw new BackupError('bad_manifest', 'db_key 类型非法');
  }
  const counts = v.counts as Record<string, unknown> | undefined;
  if (
    !counts ||
    typeof counts !== 'object' ||
    typeof counts.activities !== 'number' ||
    !Number.isFinite(counts.activities) ||
    counts.activities < 0 ||
    typeof counts.records !== 'number' ||
    !Number.isFinite(counts.records) ||
    counts.records < 0
  ) {
    throw new BackupError('bad_manifest', 'counts 非法');
  }
  return {
    format: FORMAT,
    schema_version: v.schema_version,
    app_version: v.app_version,
    exported_at: v.exported_at,
    device: v.device,
    db_key: v.db_key,
    counts: { activities: counts.activities, records: counts.records },
  };
}

/**
 * schema 版本闸门（版本高于本机则提示升级 App）。包比本机新 → 拒绝导入；
 * 包比本机旧 → 允许，导入前在 staged 库上跑迁移链（v1/v2 → v3），失败按
 * migration_failed 中止且原库未动。
 */
export function checkSchemaVersion(manifest: BackupManifest, currentSchemaVersion: number): void {
  if (manifest.schema_version > currentSchemaVersion) {
    throw new BackupError(
      'unsupported_version',
      `备份 schema v${manifest.schema_version} 高于本机 v${currentSchemaVersion}`,
    );
  }
}

/**
 * staged 库的版本一致性（manifest 只是声明，真正的结构以库内 user_version 为准）：
 *  - 库版本高于本机 → unsupported_version（否则随后 migrationsFor 方向校验会炸，
 *    且库已被替换——v3 起这条必须在替换前拦住）；
 *  - 库版本高于 manifest 声明 → bad_manifest（清单与载荷不一致，拒绝不可信包）。
 * 库低于 manifest 允许（按库内版本走迁移链）。
 */
export function checkStagedDbVersion(
  manifestSchemaVersion: number,
  dbUserVersion: number,
  currentSchemaVersion: number,
): void {
  if (dbUserVersion > currentSchemaVersion) {
    throw new BackupError(
      'unsupported_version',
      `备份库 user_version v${dbUserVersion} 高于本机 v${currentSchemaVersion}`,
    );
  }
  if (dbUserVersion > manifestSchemaVersion) {
    throw new BackupError(
      'bad_manifest',
      `备份库 user_version v${dbUserVersion} 高于 manifest 声明的 v${manifestSchemaVersion}`,
    );
  }
}

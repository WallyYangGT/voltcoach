/**
 * identity.ts — 活动实体身份的形状校验（纯函数层，无平台依赖）
 *
 * v3（2026-10-19，decisions §34）：活动对外身份是 32 位小写 hex uuid
 * （SQLite 迁移用 lower(hex(randomblob(16))) 回填，新行用 expo-crypto randomUUID
 * 去连字符）。db 层、records 文件名、AI 工具入参与深链都共用本口径。
 */

/** 活动 uuid：32 位小写 hex（不带连字符） */
export const ACTIVITY_UUID_RE = /^[0-9a-f]{32}$/;

export function isActivityUuid(value: unknown): value is string {
  return typeof value === 'string' && ACTIVITY_UUID_RE.test(value);
}

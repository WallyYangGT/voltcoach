/**
 * athlete.ts — 骑手参数与骑手档案（settings 表 athlete / profile 行）
 *
 * 骑手参数：训练库 athlete 行覆盖出厂默认值，FTP 变更自动盖溯源戳（值未变不刷新），
 * AI 代改 FTP 的快照（ai_ftp_update 扩展字段）也存这里——快照不是骑手参数，
 * 不走 setAthlete 的校验与溯源戳。 athlete JSON 的扩展字段经 getEffectiveAthlete
 * 的 Object.assign 天然保活（不加列、不动 SCHEMA_VERSION）。
 * 骑手档案：身份/目标 + 教练模式与时间预算（业余教练模式，2026-10-17，decisions §30）。
 */

import { getDb } from './client';
import { invalidateDb } from './notify';
import { isFtpCalibratedFrom } from '@/core/ftp';
import { t, type Lang } from '@/core/i18n';
import {
  emptyProfile,
  isProfileEmpty,
  normalizeProfilePatch,
  parseStoredProfile,
  type RiderProfileData,
  type RiderProfilePatch,
} from '@/core/profile';
import { ATHLETE, FTP_ESTIMATION, type AthleteParams } from '@/core/settings';

/** 生效骑手参数：训练库 athlete 行覆盖出厂默认值（无行/行损坏回落默认） */
export async function getEffectiveAthlete(): Promise<AthleteParams> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  const merged: AthleteParams = { ...ATHLETE };
  if (row) {
    try {
      Object.assign(merged, JSON.parse(row.value));
    } catch {
      // 行内容损坏时忽略，保持默认值
    }
  }
  return merged;
}

/** 当前骑手参数状态：生效值 + 是否已在库中配置（首开引导用） */
export async function getAthleteState(): Promise<{ athlete: AthleteParams; configured: boolean }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  const athlete = await getEffectiveAthlete();
  return { athlete, configured: !!row };
}

// 骑手参数合法范围（FTP 上下限复用 FTP_ESTIMATION 的采纳写回口径，与旧版一致）
const ATHLETE_LIMITS = {
  ftp_watts: [FTP_ESTIMATION.apply_min_w, FTP_ESTIMATION.apply_max_w] as const,
  max_hr: [120, 230] as const,
  weight_kg: [30, 200] as const,
};

/** FTP 更新来源（溯源戳随 athlete JSON 落库；UI「我的」页手动保存为缺省 manual） */
export type FtpSource = 'manual' | 'estimate' | 'ai_coach';

/** FTP 溯源戳：最近一次 FTP 值实际变更的时间与来源（值未变不刷新时间戳） */
export interface FtpMeta {
  updated_at: string | null;
  source: FtpSource | null;
}

/** 读 FTP 溯源戳（athlete 行 JSON 的扩展字段；无行/损坏/旧数据返回全 null） */
export async function getFtpMeta(): Promise<FtpMeta> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  if (!row) return { updated_at: null, source: null };
  try {
    const p = JSON.parse(row.value);
    return {
      updated_at:
        typeof p.ftp_updated_at === 'string' && p.ftp_updated_at.length > 0
          ? p.ftp_updated_at
          : null,
      source: (p.ftp_source ?? null) as FtpSource | null,
    };
  } catch {
    return { updated_at: null, source: null };
  }
}

/**
 * FTP 是否已校准（2026-10-20 判据收紧，decisions §35）：健康瓦片 IF 采信与
 * AI 侧 athlete_configured 的统一口径（纯判据见 core/ftp.isFtpCalibratedFrom）。
 *
 * `getAthleteState().configured` 是「有 athlete 行」（用户可能只改过体重/最大心率，
 * FTP 仍是出厂默认 106W），不能作为「FTP 已校准」使用。单次读取 athlete 行
 * （含溯源戳与 AI 快照标记），读时归一化旧版撤销留下的 manual 假戳。
 */
export async function isFtpCalibrated(): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  let ftpWatts = ATHLETE.ftp_watts;
  let updatedAt: string | null = null;
  let source: FtpSource | null = null;
  let hasAiUpdate = false;
  if (row) {
    try {
      const p = JSON.parse(row.value);
      if (Number.isFinite(Number(p.ftp_watts))) ftpWatts = Number(p.ftp_watts);
      updatedAt = typeof p.ftp_updated_at === 'string' ? p.ftp_updated_at : null;
      source = (p.ftp_source ?? null) as FtpSource | null;
      hasAiUpdate = !!p.ai_ftp_update && typeof p.ai_ftp_update === 'object';
    } catch {
      // 行损坏：按出厂默认 + 无戳处理（保守判未校准）
    }
  }
  return isFtpCalibratedFrom(ftpWatts, updatedAt, ATHLETE.ftp_watts, {
    source,
    hasAiUpdate,
  });
}

/** AI 教练更新 FTP 的快照（athlete JSON 扩展字段 ai_ftp_update；首页披露条与撤销入口用，S3） */
export interface AiFtpUpdateSnapshot {
  old_ftp_w: number;
  new_ftp_w: number;
  updated_at: string;
  /** 模型自选的原值（2026-10-20 起；缺省=按估算均值更新，旧快照无此字段） */
  requested_w?: number;
  /** 自选所依据的估算区间（披露条展示「在区间内自选」） */
  range_low_w?: number;
  range_high_w?: number;
  /**
   * AI 更新前的溯源戳（撤销恢复用，2026-10-20 code-review P1）：撤销把 FTP 恢复成
   * 默认 106W 时，setAthlete 会因值变化重新盖戳 → 校准判据误判为已校准；撤销据此
   * 把溯源戳恢复到 AI 更新前的状态（旧快照无此字段按「无戳」处理，保守判未校准）。
   */
  old_ftp_updated_at?: string | null;
  old_ftp_source?: FtpSource | null;
}

/** 读 AI 更新快照（无行/损坏/字段不全返回 null） */
export async function getAiFtpUpdate(): Promise<AiFtpUpdateSnapshot | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  if (!row) return null;
  try {
    const s = JSON.parse(row.value)?.ai_ftp_update;
    if (
      s &&
      typeof s === 'object' &&
      typeof s.old_ftp_w === 'number' &&
      typeof s.new_ftp_w === 'number' &&
      typeof s.updated_at === 'string'
    )
      return s as AiFtpUpdateSnapshot;
    return null;
  } catch {
    return null;
  }
}

/**
 * 写/清 AI 更新快照（null 清除）。沿用 athlete 行整写先例：基于 getEffectiveAthlete
 * 的合并结果写回（Object.assign 天然保活 ftp_updated_at 等其它扩展字段，不加列、
 * 不动 SCHEMA_VERSION）。与 setAthlete 分开——快照不是骑手参数，不走其校验与溯源戳。
 */
export async function setAiFtpUpdate(snapshot: AiFtpUpdateSnapshot | null): Promise<void> {
  // getEffectiveAthlete 经 Object.assign 合并行 JSON，返回对象已含全部扩展字段，整写回即保活
  const merged = { ...(await getEffectiveAthlete()) } as Record<string, unknown>;
  if (snapshot) merged.ai_ftp_update = snapshot;
  else delete merged.ai_ftp_update;
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('athlete', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(merged),
  );
  invalidateDb('athlete'); // 首页 hero FTP 瓦片 / 健康瓦片 / 详情页功率口径都读 athlete
}

/**
 * 更新骑手参数（允许只给部分字段）：校验 → 合并当前值写库。
 * 非法值抛 Error（message 按 lang 双语，界面直接透传展示）。
 * opts.source：FTP 值实际变更时在 athlete JSON 上盖溯源戳（ftp_updated_at/ftp_source），
 * 供「AI 已代为更新」的追溯与后续展示； athlete JSON 的扩展字段经 getEffectiveAthlete
 * 的 Object.assign 天然保活（不加列、不动 SCHEMA_VERSION）。
 * opts.stamps：显式覆盖溯源戳（仅撤销路径用）——恢复撤销前的戳或清除（null），
 * 避免「撤销回默认值」被 setAthlete 的自动盖戳误判为已校准。
 */
export async function setAthlete(
  partial: Partial<AthleteParams>,
  lang: Lang = 'zh',
  opts?: {
    source?: FtpSource;
    stamps?: { updated_at: string | null; source: FtpSource | null };
  },
): Promise<AthleteParams> {
  const updates: Record<string, number> = {};
  for (const key of Object.keys(ATHLETE_LIMITS) as (keyof typeof ATHLETE_LIMITS)[]) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    const [lo, hi] = ATHLETE_LIMITS[key];
    if (!Number.isFinite(v) || v < lo || v > hi)
      throw new Error(t(lang, 'athlete.range', { key, lo, hi }));
    updates[key] = v;
  }
  if (!Object.keys(updates).length) throw new Error(t(lang, 'athlete.none'));
  const current = await getEffectiveAthlete();
  const merged: AthleteParams & { ftp_updated_at?: string; ftp_source?: FtpSource } = {
    ...current,
    ...updates,
  };
  if (opts?.stamps) {
    // 撤销路径：显式恢复（null = 清除该字段，回到「从未变更」状态）
    if (opts.stamps.updated_at) merged.ftp_updated_at = opts.stamps.updated_at;
    else delete merged.ftp_updated_at;
    if (opts.stamps.source) merged.ftp_source = opts.stamps.source;
    else delete merged.ftp_source;
  } else if (updates.ftp_watts != null && updates.ftp_watts !== current.ftp_watts) {
    merged.ftp_updated_at = new Date().toISOString();
    merged.ftp_source = opts?.source ?? 'manual';
  }
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('athlete', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(merged),
  );
  invalidateDb('athlete'); // FTP/体重/心率变更影响首页瓦片与后续分析口径
  return merged;
}

// ---------------- 用户背景与训练目标（存 settings 表 profile 行，「我的」设置页维护） ----------------

/**
 * 骑手档案：身份/目标 + 教练模式与时间预算（业余教练模式，2026-10-17，decisions §30）。
 * 所有字段存 settings 表 profile JSON 行——**不加列、不动 SCHEMA_VERSION**（沿
 * ai_ftp_update 快照先例；备份包随 settings 行整体迁移）。
 */
export interface RiderProfile extends RiderProfileData {
  /** 任一字段非空即视为已配置 */
  configured: boolean;
}

/** 当前骑手档案；未配置时各字段为空值（行内容损坏时按未配置返回） */
export async function getProfile(): Promise<RiderProfile> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'profile'`,
  );
  let data = emptyProfile();
  if (row) {
    try {
      data = parseStoredProfile(JSON.parse(row.value));
    } catch {
      // 行内容损坏时按未配置返回
    }
  }
  return { ...data, configured: !isProfileEmpty(data) };
}

/**
 * 更新骑手档案（允许只给部分字段）：校验 → 合并写库（校验/合并规则在 core/profile
 * 纯函数层，设置页与 AI 工具共用同一口径）。所有字段都为空时删除 profile 行。
 * 非法值抛 Error（message 按 lang 双语）。
 */
export async function setProfile(
  partial: RiderProfilePatch,
  lang: Lang = 'zh',
): Promise<RiderProfile> {
  const current = await getProfile();
  const merged = normalizeProfilePatch(current, partial, lang);
  const db = await getDb();
  if (isProfileEmpty(merged)) {
    await db.runAsync(`DELETE FROM settings WHERE key = 'profile'`);
  } else {
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES ('profile', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(merged),
    );
  }
  invalidateDb('profile'); // 首页「今日建议」/ 计划页头 / AI 场景装配都读档案
  return { ...merged, configured: !isProfileEmpty(merged) };
}

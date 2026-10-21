/**
 * aiconfig.ts — AI 服务配置（settings 表 ai 行 + SecureStore 存密钥，M3）
 *
 * api_key 不进训练库（旧版明文入库）：存 SecureStore（Android Keystore），
 * 默认不进系统备份；db 的 ai 行只保存其余配置字段。其余校验口径
 * （base_url 正则、temperature 0–2 等）与旧版逐字一致。
 */

import * as SecureStore from 'expo-secure-store';
import { getDb } from './client';
import { invalidateDb } from './notify';
import { t, type Lang } from '@/core/i18n';
import { AI_CONFIG, type AiConfig } from '@/core/settings';

// 供编排层/设置页引用的配置类型（db 层是 AiConfig 的存取入口，re-export 同源导出）
export type { AiConfig };

// AI 密钥不进训练库（旧版明文入库）：存 SecureStore（Android Keystore），
// 默认不进系统备份；db 的 ai 行只保存其余配置字段。
const AI_KEY_STORE = 'voltcoach.aikey';

/**
 * 当前 AI 配置：出厂默认 ← settings 表 ai 行覆盖 ← api_key 从 SecureStore 读出。
 * 库行内容损坏时忽略该行（按默认值），返回 configured = 是否已配置密钥。
 */
export async function getAiConfig(): Promise<{ config: AiConfig; configured: boolean }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'ai'`,
  );
  const config: AiConfig = { ...AI_CONFIG };
  if (row) {
    try {
      const saved = JSON.parse(row.value) as Partial<AiConfig>;
      // api_key 永远以 SecureStore 为准，忽略库行里的历史残留
      delete saved.api_key;
      Object.assign(config, saved);
    } catch {
      // 行内容损坏时按默认值返回
    }
  }
  const key = await SecureStore.getItemAsync(AI_KEY_STORE);
  config.api_key = key || null;
  return { config, configured: Boolean(config.api_key) };
}

/**
 * 更新 AI 服务配置（允许只给部分字段）：校验 → api_key 写 SecureStore、其余合并写库。
 * 校验口径与旧版 setAiConfig 逐字平移（非法值抛双语 Error，界面直接透传）；
 * api_key 传空字符串表示清除密钥（退化为复制提示词模式）。
 */
export async function setAiConfig(
  partial: Partial<Omit<AiConfig, 'api_key'>> & { api_key?: string | null },
  lang: Lang = 'zh',
): Promise<AiConfig> {
  const updates: Partial<AiConfig> = {};
  let keyUpdate: string | null | undefined; // undefined = 未涉及密钥
  if (partial?.api_key !== undefined && partial.api_key !== null) {
    if (typeof partial.api_key !== 'string') throw new Error(t(lang, 'ai.key_type'));
    keyUpdate = partial.api_key.trim() || null;
  }
  if (partial?.base_url != null) {
    const u = String(partial.base_url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(u)) throw new Error(t(lang, 'ai.base_url'));
    updates.base_url = u;
  }
  if (partial?.model != null) {
    const m = String(partial.model).trim();
    if (!m) throw new Error(t(lang, 'ai.model'));
    updates.model = m;
  }
  if (partial?.temperature !== undefined) {
    if (partial.temperature === null || (partial.temperature as unknown) === '') {
      updates.temperature = null; // 不传 temperature，用 API 默认
    } else {
      const v = Number(partial.temperature);
      if (!Number.isFinite(v) || v < 0 || v > 2)
        throw new Error(t(lang, 'ai.temperature'));
      updates.temperature = v;
    }
  }
  for (const key of ['timeout_ms', 'stall_ms'] as const) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    if (!Number.isFinite(v) || v < 1000)
      throw new Error(t(lang, 'ai.ms', { key }));
    updates[key] = Math.round(v);
  }
  if (partial?.stream != null) updates.stream = Boolean(partial.stream);
  if (partial?.agentic != null) updates.agentic = Boolean(partial.agentic);
  if (!Object.keys(updates).length && keyUpdate === undefined)
    throw new Error(t(lang, 'ai.none'));

  // 合并顺序：出厂默认 ← 库中现有值 ← 本次更新（与旧版 { ...AI_CONFIG, ...updates } 等价）
  const { config: current } = await getAiConfig();
  const merged: AiConfig = { ...current, ...updates };
  if (keyUpdate !== undefined) {
    if (keyUpdate) {
      await SecureStore.setItemAsync(AI_KEY_STORE, keyUpdate);
    } else {
      await SecureStore.deleteItemAsync(AI_KEY_STORE);
    }
  }
  merged.api_key = keyUpdate !== undefined ? keyUpdate : current.api_key;
  // db 行剔除 api_key（密钥只存 SecureStore）
  const { api_key: _omit, ...dbPart } = merged;
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('ai', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(dbPart),
  );
  invalidateDb('aiconfig');
  return merged;
}

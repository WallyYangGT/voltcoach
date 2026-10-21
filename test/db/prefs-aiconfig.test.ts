/// <reference types="node" />
/**
 * prefs-aiconfig.test.ts — 偏好域（语言/同步态/披露条锚）与 AI 配置域真 SQL 回归
 * （node:sqlite 假库，helpers/sqlite-port；SecureStore 用内存 Map mock）
 *
 * 钉 mock 测不到的 SQL 行为：settings 离散键行的 upsert/损坏回落、AI 配置的
 * 库行与 SecureStore 密钥分流（api_key 永远以 SecureStore 为准、库行剔除 api_key）。
 */
import { randomUUID as mockRandomUUID } from 'node:crypto';
import * as mockSqlite from '../helpers/sqlite-port';
import {
  getAdjustNoticeSeen,
  getLang,
  getSyncState,
  markAdjustNoticeSeen,
  setLang,
  setSyncState,
} from '@/db/prefs';
import { getAiConfig, setAiConfig } from '@/db/aiconfig';
import { getRawDb, resetTestDb } from '../helpers/sqlite-port';
import { AI_CONFIG } from '@/core/settings';

jest.mock('@/db/client', () => ({ getDb: () => mockSqlite.getTestDb() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
  getRandomBytes: (n: number) => new Uint8Array(n),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockSecure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    mockSecure.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    mockSecure.delete(k);
  },
}));

// SecureStore 内存替身（api_key 分流断言直接查这 Map）
const mockSecure = new Map<string, string>();
beforeEach(() => {
  resetTestDb();
  mockSecure.clear();
});
describe('语言', () => {
  test('默认 zh；setLang 往返；非法值抛错不落库', async () => {
    expect(await getLang()).toBe('zh');
    expect(await setLang('en')).toBe('en');
    expect(await getLang()).toBe('en');
    await expect(setLang('fr' as never)).rejects.toThrow('Unsupported lang');
  });
});
describe('同步状态', () => {
  test('默认值回落（多平台分槽形状）；整行覆盖写往返', async () => {
    const def = await getSyncState();
    expect(def.provider).toBeDefined();
    expect(def.auto).toBe(true);
    await setSyncState({ ...def, auto: false });
    expect((await getSyncState()).auto).toBe(false);
  });
  test('行损坏回落默认值', async () => {
    getRawDb().prepare(`INSERT INTO settings (key, value) VALUES ('sync', '{broken')`).run();
    const state = await getSyncState();
    expect(state.provider).toBeDefined(); // normalizeSyncState 归一化兜底
  });
});
describe('披露条已读锚', () => {
  test('标记/读取往返；空锚不写；损坏行按未读', async () => {
    expect(await getAdjustNoticeSeen('plan_adjust')).toBeNull();
    await markAdjustNoticeSeen('plan_adjust', '2026-10-21T00:00:00.000Z');
    expect(await getAdjustNoticeSeen('plan_adjust')).toBe('2026-10-21T00:00:00.000Z');
    expect(await getAdjustNoticeSeen('ftp_update')).toBeNull(); // 两类各一行互不影响
    await markAdjustNoticeSeen('ftp_update', ''); // 空身份不标记
    expect(await getAdjustNoticeSeen('ftp_update')).toBeNull();
    getRawDb()
      .prepare(`INSERT INTO settings (key, value) VALUES ('adjust_notice_seen:x', ?)`)
      .run(JSON.stringify({ nope: 1 }));
    expect(await getAdjustNoticeSeen('ftp_update' as never)).toBeNull();
  });
});
describe('AI 配置', () => {
  test('默认配置 configured=false（无密钥）；库行损坏按默认值', async () => {
    const { config, configured } = await getAiConfig();
    expect(config.api_key).toBeNull();
    expect(configured).toBe(false);
    getRawDb().prepare(`INSERT INTO settings (key, value) VALUES ('ai', '{broken')`).run();
    expect((await getAiConfig()).config.model).toBe(AI_CONFIG.model);
  });
  test('api_key 走 SecureStore、库行剔除 api_key；读取时合流', async () => {
    await setAiConfig({ api_key: 'sk-test', base_url: 'https://api.example.com/v1', model: 'kimi' });
    expect(mockSecure.get('voltcoach.aikey')).toBe('sk-test');
    const dbRow = JSON.parse(
      (getRawDb().prepare(`SELECT value FROM settings WHERE key = 'ai'`).get() as { value: string }).value,
    ) as Record<string, unknown>;
    expect(dbRow.api_key).toBeUndefined(); // 密钥不入库
    expect(dbRow.model).toBe('kimi');
    const { config, configured } = await getAiConfig();
    expect(config.api_key).toBe('sk-test');
    expect(config.base_url).toBe('https://api.example.com/v1');
    expect(configured).toBe(true);
  });
  test('api_key 空串清除密钥；其余字段部分更新合并', async () => {
    await setAiConfig({ api_key: 'sk-1', temperature: 0.7 });
    await setAiConfig({ temperature: 1.2 }); // 不带 key
    expect(mockSecure.get('voltcoach.aikey')).toBe('sk-1');
    expect((await getAiConfig()).config.temperature).toBe(1.2);
    await setAiConfig({ api_key: '' });
    expect(mockSecure.has('voltcoach.aikey')).toBe(false);
    expect((await getAiConfig()).configured).toBe(false);
  });
  test('校验口径：非法 base_url/temperature/超短超时/全空更新抛错', async () => {
    await expect(setAiConfig({ base_url: 'ftp://x' })).rejects.toThrow();
    await expect(setAiConfig({ temperature: 3 })).rejects.toThrow();
    await expect(setAiConfig({ timeout_ms: 100 })).rejects.toThrow();
    await expect(setAiConfig({})).rejects.toThrow();
    await expect(setAiConfig({ api_key: 123 as never })).rejects.toThrow();
  });
});
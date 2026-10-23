/**
 * sync-state.test.mjs — 云同步状态形状与兼容归一化测试（node:test）
 *
 * 关键断言是**旧行兼容**：多平台化（2026-10-16）之前，settings 的 'sync' 行是扁平的
 * （last_sync_at 在顶层），升级后必须归一化到 onelap 槽位——否则老用户升级后水位线
 * 归零、每次同步重拉 90 天（内容指纹虽兜住不重复入库，但白下载几十个 FIT）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SYNC_STATE,
  EMPTY_PROVIDER_STATE,
  normalizeSyncState,
  providerState,
  SYNC_PROVIDER_IDS,
  withProviderState,
} from '../src/sync/state.ts';

test('normalizeSyncState: 空值/非对象 → 出厂默认（默认平台顽鹿、自动同步开、无槽位）', () => {
  for (const raw of [null, undefined, 0, 'x', [], true]) {
    assert.deepEqual(normalizeSyncState(raw), DEFAULT_SYNC_STATE);
  }
  assert.equal(DEFAULT_SYNC_STATE.provider, 'onelap');
  assert.equal(DEFAULT_SYNC_STATE.auto, true);
  assert.deepEqual(DEFAULT_SYNC_STATE.providers, {});
});

test('normalizeSyncState: 旧扁平行 → 落成 onelap 槽位（水位线/计数不丢）', () => {
  const legacy = {
    auto: false,
    last_sync_at: '2026-10-12T08:30:00.000Z',
    last_result: 'ok',
    last_error: null,
    last_counts: { imported: 2, skipped: 1, failed: 0 },
  };
  assert.deepEqual(normalizeSyncState(legacy), {
    provider: 'onelap',
    auto: false,
    providers: {
      onelap: {
        last_sync_at: '2026-10-12T08:30:00.000Z',
        last_run_at: null, // 旧行没有该字段（2026-10-23 新增的展示字段），归一化为 null
        last_result: 'ok',
        last_error: null,
        last_counts: { imported: 2, skipped: 1, failed: 0 },
      },
    },
  });
});

test('normalizeSyncState: last_run_at（展示用「上次实际跑过」）随槽位读写；缺省为 null', () => {
  const out = normalizeSyncState({
    provider: 'onelap',
    providers: {
      onelap: {
        last_sync_at: '2026-10-16T02:00:00.000Z',
        last_run_at: '2026-10-23T09:30:00.000Z',
        last_result: 'ok',
        last_error: null,
        last_counts: { imported: 0, skipped: 3, failed: 0 },
      },
    },
  });
  assert.equal(out.providers.onelap.last_run_at, '2026-10-23T09:30:00.000Z');
  // 非字符串（脏数据）按缺省处理
  const dirty = normalizeSyncState({
    providers: { onelap: { last_run_at: 42, last_sync_at: null, last_result: null, last_error: null, last_counts: null } },
  });
  assert.equal(dirty.providers.onelap.last_run_at, null);
});

test('normalizeSyncState: 全新默认行（无同步痕迹）不落空槽位', () => {
  assert.deepEqual(normalizeSyncState({ auto: true }), DEFAULT_SYNC_STATE);
});

test('normalizeSyncState: 新版行 → 逐槽位读取；未知平台 id 丢弃；provider 非法值回落默认', () => {
  const out = normalizeSyncState({
    provider: 'wahoo',
    auto: false,
    providers: {
      wahoo: { last_sync_at: '2026-10-15T00:00:00.000Z', last_result: 'error', last_error: 'boom', last_counts: null },
      'igpsport-cn': { last_sync_at: null, last_result: null, last_error: null, last_counts: { imported: 5, skipped: 0, failed: 1, duplicates: 2 } },
      hacker: { last_sync_at: '2020-01-01T00:00:00.000Z' },
    },
  });
  assert.equal(out.provider, 'wahoo');
  assert.equal(out.auto, false);
  assert.deepEqual(Object.keys(out.providers).sort(), ['igpsport-cn', 'wahoo']);
  assert.equal(out.providers.wahoo.last_error, 'boom');
  assert.deepEqual(out.providers['igpsport-cn'].last_counts, { imported: 5, skipped: 0, failed: 1, duplicates: 2 });

  // provider 字段为未知值时回落默认平台（不把用户卡在无法识别的平台上）
  assert.equal(normalizeSyncState({ provider: 'strava', providers: {} }).provider, 'onelap');
  assert.equal(normalizeSyncState({ provider: 42, providers: {} }).provider, 'onelap');
});

test('normalizeSyncState: 脏数据容错（非法 result / 负数与 NaN 计数 / 类型错位）', () => {
  const out = normalizeSyncState({
    provider: 'igpsport-intl',
    auto: 'yes',
    providers: {
      'igpsport-intl': {
        last_sync_at: 12345,
        last_result: 'weird',
        last_error: 99,
        last_counts: { imported: -3, skipped: Number.NaN, failed: 'x', duplicates: 4.7 },
      },
    },
  });
  assert.equal(out.auto, true, 'auto 非布尔 → 回落默认开');
  assert.deepEqual(out.providers['igpsport-intl'], {
    last_sync_at: null,
    last_run_at: null,
    last_result: null,
    last_error: null,
    last_counts: { imported: 0, skipped: 0, failed: 0, duplicates: 4 },
  });
});

test('normalizeSyncState: 全平台 id 都在白名单内（下拉与槽位共用同一份清单）', () => {
  assert.deepEqual(SYNC_PROVIDER_IDS, ['onelap', 'igpsport-cn', 'igpsport-intl', 'wahoo']);
  const all = normalizeSyncState({
    provider: 'onelap',
    providers: Object.fromEntries(SYNC_PROVIDER_IDS.map((id) => [id, { last_sync_at: null, last_result: null, last_error: null, last_counts: null }])),
  });
  assert.deepEqual(Object.keys(all.providers).sort(), [...SYNC_PROVIDER_IDS].sort());
});

test('providerState / withProviderState: 缺槽位读空态；写入返回新对象不改原对象', () => {
  const base = normalizeSyncState(null);
  assert.deepEqual(providerState(base, 'wahoo'), EMPTY_PROVIDER_STATE);

  const next = withProviderState(base, 'wahoo', { last_sync_at: '2026-10-16T00:00:00.000Z', last_result: 'ok' });
  assert.deepEqual(base.providers, {}, '原状态不被就地修改');
  assert.deepEqual(providerState(next, 'wahoo'), {
    last_sync_at: '2026-10-16T00:00:00.000Z',
    last_run_at: null,
    last_result: 'ok',
    last_error: null,
    last_counts: null,
  });
  // 二次 patch 合并而非覆盖
  const merged = withProviderState(next, 'wahoo', { last_counts: { imported: 1, skipped: 0, failed: 0 } });
  assert.equal(merged.providers.wahoo.last_result, 'ok');
  assert.deepEqual(merged.providers.wahoo.last_counts, { imported: 1, skipped: 0, failed: 0 });
});

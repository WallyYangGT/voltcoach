/**
 * chart-viewport 纯函数单测——时序图缩放/拖动的视窗数学（roadmap「时序图双指缩放/拖动」销项）。
 * 口径：span ∈ [minWindowSpan, n-1]、越界回推、焦点保持、浮点中间态经 sliceRange 取整。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampViewport,
  fullViewport,
  isFullViewport,
  minWindowSpan,
  panViewport,
  sliceRange,
  zoomViewport,
} from '../src/core/chart-viewport.ts';

/** 误差断言（浮点连续手势中间态） */
function approx(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);
}

test('fullViewport / isFullViewport', () => {
  assert.deepEqual(fullViewport(1400), { i0: 0, i1: 1399 });
  assert.deepEqual(fullViewport(1), { i0: 0, i1: 0 });
  assert.deepEqual(fullViewport(0), { i0: 0, i1: 0 });
  assert.equal(isFullViewport(fullViewport(1400), 1400), true);
  assert.equal(isFullViewport({ i0: 5, i1: 100 }, 1400), false);
  // 单点序列恒为「未缩放」
  assert.equal(isFullViewport(fullViewport(1), 1), true);
});

test('minWindowSpan：max(30 点, 5%) 夹逼到 ≤ n-1', () => {
  assert.equal(minWindowSpan(1400), 70); // 5% = 70 > 30
  assert.equal(minWindowSpan(100), 30); // 5% = 5 < 30
  assert.equal(minWindowSpan(10), 9); // 点太少：全量即最小，不可缩
});

test('zoomViewport：放大焦点居中——span 减半、焦点索引不动', () => {
  const v = zoomViewport({ i0: 0, i1: 999 }, 0.5, 2, 1000);
  approx(v.i1 - v.i0, 499.5);
  // 焦点原在 499.5，新窗口中仍在同一相对位置
  const focalOld = 0 + 0.5 * 999;
  approx((focalOld - v.i0) / (v.i1 - v.i0), 0.5, 1e-6);
});

test('zoomViewport：焦点在左端——i0 贴 0；焦点在右端——i1 贴 n-1（越界回推）', () => {
  const left = zoomViewport({ i0: 0, i1: 999 }, 0, 2, 1000);
  approx(left.i0, 0);
  approx(left.i1, 499.5);

  const right = zoomViewport({ i0: 0, i1: 999 }, 1, 2, 1000);
  approx(right.i1, 999);
  approx(right.i0, 499.5);
});

test('zoomViewport：连续放大到最小窗口后不再变小', () => {
  let v = fullViewport(1400);
  for (let i = 0; i < 40; i++) v = zoomViewport(v, 0.3, 1.3, 1400);
  approx(v.i1 - v.i0, 70); // minWindowSpan(1400) = 70
});

test('zoomViewport：缩小到全量后停在全量（未缩放态）', () => {
  let v = zoomViewport({ i0: 0, i1: 999 }, 0.5, 2, 1000);
  v = zoomViewport(v, 0.5, 0.5, 1000);
  assert.equal(isFullViewport(v, 1000), true);
  // 已是全量再缩小仍全量
  v = zoomViewport(v, 0.5, 0.2, 1000);
  assert.equal(isFullViewport(v, 1000), true);
});

test('zoomViewport：scale ≤ 0 / NaN 防御', () => {
  const v = { i0: 10, i1: 110 };
  assert.deepEqual(zoomViewport(v, 0.5, 0, 1000), v);
  assert.deepEqual(zoomViewport(v, 0.5, NaN, 1000), v);
});

test('zoomViewport：缩小（scale<1）时窗口超出边界 → 整体回推到域内', () => {
  // 焦点偏左：新窗口左端越 0 → 贴 0
  const left = zoomViewport({ i0: 10, i1: 110 }, 0.5, 0.5, 1000);
  approx(left.i0, 0);
  approx(left.i1, 200);
  // 焦点偏右：新窗口右端越 n-1 → 贴 n-1
  const right = zoomViewport({ i0: 890, i1: 990 }, 0.5, 0.5, 1000);
  approx(right.i1, 999);
  approx(right.i0, 799);
});

test('panViewport：窗口整体平移且保持跨度，越界夹逼', () => {
  // 右移 10% 跨度
  const moved = panViewport({ i0: 100, i1: 300 }, 0.1, 1000);
  approx(moved.i0, 120);
  approx(moved.i1, 320);
  // 左移越界贴 0
  const leftClamped = panViewport({ i0: 5, i1: 205 }, -1, 1000);
  approx(leftClamped.i0, 0);
  approx(leftClamped.i1, 200);
  // 右移越界贴 n-1
  const rightClamped = panViewport({ i0: 850, i1: 1000 }, 1, 1000);
  approx(rightClamped.i1, 999);
  // 全量视窗无平移空间
  assert.deepEqual(panViewport(fullViewport(1000), 0.5, 1000), fullViewport(1000));
  // NaN 防御
  assert.deepEqual(panViewport({ i0: 10, i1: 110 }, NaN, 1000), { i0: 10, i1: 110 });
});

test('clampViewport：非法输入回合法域', () => {
  assert.deepEqual(clampViewport({ i0: -10, i1: 90 }, 1000), { i0: 0, i1: 100 });
  assert.deepEqual(clampViewport({ i0: 990, i1: 1200 }, 1000), { i0: 789, i1: 999 });
  assert.deepEqual(clampViewport({ i0: NaN, i1: NaN }, 1000), { i0: 0, i1: 0 });
});

test('sliceRange：floor/ceil 外扩覆盖端点，且夹在 [0, n-1]', () => {
  assert.deepEqual(sliceRange(fullViewport(1400), 1400), { start: 0, end: 1399 });
  assert.deepEqual(sliceRange({ i0: 10.4, i1: 20.6 }, 1400), { start: 10, end: 21 });
  assert.deepEqual(sliceRange({ i0: -5, i1: 1500 }, 1400), { start: 0, end: 1399 });
  // 起点不越过终点（退化视窗）
  assert.deepEqual(sliceRange({ i0: 50, i1: 50 }, 1400), { start: 50, end: 50 });
});

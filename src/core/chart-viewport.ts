/**
 * chart-viewport.ts — 时序图缩放/拖动的视窗纯函数（roadmap「时序图双指缩放/拖动」销项）
 *
 * 口径：计算层不变、重新映射视窗（migration-plan.archive.md 既定方向）——视窗是
 * 点索引域上的浮点区间 {i0, i1}（浮点是缩放/拖动的连续中间态，绘制时经 sliceRange
 * 取整切片）。缩放以焦点比例为中心保持不动，span 夹逼在 [minWindowSpan, n-1]，
 * 平移/缩放越界整体回推，全量视窗即未缩放（图表行为与无手势时完全一致）。
 *
 * 本文件不 import 任何 RN/Expo 模块，供 node:test 直测；手势接线在
 * src/charts/useChartViewport.ts（React hook，L4 测试）。
 */

/** 可视窗口：点索引域上的闭区间（浮点端点） */
export interface ChartViewport {
  i0: number;
  i1: number;
}

/** 缩放下限：窗口最小跨度 = max(30 点, 总点数的 5%)，再夹逼到 ≤ n-1（点太少不缩） */
export const VIEWPORT_MIN_POINTS = 30;
export const VIEWPORT_MIN_FRAC = 0.05;

/** 全量视窗（未缩放态） */
export function fullViewport(n: number): ChartViewport {
  return { i0: 0, i1: Math.max(0, n - 1) };
}

/** 窗口最小跨度（i1-i0 的下限） */
export function minWindowSpan(n: number): number {
  const full = Math.max(0, n - 1);
  return Math.min(full, Math.max(VIEWPORT_MIN_POINTS, Math.round(n * VIEWPORT_MIN_FRAC)));
}

/** 是否未缩放（span 容差判断——浮点连续手势的中间态留 1e-9） */
export function isFullViewport(v: ChartViewport, n: number): boolean {
  return n <= 1 || (v.i0 <= 1e-9 && v.i1 >= n - 1 - 1e-9);
}

/**
 * 以焦点为中心缩放：scale > 1 放大（窗口变小）、< 1 缩小；focalFrac 是焦点在
 * 绘图区宽上的 0..1 比例（手势触点 x 换算），缩放前后焦点对应的索引不动。
 * scale ≤ 0 / NaN 视为无效操作原样返回（手势首帧可能给 0）。
 */
export function zoomViewport(
  v: ChartViewport,
  focalFrac: number,
  scale: number,
  n: number,
): ChartViewport {
  const base = clampViewport(v, n);
  if (!Number.isFinite(scale) || scale <= 0 || n <= 1) return base;
  const full = n - 1;
  const minSpan = minWindowSpan(n);
  let span = (base.i1 - base.i0) / scale;
  if (span < minSpan) span = minSpan;
  if (span > full) span = full;
  // 焦点保持：焦点在窗口中的相对位置 = 夹逼后的 focalFrac，缩放前后不动
  const frac = clamp01(focalFrac);
  const focal = base.i0 + frac * (base.i1 - base.i0);
  let i0 = focal - frac * span;
  let i1 = i0 + span;
  if (i0 < 0) {
    i0 = 0;
    i1 = span;
  }
  if (i1 > full) {
    i1 = full;
    i0 = full - span;
  }
  return { i0, i1 };
}

/**
 * 拖动平移：deltaFrac = 手指位移 / 绘图区宽，方向取「内容跟随手指」——
 * 手指右滑看更早数据 = 窗口左移，调用方传负值。越界夹逼在 [0, n-1]。
 */
export function panViewport(v: ChartViewport, deltaFrac: number, n: number): ChartViewport {
  const base = clampViewport(v, n);
  const span = base.i1 - base.i0;
  const i0 = base.i0 + (Number.isFinite(deltaFrac) ? deltaFrac : 0) * span;
  return clampViewport({ i0, i1: i0 + span }, n);
}

/** 视窗夹逼到合法域（span ≤ n-1 且落在 [0, n-1] 内） */
export function clampViewport(v: ChartViewport, n: number): ChartViewport {
  const full = n - 1;
  let span = v.i1 - v.i0;
  if (!Number.isFinite(span) || span < 0) span = 0;
  if (span > full) span = full;
  const i0Raw = Number.isFinite(v.i0) ? v.i0 : 0;
  const i0 = Math.min(Math.max(i0Raw, 0), full - span);
  return { i0, i1: i0 + span };
}

/** 浮点视窗 → 整数切片范围（供 Array.slice，覆盖端点：floor/ceil 外扩半点） */
export function sliceRange(v: ChartViewport, n: number): { start: number; end: number } {
  const start = Math.max(0, Math.floor(v.i0));
  const end = Math.min(Math.max(0, n - 1), Math.ceil(v.i1));
  return { start, end: Math.max(start, end) };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
}

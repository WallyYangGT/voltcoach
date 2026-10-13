/**
 * useChartViewport.ts — 时序图缩放/拖动的视窗状态 hook（纯函数在 src/core/chart-viewport.ts）
 *
 * 手势接线约定（TimeSeriesChart 调用）：
 * - Pinch.onChange 给 changeScale（相对上帧的缩放因子）与 focalX——调用方换算成
 *   焦点在绘图区宽上的 0..1 比例后调 pinch(focalFrac, scale)；
 * - Pan.onUpdate 逐帧给位移差——换算成 -dx / 绘图区宽（内容跟随手指，窗口反向移）
 *   后调 panBy(deltaFrac)；
 * - 双击复位调 reset()。
 *
 * n（总点数）变化（切系列/换活动）时自动复位全量视窗。zoomed 标志供外层禁用
 * ChartScroller 横滚——缩放态下横滚与图表拖动是同一根手指，必须二选一。
 */
import { useCallback, useState } from 'react';

import {
  fullViewport,
  isFullViewport,
  panViewport,
  zoomViewport,
} from '@/core/chart-viewport';

export function useChartViewport(n: number) {
  // n 随视窗一起入 state：点数变化（系列增减/换数据）时在渲染期检测并复位全量——
  // React 认可的「依据 prop 调整 state」惯用法，避免 effect 里 setState 的级联渲染
  const [state, setState] = useState(() => ({ n, view: fullViewport(n) }));
  if (state.n !== n) {
    setState({ n, view: fullViewport(n) });
  }
  const { view } = state;

  const pinch = useCallback(
    (focalFrac: number, scale: number) =>
      setState((s) => (s.n === n ? { ...s, view: zoomViewport(s.view, focalFrac, scale, n) } : s)),
    [n],
  );
  const panBy = useCallback(
    (deltaFrac: number) =>
      setState((s) => (s.n === n ? { ...s, view: panViewport(s.view, deltaFrac, n) } : s)),
    [n],
  );
  const reset = useCallback(
    () => setState((s) => ({ ...s, view: fullViewport(s.n) })),
    [],
  );

  return { view, zoomed: !isFullViewport(view, n), pinch, panBy, reset };
}

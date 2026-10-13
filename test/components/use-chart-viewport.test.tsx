/**
 * use-chart-viewport.test.tsx — L4 Hook 测试：时序图缩放/拖动视窗状态机（useChartViewport）。
 *
 * RNGH 手势无法在 jest 里模拟，这里绕开渲染层直调 hook 暴露的动作函数
 * （pinch/panBy/reset 与手势回调一一对应），钉住状态机：
 * 1. 初始全量视窗（未缩放），pinch 焦点缩放后 zoomed 翻真；
 * 2. 连续放大夹逼在最小窗口；缩小回全量后 zoomed 翻回 false；
 * 3. panBy 越界夹逼、全量视窗无平移空间；
 * 4. n（点数）变化自动复位（切系列/换活动不残留旧视窗）。
 * 纯数学断言在 test/chart-viewport.test.mjs（node:test），这里验 Hook 接线。
 * RNTL v14：renderHook 为 async；状态更新统一 await act(async () => …) 包裹
 * （decisions §18：同步 act 在本仓环境会报 overlapping act）。
 */
import { act, renderHook } from '@testing-library/react-native';
import { useChartViewport } from '@/charts/useChartViewport';

describe('useChartViewport', () => {
  it('初始全量视窗（未缩放）', async () => {
    const { result } = await renderHook(() => useChartViewport(1400));
    expect(result.current.view).toEqual({ i0: 0, i1: 1399 });
    expect(result.current.zoomed).toBe(false);
  });

  it('pinch 焦点缩放：span 减半、zoomed 翻真', async () => {
    const { result } = await renderHook(() => useChartViewport(1000));
    await act(async () => {
      result.current.pinch(0.5, 2);
    });
    expect(result.current.view.i1 - result.current.view.i0).toBeCloseTo(499.5, 6);
    expect(result.current.zoomed).toBe(true);
  });

  it('连续放大夹逼在最小窗口（max(30, 5%)）', async () => {
    const { result } = await renderHook(() => useChartViewport(1400));
    await act(async () => {
      for (let i = 0; i < 40; i++) result.current.pinch(0.3, 1.3);
    });
    expect(result.current.view.i1 - result.current.view.i0).toBeCloseTo(70, 6);
  });

  it('缩小回全量后 zoomed 翻回 false', async () => {
    const { result } = await renderHook(() => useChartViewport(1000));
    await act(async () => {
      result.current.pinch(0.5, 2);
    });
    await act(async () => {
      result.current.pinch(0.5, 0.5);
    });
    expect(result.current.zoomed).toBe(false);
  });

  it('panBy 平移且越界夹逼；全量视窗无平移空间', async () => {
    const { result } = await renderHook(() => useChartViewport(1000));
    await act(async () => {
      result.current.pinch(0.5, 2); // [249.75, 749.25]
    });
    await act(async () => {
      result.current.panBy(0.1); // 右移 10% 跨度（49.95）
    });
    expect(result.current.view.i0).toBeCloseTo(299.7, 6);
    await act(async () => {
      result.current.panBy(-10); // 远超左边界 → 贴 0
    });
    expect(result.current.view.i0).toBe(0);
    await act(async () => {
      result.current.reset();
      result.current.panBy(0.5); // 全量无平移空间
    });
    expect(result.current.view).toEqual({ i0: 0, i1: 999 });
  });

  it('reset 复位全量视窗', async () => {
    const { result } = await renderHook(() => useChartViewport(1000));
    await act(async () => {
      result.current.pinch(0.2, 3);
    });
    expect(result.current.zoomed).toBe(true);
    await act(async () => {
      result.current.reset();
    });
    expect(result.current.view).toEqual({ i0: 0, i1: 999 });
    expect(result.current.zoomed).toBe(false);
  });

  it('n（点数）变化自动复位（切系列/换活动不残留旧视窗）', async () => {
    const { result, rerender } = await renderHook((props: { n: number }) => useChartViewport(props.n), {
      initialProps: { n: 1000 },
    });
    await act(async () => {
      result.current.pinch(0.5, 2);
      result.current.pinch(0.5, 2);
    });
    expect(result.current.zoomed).toBe(true);
    await act(async () => {
      rerender({ n: 600 });
    });
    expect(result.current.view).toEqual({ i0: 0, i1: 599 });
    expect(result.current.zoomed).toBe(false);
  });
});

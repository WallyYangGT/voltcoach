/**
 * TimeSeriesChart.tsx — 通用多系列时序图（react-native-svg 直译）
 *
 * 计算层直译自 Web 版 charts.js 的 drawLineChart：各系列独立纵轴缩放、
 * ≤180s 短缺口线性插值桥接（码表自动暂停产生的停顿不断线，仅显示层不改数据）、
 * 中心移动平均平滑（半径随数据长度自适应）、null 断段。渲染点数由上游
 * thinRecords ≤1400 抽稀口径保证。
 *
 * 与 Web 版差异：viewBox 用实际组件宽高（等比渲染，文字不变形——Web 版的
 * preserveAspectRatio=none 拉伸方案在移动端窄屏上会让刻度文字严重变形）。
 * 渲染宽由外部（ChartScroller，900px 内容宽口径）传入，本组件不自取屏宽。
 *
 * 缩放/拖动（计算层不变、重新映射视窗）：双指捏合以焦点为中心缩放、单指拖动
 * 平移、双击复位；视窗数学在 src/core/chart-viewport.ts（L1），状态机在
 * useChartViewport（L4）。缩放态下各系列 y 轴按可视窗重算 min/max（看细节），
 * X 刻度标注窗口的实际时间偏移；onViewportChange 供外层禁用 ChartScroller
 * 横滚——未缩放时横向滑归 ScrollView 粗导航（拖动手势不启用、不抢手势），
 * 缩放后同一根手指归图表拖动。
 */

import React, { useEffect, useMemo, useRef } from 'react';
import {
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Stop,
  Svg,
  Text,
} from 'react-native-svg';import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { palette } from '@/theme';
import { sliceRange } from '@/core/chart-viewport';
import { useChartViewport } from '@/charts/useChartViewport';

export interface SeriesSpec {
  /** 系列标识（渐变 id 用，仅字母数字） */
  key: string;
  /** y 值序列（已抽稀；null 表示缺口） */
  points: (number | null)[];
  /** 秒/点（抽稀步长，桥接阈值按它换算） */
  step: number;
  color: string;
  /** 是否画渐变面积（功率系列用；仅无断段时绘制，口径同 Web 版） */
  area?: boolean;
}

/** X 轴刻度：1h30m → "1h30"、45m → "45m"（直译 web/js/common.js fmtXAxis） */
export function fmtXAxis(sec: number): string {
  const h = Math.floor(sec / 3600),
    m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`;
}

// 短缺口桥接上限（秒）：超过的长时间停顿（休息/吃饭）仍断开（口径同 Web 版）
const BRIDGE_GAP_SEC = 180;

/** ≤BRIDGE_GAP_SEC 的连续 null 段按左右邻居线性插值（仅显示层，返回新数组） */
export function bridgeGaps(pts: (number | null)[], step: number): (number | null)[] {
  const maxRun = Math.max(1, Math.round(BRIDGE_GAP_SEC / step));
  const out = pts.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i] != null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] == null) j++;
    const prev = i > 0 ? out[i - 1] : null;
    const next = j < out.length ? out[j] : null;
    if (prev != null && next != null && j - i <= maxRun) {
      for (let k = i; k < j; k++)
        out[k] = prev! + ((next - prev!) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  return out;
}

/** 中心移动平均平滑：窗口半径随数据长度自适应，null 保留（不跨缺口填补） */
export function smoothSeries(pts: (number | null)[], n: number): (number | null)[] {
  const radius = Math.max(1, Math.round(n / 400));
  return pts.map((_, i) => {
    let sum = 0,
      count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      if (pts[j] != null) {
        sum += pts[j]!;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  });
}

// 绘图区内边距（口径同 Web 版 drawLineChart）
const PL = 8,
  PR = 8,
  PT = 10,
  PB = 22;

interface Props {
  series: SeriesSpec[];
  height?: number;
  /** 渲染宽（px）——由 ChartScroller 给出（容器宽 vs 900px 内容宽取大） */
  width: number;
  /** 缩放态回调：外层据此禁用 ChartScroller 横滚（缩放态下拖动与横滚是同一根手指） */
  onViewportChange?: (zoomed: boolean) => void;
}

export function TimeSeriesChart({ series, height = 220, width: W, onViewportChange }: Props) {
  // 视窗索引域 = 各系列公共长度（同一条时间轴），缩放/拖动只动视窗不动数据
  const n = series.reduce((m, s) => Math.max(m, s.points.length), 0);
  const iw = W - PL - PR; // 绘图区像素宽（手势位移/焦点换算用）
  const { view, zoomed, pinch, panBy, reset } = useChartViewport(n);
  const lastX = useRef(0); // 拖动手势上一帧触点 x（ref 而非闭包变量：回调跨帧存活）
  const lastScale = useRef(1); // 捏合手势上一帧累计 scale（RNGH 只给累计值，增量自己算）

  useEffect(() => {
    onViewportChange?.(zoomed);
  }, [zoomed, onViewportChange]);

  const built = useMemo(() => {
    const H = height;
    const ih = H - PT - PB;
    const visible = series.filter((s) => s.points.some((v) => v != null));
    if (!visible.length || n === 0) return null;
    const step = visible[0].step ?? 1;
    const { start, end } = sliceRange(view, n);
    const win = end - start + 1;
    const x = (i: number) => PL + (win === 1 ? iw / 2 : (i / (win - 1)) * iw);

    const paths = visible.map((s) => {
      const pts = smoothSeries(bridgeGaps(s.points.slice(start, end + 1), step), win);
      const vals = pts.filter((v): v is number => v != null);
      if (!vals.length) return null;
      let min = Math.min(...vals),
        max = Math.max(...vals);
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
      const y = (v: number) => PT + ((max - v) / (max - min)) * ih;
      // null 断段
      let d = '',
        pen = false;
      pts.forEach((v, i) => {
        if (v == null) {
          pen = false;
          return;
        }
        d += (pen ? 'L' : 'M') + `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      const gid = `g${s.key.replace(/\W/g, '')}`;
      const areaPath =
        s.area && !pts.some((v) => v == null)
          ? `${d}L${x(win - 1).toFixed(1)},${PT + ih}L${x(0).toFixed(1)},${PT + ih}Z`
          : null;
      return { spec: s, d, areaPath, gid };
    });
    const drawn = paths.filter((p): p is NonNullable<typeof p> => p != null);
    if (!drawn.length) return null;

    // 网格线 + X 轴刻度（0..6 七档，口径同 Web 版；缩放后标注窗口的实际时间偏移）
    const gridYs = Array.from({ length: 5 }, (_, g) => PT + (g / 4) * ih);
    const totalSec = win * step;
    const startSec = start * step;
    const ticks = Array.from({ length: 7 }, (_, t) => {
      const sec = (t / 6) * totalSec;
      return { x: x((sec / totalSec) * (win - 1)), label: fmtXAxis(startSec + sec) };
    });
    return { paths: drawn, gridYs, ticks, H };
  }, [series, height, view, n, iw]);

  const gesture = useMemo(() => {
    // 回调全是 JS 侧 setState 分发（视窗 state），必须跑 JS 线程：显式 runOnJS(true)——
    // reanimated 4 + worklets 环境下 RNGH 会把未标注回调当 worklet 在 UI Runtime
    // 执行，setState 被当 Remote Function 同步调用直接红屏（冒烟实证）。
    // refs 只在手势事件回调里读写（touch 事件流，渲染期永不触发）；
    // react-hooks/refs 不识别 RNGH 的 .onBegin/.onUpdate 是事件注册，定向豁免
    const panG = Gesture.Pan()
      .runOnJS(true)
      // 未缩放时不启用拖动：横向滑让给 ChartScroller 做粗导航，不抢手势
      .enabled(zoomed)
      // eslint-disable-next-line react-hooks/refs
      .onBegin((e) => {
        lastX.current = e.absoluteX;
      })
      // eslint-disable-next-line react-hooks/refs
      .onUpdate((e) => {
        // 内容跟随手指：手指右移看更早数据 = 窗口左移
        panBy(-(e.absoluteX - lastX.current) / iw);
        lastX.current = e.absoluteX;
      });
    const pinchG = Gesture.Pinch()
      .runOnJS(true)
      // eslint-disable-next-line react-hooks/refs
      .onBegin(() => {
        lastScale.current = 1; // 每段捏合手势从 1 重新累计
      })
      // eslint-disable-next-line react-hooks/refs
      .onUpdate((e) => {
        pinch((e.focalX - PL) / iw, e.scale / lastScale.current);
        lastScale.current = e.scale;
      });
    const doubleTapG = Gesture.Tap()
      .numberOfTaps(2)
      .runOnJS(true)
      .onEnd((_e, success) => {
        if (success) reset();
      });
    return Gesture.Simultaneous(panG, pinchG, doubleTapG);
  }, [panBy, pinch, reset, iw, zoomed, lastX, lastScale]);

  if (!built) return null;
  const { paths, gridYs, ticks, H } = built;

  return (
    <GestureDetector gesture={gesture}>
      <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <Defs>
          {paths.map(({ spec, gid }) => (
            <LinearGradient key={gid} id={gid} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={spec.color} stopOpacity={0.25} />
              <Stop offset="1" stopColor={spec.color} stopOpacity={0} />
            </LinearGradient>
          ))}
        </Defs>
        {gridYs.map((y, i) => (
          <Line
            key={i}
            x1={0}
            y1={y}
            x2={W}
            y2={y}
            stroke={palette.line}
            strokeWidth={1}
          />
        ))}
        {paths.map(({ spec, d, areaPath, gid }) => (
          <G key={spec.key}>
            {areaPath && <Path d={areaPath} fill={`url(#${gid})`} />}
            <Path
              d={d}
              fill="none"
              stroke={spec.color}
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </G>
        ))}
        {ticks.map((t, i) => (
          <Text
            key={i}
            x={t.x}
            y={H - 6}
            textAnchor="middle"
            fontSize={10}
            fill={palette.muted}
          >
            {t.label}
          </Text>
        ))}
      </Svg>
    </GestureDetector>
  );
}

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
 */

import React, { useMemo } from 'react';
import { Defs, G, Line, LinearGradient, Path, Stop, Svg, Text } from 'react-native-svg';
import { palette } from '@/theme';

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

interface Props {
  series: SeriesSpec[];
  height?: number;
  /** 渲染宽（px）——由 ChartScroller 给出（容器宽 vs 900px 内容宽取大） */
  width: number;
}

export function TimeSeriesChart({ series, height = 220, width: W }: Props) {
  const built = useMemo(() => {
    const H = height,
      PL = 8,
      PR = 8,
      PT = 10,
      PB = 22;
    const iw = W - PL - PR,
      ih = H - PT - PB;
    const visible = series.filter((s) => s.points.some((v) => v != null));
    if (!visible.length) return null;
    const n = Math.max(...visible.map((s) => s.points.length));
    const step = visible[0].step ?? 1;
    const x = (i: number) => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

    const paths = visible.map((s) => {
      const pts = smoothSeries(bridgeGaps(s.points, step), n);
      const vals = pts.filter((v): v is number => v != null);
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
          ? `${d}L${x(n - 1).toFixed(1)},${PT + ih}L${x(0).toFixed(1)},${PT + ih}Z`
          : null;
      return { spec: s, d, areaPath, gid };
    });

    // 网格线 + X 轴刻度（0..6 七档，口径同 Web 版）
    const gridYs = Array.from({ length: 5 }, (_, g) => PT + (g / 4) * ih);
    const totalSec = n * step;
    const ticks = Array.from({ length: 7 }, (_, t) => {
      const sec = (t / 6) * totalSec;
      return { x: x((sec / totalSec) * (n - 1)), label: fmtXAxis(sec) };
    });
    return { paths, gridYs, ticks, H, PL, PR: W - PR, PB };
  }, [series, W, height]);

  if (!built) return null;
  const { paths, gridYs, ticks, H } = built;

  return (
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
  );
}

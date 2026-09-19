/**
 * TrendChart.tsx — CTL/ATL/TSB 逐日趋势图（react-native-svg 直译）
 *
 * 直译自 reference/web/js/charts.js 的 drawTrendChart：共享纵轴（form 值域）
 * + TSS 背景柱 + 零轴线 + 月份刻度。M2 首页仪表盘消费（数据源 recentFormDaily
 * 口径，M2 接入训练库查询），M1 一并直译完成四类图表的搬运。
 */

import React, { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { Line, Path, Rect, Svg, Text } from 'react-native-svg';
import { palette } from '@/theme';

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}

interface Props {
  daily: TrendPoint[];
  height?: number;
  width?: number;
}

export function TrendChart({ daily, height = 260, width }: Props) {
  const { width: screenW } = useWindowDimensions();
  const W = width ?? screenW;

  const built = useMemo(() => {
    if (!daily?.length) return null;
    const H = height,
      PL = 34,
      PR = 34,
      PT = 12,
      PB = 22;
    const iw = W - PL - PR,
      ih = H - PT - PB;
    const maxForm = Math.max(...daily.map((d) => Math.max(d.ctl, d.atl)), 10);
    const minForm = Math.min(...daily.map((d) => Math.min(d.tsb, 0)));
    const maxTss = Math.max(...daily.map((d) => d.tss), 1);
    const n = daily.length;
    const x = (i: number) => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const yF = (v: number) => PT + ((maxForm - v) / (maxForm - minForm)) * ih;
    const yT = (v: number) => PT + ih - (v / maxTss) * ih;

    // 网格 + Y 轴标签（form 值域 5 档）
    const grid = Array.from({ length: 5 }, (_, g) => ({
      y: PT + (g / 4) * ih,
      label: Math.round(maxForm - (g / 4) * (maxForm - minForm)),
    }));
    // TSS 背景柱
    const bw = Math.max(1.5, (iw / n) * 0.6);
    const bars = daily
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.tss > 0)
      .map(({ d, i }) => ({
        x: x(i) - bw / 2,
        y: yT(d.tss),
        w: bw,
        h: PT + ih - yT(d.tss),
      }));
    // 月份刻度（每月首日一档）
    const ticks: { x: number; label: string }[] = [];
    let lastM = '';
    for (let i = 0; i < n; i++) {
      const m = daily[i].date.slice(0, 7);
      if (m !== lastM) {
        lastM = m;
        ticks.push({ x: x(i), label: m });
      }
    }
    const line = (key: 'ctl' | 'atl' | 'tsb') =>
      daily
        .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yF(p[key]).toFixed(1)}`)
        .join('');
    const zeroY = minForm < 0 ? yF(0) : null;

    return { H, PL, PR: W - PR, grid, bars, ticks, zeroY, paths: [
      { d: line('ctl'), color: palette.blue },
      { d: line('atl'), color: palette.red },
      { d: line('tsb'), color: palette.green },
    ] };
  }, [daily, W, height]);

  if (!built) return null;
  const { H, PL, grid, bars, ticks, zeroY, paths } = built;

  return (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {grid.map((g, i) => (
        <React.Fragment key={i}>
          <Line x1={PL} y1={g.y} x2={W - 34} y2={g.y} stroke={palette.line} strokeWidth={1} />
          <Text x={PL - 5} y={g.y + 3} textAnchor="end" fontSize={10} fill={palette.muted}>
            {g.label}
          </Text>
        </React.Fragment>
      ))}
      {zeroY != null && (
        <Line x1={PL} y1={zeroY} x2={W - 34} y2={zeroY} stroke={palette.faint} strokeWidth={1} strokeDasharray="4" />
      )}
      {bars.map((b, i) => (
        <Rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(141,154,168,0.25)" />
      ))}
      {ticks.map((t, i) => (
        <Text key={i} x={t.x} y={H - 6} textAnchor="middle" fontSize={10} fill={palette.muted}>
          {t.label}
        </Text>
      ))}
      {paths.map((p, i) => (
        <Path
          key={i}
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

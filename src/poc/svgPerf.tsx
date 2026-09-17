/**
 * PoC 2 — react-native-svg 渲染 3 系列 × 1400 点折线（对齐现有 /api/records 抽稀口径）。
 *
 * runSvgPerfPoc()：纯计算侧计时（合成数据 + 坐标映射 + points 字符串拼接），
 * 结果驱动卡片下方渲染 <SvgPerfChart/>（含「换一组数据」按钮触发整图重渲染）。
 * JS 侧耗时只是粗测；帧率结论以真机/模拟器 Perf Monitor 目测 + 截图为准。
 * 图表计算层（坐标映射/points 拼接）即未来移植 web/js/charts.js 的同型逻辑。
 */
import React, { useMemo, useState } from 'react';
import { Button, View, useWindowDimensions } from 'react-native';
import Svg, { Line, Polyline, Text as SvgText } from 'react-native-svg';
import { palette } from '@/theme';
import type { PocResult } from './types';

const POINTS = 1400;
const SERIES = [
  { key: 'power', color: palette.volt, min: 0, max: 450, label: 'W' },
  { key: 'hr', color: palette.red, min: 90, max: 190, label: 'bpm' },
  { key: 'speed', color: palette.cyan, min: 0, max: 55, label: 'km/h' },
] as const;

/** 合成数据：随机游走，功率带 0 值滑行段与缺口（贴近真实骑行形态） */
function genSeries(seed: number): Record<string, (number | null)[]> {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: Record<string, (number | null)[]> = { power: [], hr: [], speed: [] };
  let p = 180;
  let h = 130;
  let v = 28;
  for (let i = 0; i < POINTS; i++) {
    const resting = rand() < 0.08; // 模拟滑行/暂停
    p = resting ? 0 : Math.max(60, Math.min(440, p + (rand() - 0.5) * 90));
    h = Math.max(95, Math.min(185, h + (rand() - 0.5) * 6));
    v = resting ? Math.max(0, v - rand() * 3) : Math.max(8, Math.min(52, v + (rand() - 0.5) * 5));
    out.power.push(rand() < 0.01 ? null : Math.round(p)); // 1% 随机缺口
    out.hr.push(Math.round(h));
    out.speed.push(Math.round(v * 100) / 100);
  }
  return out;
}

/** 计算层：值域映射 + points 字符串拼接（null 断段拆多条 Polyline 由渲染层处理） */
function buildFragments(
  values: (number | null)[],
  min: number,
  max: number,
  w: number,
  h: number,
): string[] {
  const frags: string[] = [];
  let cur: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) {
      if (cur.length > 1) frags.push(cur.join(' '));
      cur = [];
      continue;
    }
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / (max - min)) * h;
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (cur.length > 1) frags.push(cur.join(' '));
  return frags;
}

export async function runSvgPerfPoc(): Promise<PocResult> {
  const w = 360;
  const h = 160;
  const t0 = Date.now();
  let fragCount = 0;
  let ptCount = 0;
  for (let round = 0; round < 3; round++) {
    const data = genSeries(42 + round);
    for (const s of SERIES) {
      const frags = buildFragments(data[s.key], s.min, s.max, w, h);
      fragCount += frags.length;
      ptCount += frags.reduce((n, f) => n + f.split(' ').length, 0);
    }
  }
  const buildMs = Date.now() - t0;
  const pass = ptCount > 3 * POINTS * 0.9; // 缺口只占少数
  return {
    pass,
    detail: `${pass ? '✓' : '✗'}\n计算层（3 组 × 3 系列 × ${POINTS} 点坐标映射 + points 拼接）：${buildMs}ms，共 ${ptCount} 点 / ${fragCount} 段\n渲染与重绘流畅度请配合 Perf Monitor 目测下方图表（点「换一组数据」触发整图重渲染）`,
  };
}

export function SvgPerfChart() {
  const { width } = useWindowDimensions();
  const [seed, setSeed] = useState(7);
  const w = width - 32;
  const h = 160;
  const data = useMemo(() => genSeries(seed), [seed]);
  const topPad = 14;
  const chartH = h - topPad;
  return (
    <View style={{ marginTop: 8 }}>
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {/* 网格：4 条横线 */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <Line
            key={f}
            x1={0}
            y1={topPad + chartH * f}
            x2={w}
            y2={topPad + chartH * f}
            stroke={palette.lineSoft}
            strokeWidth={1}
          />
        ))}
        {SERIES.map((s) => {
          const frags = buildFragments(data[s.key], s.min, s.max, w - 34, chartH);
          return (
            <React.Fragment key={s.key}>
              {frags.map((points, i) => (
                <Polyline
                  key={`${s.key}-${i}`}
                  points={points}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.4}
                  transform={`translate(0, ${topPad})`}
                />
              ))}
              <SvgText
                x={w - 2}
                y={topPad + 10 + SERIES.findIndex((x) => x.key === s.key) * 12}
                fill={s.color}
                fontSize={9}
                textAnchor="end">
                {s.label}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
      <Button title="换一组数据（整图重渲染）" color={palette.volt} onPress={() => setSeed((n) => n + 1)} />
    </View>
  );
}

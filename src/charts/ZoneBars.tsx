/**
 * ZoneBars.tsx — 分区分布横条（View 实现，直译 web/js/charts.js zoneBarsHtml 的布局口径）
 *
 * 左区名，中间条形（百分比标签：填充接近满时改放填充色上方），右侧该区具体范围
 * （ranges 由调用方按骑手参数换算，如 { Z2: "58-80" }）。分区配色沿用 Web 版。
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { palette } from '@/theme';

/** Coggan 功率 7 区配色（与 Web 版 style.css 的 zone 色带一致） */
export const POWER_ZONE_COLORS: Record<string, string> = {
  Z1: '#9aa8b5',
  Z2: '#3fd6f5',
  Z3: '#5aa2ff',
  Z4: '#3ddc97',
  Z5: '#ffb03f',
  Z6: '#ff8a5c',
  Z7: '#ff5d73',
};

/** 心率 5 区配色（同功率色带前 5 档口径） */
export const HR_ZONE_COLORS: Record<string, string> = {
  Z1: '#9aa8b5',
  Z2: '#3fd6f5',
  Z3: '#5aa2ff',
  Z4: '#ffb03f',
  Z5: '#ff5d73',
};

interface Props {
  /** 各区百分比（如 { Z1: 31.9, ... }），null 时调用方不渲染本组件 */
  dist: Record<string, number>;
  colors: Record<string, string>;
  /** 各区具体范围文本（按骑手参数换算），缺省隐藏 */
  ranges?: Record<string, string>;
}

export function ZoneBars({ dist, colors, ranges }: Props) {
  return (
    <View style={styles.wrap}>
      {Object.entries(dist).map(([z, pct]) => {
        const c = colors[z] ?? palette.muted;
        const on = pct >= 85; // 填充接近满时百分比改放填充上方（口径同 Web 版）
        return (
          <View key={z} style={styles.row}>
            <Text style={styles.name}>{z}</Text>
            <View style={[styles.track, on && { height: 22 }]}>
              <View style={[styles.fill, { width: `${Math.min(100, pct)}%`, backgroundColor: c }]} />
              <Text
                style={on ? styles.pctOn : [styles.pctAfter, { left: `${Math.min(100, pct)}%` }]}
                numberOfLines={1}>
                {pct.toFixed(1)}%
              </Text>
            </View>
            <Text style={styles.range}>{ranges?.[z] ?? ''}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: palette.text, width: 22, fontSize: 12, fontWeight: '600' },
  track: {
    flex: 1,
    height: 16,
    backgroundColor: palette.panel2,
    borderRadius: 3,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  fill: { height: '100%', borderRadius: 3 },
  pctOn: { color: palette.bg, fontSize: 11, fontWeight: '700', position: 'absolute', right: 4 },
  pctAfter: {
    color: palette.muted,
    fontSize: 11,
    position: 'absolute',
    marginLeft: 6,
  },
  range: { color: palette.faint, width: 64, fontSize: 11, textAlign: 'right' },
});

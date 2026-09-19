/**
 * PeakCurve.tsx — 峰功率曲线柱（View 实现，直译 web/js/charts.js peakCurveHtml 口径）
 *
 * 每柱：瓦特值（等宽大数字）+ 按最大值归一的高度 + 时长标签与 %FTP。
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { palette } from '@/theme';

interface Props {
  /** 峰功率曲线（{ "5s": 248, "1min": 131, ... }），空对象时调用方不渲染 */
  curve: Record<string, number>;
  ftp?: number;
  height?: number;
}

export function PeakCurve({ curve, ftp, height = 120 }: Props) {
  const entries = Object.entries(curve);
  if (!entries.length) return null;
  const max = Math.max(...entries.map(([, w]) => w));
  return (
    <View style={[styles.wrap, { height }]}>
      {entries.map(([label, w]) => {
        const pctFtp = ftp ? Math.round((w / ftp) * 100) : null;
        return (
          <View key={label} style={styles.col}>
            <View style={styles.head}>
              <Text style={styles.val}>{w}</Text>
              <Text style={styles.unit}>W</Text>
            </View>
            <View style={styles.barArea}>
              <View
                style={[
                  styles.bar,
                  { height: `${Math.max(4, (w / max) * 100)}%`, backgroundColor: palette.volt },
                ]}
              />
            </View>
            <Text style={styles.label}>
              {label}
              {pctFtp ? ` · ${pctFtp}%` : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  col: { flex: 1, alignItems: 'center' },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  val: { color: palette.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  unit: { color: palette.muted, fontSize: 11 },
  barArea: { flex: 1, width: '100%', justifyContent: 'flex-end', alignItems: 'center', marginVertical: 4 },
  bar: { width: '70%', maxWidth: 28, borderRadius: 2 },
  label: { color: palette.muted, fontSize: 11 },
});

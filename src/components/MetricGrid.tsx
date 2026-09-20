/**
 * MetricGrid.tsx — 训练详情顶部指标网格（Web 版 .metric-grid 同构）
 *
 * 视觉口径对照 reference/web/style.css：容器底色当 1px 分隔线（gap + 描边）、
 * 单元格 panel 底色、标签大写小字 → 等宽大数字（值 + 小字单位）→ 小字注释。
 * 列数随屏宽自适应（窄屏 2 列同 Web 窄屏；平板/横屏 3–4 列，避免长列表把图表挤到屏外）。
 * 数据（出哪些格、值怎么格式化）由 core/metrics 的 buildActivityMetrics 提供。
 */
import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { metricColumns, type MetricItem } from '@/core/metrics';
import { palette } from '@/theme';

export function MetricGrid({ items }: { items: MetricItem[] }) {
  const { width } = useWindowDimensions();
  const cols = metricColumns(width);
  // 按列切行；末行不足时补空格，保持列对齐（空格与单元格同宽，底色同 panel）
  const rows: MetricItem[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));

  return (
    <View style={styles.grid}>
      {rows.map((row, ri) => (
        <View key={ri} style={styles.row}>
          {Array.from({ length: cols }, (_, ci) => {
            const m = row[ci];
            if (!m) return <View key={ci} style={styles.cell} />;
            return (
              <View key={ci} style={styles.cell}>
                <Text style={styles.label}>{m.label}</Text>
                <Text style={styles.value}>
                  {m.value}
                  {m.unit ? <Text style={styles.unit}> {m.unit}</Text> : null}
                </Text>
                {m.sub ? <Text style={styles.sub}>{m.sub}</Text> : null}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: 1,
    backgroundColor: palette.lineSoft,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', gap: 1 },
  cell: { flex: 1, backgroundColor: palette.panel, paddingHorizontal: 12, paddingVertical: 10, gap: 1 },
  // 标签：大写小字宽字距（Web .metric .m-label 同口径；中文无大写形态，仅字距生效）
  label: { color: palette.faint, fontSize: 10, fontWeight: '700', letterSpacing: 1.8, textTransform: 'uppercase' },
  value: {
    color: palette.text,
    fontSize: 20,
    fontWeight: '700',
    fontStyle: 'italic',
    fontVariant: ['tabular-nums'],
  },
  unit: { fontSize: 12, color: palette.faint, fontStyle: 'normal', fontWeight: '400' },
  sub: { color: palette.muted, fontSize: 11 },
});

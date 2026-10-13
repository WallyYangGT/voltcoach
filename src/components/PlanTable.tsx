/**
 * PlanTable.tsx — 轻量表格组件（v2 训练计划载体：周课表与长期周聚合共用）。
 *
 * charts 体系此前全是 SVG 图表，无表格——本组件以 View 行 + lineSoft 分隔线的
 * 页面既有惯例实现（无新依赖）：表头小字 muted、数据行 tabular-nums、可选高亮行
 * （周视图的"今天"行）。单元格支持字符串或 ReactNode（课型标签/减量周徽标等），
 * 文案由调用方经 i18n 拼好传入，组件自身不取词。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { palette } from '@/theme';

export interface PlanTableColumn {
  key: string;
  /** 表头文案（调用方取词） */
  label: string;
  /** 列宽权重，缺省 1；小列（如 TSS）给 0.7、要点列给 2 */
  flex?: number;
  align?: 'left' | 'right';
}

export function PlanTable({
  columns,
  rows,
  highlightIndex,
}: {
  columns: PlanTableColumn[];
  /** 每行单元格数须与 columns 一致；元素为字符串或已包装的 ReactNode */
  rows: React.ReactNode[][];
  /** 高亮行下标（如周视图的今天）；越界忽略 */
  highlightIndex?: number;
}) {
  return (
    <View>
      <View style={styles.headRow}>
        {columns.map((c) => (
          <View key={c.key} style={{ flex: c.flex ?? 1 }}>
            <Text style={[styles.headCell, c.align === 'right' && styles.cellRight]}>{c.label}</Text>
          </View>
        ))}
      </View>
      {rows.map((cells, i) => (
        <View
          key={i}
          testID={`plan-row-${i}`}
          style={[
            styles.row,
            i === 0 && styles.rowFirst,
            highlightIndex === i && styles.rowHighlight,
          ]}>
          {cells.map((cell, j) => (
            <View key={j} style={{ flex: columns[j]?.flex ?? 1 }}>
              {typeof cell === 'string' ? (
                <Text style={[styles.cell, columns[j]?.align === 'right' && styles.cellRight]}>
                  {cell}
                </Text>
              ) : (
                cell
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    gap: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  headCell: { color: palette.muted, fontSize: 11 },
  row: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: palette.lineSoft,
  },
  rowFirst: { borderTopWidth: 0, paddingTop: 8 },
  rowHighlight: { backgroundColor: palette.panel2, marginHorizontal: -6, paddingHorizontal: 6, borderRadius: 6, paddingBottom: 6 },
  cell: { color: palette.text, fontSize: 12, lineHeight: 18, fontVariant: ['tabular-nums'] },
  cellRight: { textAlign: 'right' },
});

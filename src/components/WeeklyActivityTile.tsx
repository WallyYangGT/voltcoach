/**
 * WeeklyActivityTile.tsx — 首页「近 7 天健康活动量」瓦片（业余模式 P4a）。
 *
 * 纯展示组件：分钟口径由 core/health-activity 汇总（WHO 150–300 中等强度/周，
 * 高强度按 1:2 折算），本组件不做业务判断。只在骑手档案 coach_mode='amateur'
 * 时由首页渲染——标准模式用户看训练指标（CTL/TSS），不叠加健康口径避免噪声。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { WeeklyActivitySummary } from '@/core/health-activity';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export function WeeklyActivityTile({ summary }: { summary: WeeklyActivitySummary }) {
  const { t } = useI18n();
  const ratio = summary.target_min > 0 ? summary.equivalent_min / summary.target_min : 0;
  const pct = Math.max(0, Math.min(1, ratio));
  const met = summary.equivalent_min >= summary.target_min;

  return (
    <View style={styles.panel} testID="weekly-activity-tile">
      <View style={styles.head}>
        <Text style={styles.title}>{t('dash.who.title', { days: summary.days })}</Text>
        {met && <Text style={styles.done}>{t('dash.who.done')}</Text>}
      </View>
      <Text style={styles.value} testID="weekly-activity-value">
        {summary.equivalent_min}
        <Text style={styles.unit}> {t('dash.who.unit')}</Text>
      </Text>
      {/* 进度条用 flex 分配（避免 RN 对百分比字符串宽度的类型/布局差异） */}
      <View style={styles.bar}>
        {pct > 0 && <View style={[styles.fill, { flex: pct }]} />}
        {pct < 1 && <View style={{ flex: 1 - pct }} />}
      </View>
      <Text style={styles.meta}>
        {t('dash.who.target', { target: summary.target_min, extra: summary.extra_min })}
      </Text>
      {summary.vigorous_min > 0 && (
        <Text style={styles.meta}>
          {t('dash.who.vigorous', {
            min: summary.vigorous_min,
            equiv: summary.vigorous_equivalent_min,
          })}
        </Text>
      )}
      {summary.light_min > 0 && (
        <Text style={styles.meta}>{t('dash.who.light', { min: summary.light_min })}</Text>
      )}
      {!summary.power_trusted && (
        <Text style={styles.meta}>{t('dash.who.uncalibrated')}</Text>
      )}
      <Text style={styles.note}>{t('dash.who.note')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: palette.text, fontSize: 13, fontWeight: '700' },
  done: { color: palette.green, fontSize: 11, fontWeight: '700' },
  value: {
    color: palette.volt,
    fontSize: 32,
    fontWeight: '700',
    fontStyle: 'italic',
    fontVariant: ['tabular-nums'],
  },
  unit: { color: palette.muted, fontSize: 12, fontWeight: '400', fontStyle: 'normal' },
  bar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: palette.lineSoft,
  },
  fill: { backgroundColor: palette.volt },
  meta: { color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  note: { color: palette.faint, fontSize: 10, lineHeight: 15 },
});

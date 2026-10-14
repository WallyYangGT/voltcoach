/**
 * PlanReportSection — 计划页底部「规划解读」只读块（AI 体验整合批 AP3）。
 *
 * 把当前查看版本的来源 plan 报告正文只读渲染进计划页（不自动滚动，默认视口停在
 * 计划表）；报告页仍是唯一真源——生成三态/分享/重新生成/追问都在报告页，本块
 * 标题行的「查看生成报告」链接始终可跳。report 为 null（未生成/无来源/被
 * trimAiReports 滚动清出）整段隐藏，降级路径走有效期横幅上的同名链接。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AiReportRow } from '@/db';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import { AiMarkdown } from './AiMarkdown';

interface Props {
  report: AiReportRow | null;
  onViewReport: () => void;
}

export function PlanReportSection({ report, onViewReport }: Props) {
  const { t } = useI18n();
  if (!report) return null;
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.title}>{t('plan.report.head')}</Text>
        <Pressable hitSlop={6} onPress={onViewReport}>
          <Text style={styles.link}>{t('plan.view_report')}</Text>
        </Pressable>
      </View>
      {report.status === 'completed' && !!report.markdown ? (
        <AiMarkdown markdown={report.markdown} />
      ) : report.status === 'pending' ? (
        <Text style={styles.note}>{t('session.generating')}</Text>
      ) : report.status === 'failed' ? (
        <Text style={[styles.note, { color: palette.red }]}>{t('session.failed')}</Text>
      ) : report.status === 'cancelled' ? (
        <Text style={styles.note}>{t('ai.badge.cancelled')}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { color: palette.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  link: { color: palette.volt, fontSize: 12, fontWeight: '600' },
  note: { color: palette.muted, fontSize: 12.5, lineHeight: 18 },
});

/**
 * WeeklyPlanCard.tsx — 首页「本周训练计划」卡（v2 训练计划载体的入口）。
 *
 * 自加载（OnelapSyncCard 先例：useFocusEffect + 自持状态）；未配置 LLM Key 整卡
 * 隐藏（roadmap 口径：不出占位/引导）。状态级联：
 * - 有效期内计划 → 本周摘要（课次/计划 TSS/今天的安排），点击进 /plan；
 * - 已过期 → 摘要置灰 + 「生成计划」CTA（走 report 生成链路：createReportDraft('plan')
 *   + 跳报告页 + fire generateReport——「生成中」状态呈现在报告页，复用保活壳与
 *   轮询口径，卡片不自带进度）；
 * - 无计划 → 引导语（区分「从未生成」与「上次未产出有效计划」两档文案）。
 * 日期一律 localDay 本地日历日口径（与报告标题一致）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  getAiConfig,
  getCurrentPlan,
  listAiReports,
  type StoredPlan,
} from '@/db';
import { createReportDraft, generateReport } from '@/services/aiGenerate';
import { localDay } from '@/core/local-day';
import { formatDuration } from '@/core/metrics';
import { planValidity, slicePlanWeek, weekStartOf } from '@/core/training-plan';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

interface CardData {
  configured: boolean;
  plan: StoredPlan | null;
  hasPlanReport: boolean;
}

export function WeeklyPlanCard() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<CardData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cfg, plan, recent] = await Promise.all([
        getAiConfig(),
        getCurrentPlan(),
        listAiReports('plan', 1),
      ]);
      setData({ configured: cfg.configured, plan, hasPlanReport: recent.length > 0 });
    } catch (e) {
      console.warn('训练计划卡加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onGenerate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // ai.tsx 场景生成同款：draft → 跳报告页（三态与重试都在那边）→ fire 生成
      const id = await createReportDraft('plan', {}, lang);
      router.push(`/ai/session/report-${id}`);
      void generateReport(id, lang).catch((e) => console.warn('计划生成失败:', e));
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, lang, router]);

  // 未配置 Key（含加载中）整卡隐藏，不出占位
  if (!data?.configured) return null;

  const stored = data.plan;
  const today = localDay();
  const validity = stored ? planValidity(stored.plan, today) : null;
  const summaryRows: string[] = [];
  if (stored) {
    const week = slicePlanWeek(stored.plan, weekStartOf(today));
    const sessions = week.filter((s) => s.type !== 'rest');
    const tssTotal = Math.round(week.reduce((acc, s) => acc + (s.tss ?? 0), 0));
    summaryRows.push(
      validity!.state === 'expired'
        ? t('plan.card.expired')
        : validity!.state === 'upcoming'
          ? t('plan.card.upcoming', {
              date: stored.plan.valid_from,
              n: stored.plan.sessions.filter((s) => s.type !== 'rest').length,
            })
          : t('plan.card.valid', { n: sessions.length, tss: tssTotal }),
    );
    const todaySession = stored.plan.sessions.find((s) => s.date === today);
    if (todaySession) {
      const text =
        todaySession.type === 'rest' || todaySession.duration_min == null
          ? t('plan.card.rest_today')
          : `${t(`plan.type.${todaySession.type}` as never)} · ${formatDuration(todaySession.duration_min * 60)} · TSS ${Math.round(todaySession.tss ?? 0)}`;
      summaryRows.push(t('plan.card.today', { text }));
    }
  }
  const expired = validity?.state === 'expired';

  return (
    <View style={styles.card} testID="weekly-plan-card">
      <View style={styles.head}>
        <Text style={styles.title}>{t('plan.card.title')}</Text>
        {stored && !expired && (
          <Pressable hitSlop={8} onPress={() => router.push('/plan')}>
            <Text style={styles.open}>{t('plan.card.open')}</Text>
          </Pressable>
        )}
      </View>

      {stored ? (
        expired ? (
          <>
            {summaryRows.map((line, i) => (
              <Text key={i} style={styles.sub}>
                {line}
              </Text>
            ))}
            <Pressable disabled={busy} onPress={onGenerate}>
              <Text style={[styles.cta, busy && { opacity: 0.5 }]}>{t('plan.card.cta')}</Text>
            </Pressable>
          </>
        ) : (
          <Pressable onPress={() => router.push('/plan')}>
            {summaryRows.map((line, i) => (
              <Text key={i} style={i === 0 ? styles.summary : styles.sub}>
                {line}
              </Text>
            ))}
          </Pressable>
        )
      ) : (
        <>
          <Text style={styles.sub}>
            {data.hasPlanReport ? t('plan.card.regen') : t('plan.card.none')}
          </Text>
          <Pressable disabled={busy} onPress={onGenerate}>
            <Text style={[styles.cta, busy && { opacity: 0.5 }]}>{t('plan.card.cta')}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 8,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: palette.text, fontSize: 14, fontWeight: '700' },
  open: { color: palette.volt, fontSize: 12, fontWeight: '600' },
  summary: { color: palette.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  sub: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  cta: { color: palette.volt, fontSize: 13, fontWeight: '700' },
});

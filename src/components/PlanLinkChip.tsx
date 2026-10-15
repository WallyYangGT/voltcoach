/**
 * PlanLinkChip.tsx — 报告↔计划结构化关联的展示半边（U1 收尾③）。
 *
 * 报告详情正文顶部的条件小链接：关联计划 · 第 N 版（valid_from ~ valid_to）→
 * 深链计划页定位该版本；版本被 history_keep 裁出历史后显示「已归档」（不可跳）。
 * 数据 = settings 链接行（getPlanReportLink，generateReport 收尾写入）+
 * locatePlanVersion 定位（core 纯函数）。无关联（含功能上线前的存量报告）整段隐藏。
 * 自加载（reportId 变化时重查），AiReportBody 内挂载——会话详情页与训练详情页
 * AI 面板两个宿主同时获得，行为一致。
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { getCurrentPlan, getPlanHistory, getPlanReportLink } from '@/db';
import { locatePlanVersion } from '@/core/training-plan';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 定位结果：版本号 + 有效期（chip 文案用）；'archived' = 锚还在但版本已裁出历史 */
export type PlanLinkInfo =
  | { versionNo: number; validFrom: string; validTo: string }
  | 'archived';

export function usePlanVersionLink(reportId: number | null): PlanLinkInfo | null {
  const [info, setInfo] = useState<PlanLinkInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (reportId == null) return;
        const anchor = await getPlanReportLink(reportId);
        if (!anchor) return; // 无关联（存量报告）→ 隐藏
        const [current, history] = await Promise.all([getCurrentPlan(), getPlanHistory()]);
        const located = locatePlanVersion(current, history, anchor);
        if (!located) {
          if (alive) setInfo('archived');
          return;
        }
        const stored =
          current?.created_at === anchor ? current : history.find((h) => h.created_at === anchor);
        if (alive && stored) {
          setInfo({
            versionNo: located.versionNo,
            validFrom: stored.plan.valid_from,
            validTo: stored.plan.valid_to,
          });
        }
      } catch (e) {
        console.warn('计划关联加载失败:', e); // 库损坏/换库期间：chip 静默隐藏
      }
    })();
    return () => {
      alive = false;
    };
  }, [reportId]);
  return info;
}

export function PlanLinkChip({ reportId }: { reportId: number }) {
  const { t } = useI18n();
  const router = useRouter();
  const info = usePlanVersionLink(reportId);
  if (!info) return null;
  const label =
    info === 'archived'
      ? t('ai.plan_link.archived')
      : t('ai.plan_link.chip', { n: info.versionNo, from: info.validFrom, to: info.validTo });
  return (
    <Pressable
      hitSlop={6}
      disabled={info === 'archived'}
      onPress={() =>
        info !== 'archived' &&
        router.push({ pathname: '/plan', params: { version: String(info.versionNo) } })
      }>
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { color: palette.volt, fontSize: 12, fontWeight: '600' },
});

/**
 * PlanAdherenceCard.tsx — 计划页「本周执行情况」卡（U1 收尾②：本地 adherence 视图）。
 *
 * 「本周」计划 vs 实际 TSS/时长并排，三态判定（完成 / 降强完成 / 未做）在
 * core/plan-adherence 纯函数（量化单源 PLAN_ADHERENCE，组件零硬编码）；此前只有
 * AI 技能 07 问出来的对比，无确定性 UI。
 *
 * 数据口径：实际训练按存储 UTC 日 ±1 天缓冲拉取，行级本地日归并走
 * resolveRideDateLabels（records 首帧，§24 双口径统一的同一瞬间源），缺首帧回退
 * 存储 UTC 日——不在 join 处引入第三种对齐口径。随周锚点（weekStart prop）切换
 * 重取：过去周看完成率、当前周看进行时、未来周整列 pending。
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { listActivitiesInRange, type ActivityListItem } from '@/db';
import { resolveRideDateLabels } from '@/services/aiTitle';
import {
  computeAdherence,
  type AdherenceStatus,
  type DayActual,
  type DayAdherence,
} from '@/core/plan-adherence';
import { addDays, slicePlanWeek, type TrainingPlan } from '@/core/training-plan';
import { formatDuration } from '@/core/metrics';
import { PlanTable, type PlanTableColumn } from '@/components/PlanTable';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

interface Props {
  plan: TrainingPlan;
  /** 周锚点（ISO 周一，plan 页周视图同一锚） */
  weekStart: string;
  /** 本地「今天」（localDay，调用方传入保持口径单源） */
  today: string;
}

/** 状态配色：绿=完成 / 橙=降强完成 / 灰=未做 / faint=未到 */
const STATUS_COLOR: Record<AdherenceStatus, string> = {
  done: palette.green,
  partial: palette.orange,
  missed: palette.muted,
  pending: palette.faint,
};

export function PlanAdherenceCard({ plan, weekStart, today }: Props) {
  const { t } = useI18n();
  const [rows, setRows] = useState<DayAdherence[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // UTC 日缓冲 ±1 天：清晨/深夜起骑的本地日可能落在相邻 UTC 日（§24）
        const acts = await listActivitiesInRange(addDays(weekStart, -1), addDays(weekStart, 7));
        const labeled = await mergeByLocalDay(acts);
        if (alive) setRows(computeAdherence(slicePlanWeek(plan, weekStart), labeled, today));
      } catch (e) {
        console.warn('执行情况加载失败:', e);
        if (alive) setRows([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [plan, weekStart, today]);

  // 只评排了非 rest 课的日期（rest/无课不评）；整周无课不渲染整卡
  const judged = rows?.filter((r) => r.status != null) ?? [];
  if (rows == null || judged.length === 0) return null;

  const dowOf = (date: string) =>
    t(`plan.dow.${(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7 + 1}` as never);

  const columns: PlanTableColumn[] = [
    { key: 'day', label: t('plan.adherence.col.day'), flex: 1.6 },
    { key: 'type', label: t('plan.adherence.col.type'), flex: 1 },
    { key: 'planned', label: t('plan.adherence.col.planned'), flex: 0.9, align: 'right' },
    { key: 'actual', label: t('plan.adherence.col.actual'), flex: 0.9, align: 'right' },
    { key: 'dur', label: t('plan.adherence.col.dur'), flex: 0.9, align: 'right' },
    { key: 'status', label: t('plan.adherence.col.status'), flex: 1 },
  ];
  const tableRows = judged.map((r) => [
    `${dowOf(r.date)} ${r.date.slice(5)}`,
    t(`plan.type.${r.planned!.type}` as never),
    String(Math.round(r.plannedTss)),
    String(Math.round(r.actualTss)),
    r.actualMin > 0 ? formatDuration(r.actualMin * 60) : '—',
    <Text key="status" style={[styles.status, { color: STATUS_COLOR[r.status!] }]}>
      {t(`plan.adherence.${r.status}` as never)}
    </Text>,
  ]);

  return (
    <View style={styles.panel} testID="plan-adherence-card">
      <Text style={styles.title}>{t('plan.adherence.title')}</Text>
      <PlanTable columns={columns} rows={tableRows} highlightIndex={judged.findIndex((r) => r.date === today)} />
      <Text style={styles.note}>{t('plan.adherence.note')}</Text>
    </View>
  );
}

/** 实际训练按本地日历日归并（records 首帧换算；缺首帧回退存储 UTC 日，§24 口径不猜） */
async function mergeByLocalDay(acts: ActivityListItem[]): Promise<DayActual[]> {
  const labels = await resolveRideDateLabels(acts.map((a) => a.uuid));
  const byDay = new Map<string, DayActual>();
  for (const a of acts) {
    const day = labels.get(a.uuid) ?? a.date;
    const cur = byDay.get(day) ?? { date: day, tss: 0, durationSec: 0 };
    cur.tss += a.tss ?? 0;
    cur.durationSec += a.duration_sec ?? 0;
    byDay.set(day, cur);
  }
  return [...byDay.values()];
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  title: { color: palette.text, fontSize: 13, fontWeight: '700' },
  status: { fontSize: 12, lineHeight: 18, fontWeight: '600' },
  note: { color: palette.faint, fontSize: 11 },
});

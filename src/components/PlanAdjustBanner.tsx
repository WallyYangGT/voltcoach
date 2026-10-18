/**
 * PlanAdjustBanner.tsx — 计划「AI 调整披露条」（U1 收尾④：局部调整的披露与可逆）。
 *
 * 当前版 origin='adjust'（最近一次落库来自会话调整）时显示摘要（哪天调的 +
 * change_note）+ 撤销入口：undoLastPlanVersion 回滚上一版本（current↔history[0]
 * 交换，可再撤销换回）。沿 AiFtpUpdateBanner 先例（voltDim 描边 + Alert 二次确认）。
 *
 * 数据两条路（§22 P1-3 同款教训：tab 常驻挂载下「只在挂载时自查」会漏更新）：
 * - props 传入（plan 页）：页面轮询收尾 load() 刷新 stored/history，本页内完成的
 *   调整立即反映；
 * - 自加载（首页）：getCurrentPlan + getPlanHistory + useFocusEffect 每次回焦点
 *   重取——调整发生在计划页，返回首页即回焦点，立即可见。
 * 一次性披露（2026-10-18）：显示后由 useAdjustNoticeVisible 写已读锚
 * （settings adjust_notice_seen:plan_adjust = 当前版 created_at）；本次停留保留
 * 撤销入口，下次进入页面/冷启动读锚相同即不再出现。新调整版本（新 created_at）
 * 重新披露一次。
 * 显示条件：当前版是 adjust 落库且该版本尚未被浏览过——被生成新版替换/手动撤销/
 * 已读后自然隐藏。
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { getCurrentPlan, getPlanHistory, undoLastPlanVersion, type StoredPlan } from '@/db';
import { localDayFromUtc } from '@/core/local-day';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import { useAdjustNoticeVisible } from './useAdjustNotice';

interface Props {
  /** 由宿主下传（plan 页：轮询收尾已刷新）；缺省自加载（首页） */
  stored?: StoredPlan | null;
  /** 与 stored 配套的历史（撤销入口的可达判断用）；缺省自加载 */
  history?: StoredPlan[];
  /** 撤销成功后回调（宿主刷新自身数据） */
  onChanged?: () => void;
}

export function PlanAdjustBanner({ stored: storedProp, history: historyProp, onChanged }: Props) {
  const { t } = useI18n();
  const [self, setSelf] = useState<{ stored: StoredPlan; history: StoredPlan[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const selfMode = storedProp === undefined;

  const load = useCallback(async () => {
    try {
      const [stored, history] = await Promise.all([getCurrentPlan(), getPlanHistory()]);
      setSelf(stored ? { stored, history } : null);
    } catch (e) {
      console.warn('计划调整披露条加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (selfMode) void load();
    }, [selfMode, load]),
  );

  const stored = selfMode ? (self?.stored ?? null) : (storedProp ?? null);
  const history = selfMode ? (self?.history ?? []) : (historyProp ?? []);
  // 已读闸门：锚 = 当前 adjust 版本 created_at；本次停留仍显示，下次聚焦才隐藏
  const noticeVisible = useAdjustNoticeVisible(
    'plan_adjust',
    stored?.origin === 'adjust' ? stored.created_at : null,
    stored?.origin === 'adjust',
  );

  const undo = () => {
    Alert.alert(t('plan.adjust.undo_title'), t('plan.adjust.undo_body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('plan.adjust.undo'),
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          undoLastPlanVersion()
            .then((ok) => {
              if (ok) {
                if (selfMode) void load(); // 撤销后当前版回退为 generate → 条目自然隐藏
                onChanged?.();
              } else {
                Alert.alert(t('plan.adjust.undo_title'), t('plan.adjust.undo_stale'));
              }
            })
            .catch((e) => {
              // 撤销失败必须有反馈，静默会让用户以为已撤销（AiFtpUpdateBanner 同款）
              Alert.alert(t('data.err.generic'), e instanceof Error ? e.message : String(e));
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  if (!stored || stored.origin !== 'adjust' || !noticeVisible) return null;
  const day = localDayFromUtc(stored.created_at) ?? stored.created_at.slice(0, 10);
  return (
    <View style={styles.banner} testID="plan-adjust-banner">
      <Text style={styles.text}>
        {t('plan.adjust.banner', { date: day, note: stored.change_note ?? t('plan.adjust.no_note') })}
      </Text>
      {history.length > 0 && (
        <Pressable
          style={styles.undoBtn}
          disabled={busy}
          onPress={undo}
          accessibilityRole="button"
          accessibilityLabel={t('plan.adjust.undo')}>
          <Text style={styles.undoText}>{t('plan.adjust.undo')}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: palette.panel,
    borderColor: palette.voltDim,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  text: { color: palette.muted, fontSize: 12, lineHeight: 18, flex: 1 },
  undoBtn: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: palette.voltDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  undoText: { color: palette.volt, fontSize: 12, fontWeight: '600' },
});

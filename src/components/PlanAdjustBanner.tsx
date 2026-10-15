/**
 * PlanAdjustBanner.tsx — 计划「AI 调整披露条」（U1 收尾④：局部调整的披露与可逆）。
 *
 * 当前版 origin='adjust'（最近一次落库来自会话调整）时显示摘要（哪天调的 +
 * change_note）+ 撤销入口：undoLastPlanVersion 回滚上一版本（current↔history[0]
 * 交换，可再撤销换回）。沿 AiFtpUpdateBanner 先例（voltDim 描边 + Alert 二次确认），
 * 自加载（getCurrentPlan + getPlanHistory，useFocusEffect 每次回焦点重取——
 * WeeklyPlanCard 同款，tab 常驻挂载下调整后返回首页立即可见）。
 * 显示条件：当前版是 adjust 落库——被生成新版替换/手动撤销后自然隐藏。
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { getCurrentPlan, getPlanHistory, undoLastPlanVersion, type StoredPlan } from '@/db';
import { localDayFromUtc } from '@/core/local-day';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export function PlanAdjustBanner({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<{ stored: StoredPlan; history: StoredPlan[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [stored, history] = await Promise.all([getCurrentPlan(), getPlanHistory()]);
      setData(stored ? { stored, history } : null);
    } catch (e) {
      console.warn('计划调整披露条加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!data || data.stored.origin !== 'adjust') return null;
  const { stored, history } = data;

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
                void load(); // 撤销后当前版回退为 generate → 条目自然隐藏
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

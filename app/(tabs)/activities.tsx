/**
 * 训练列表（M1）：按日期倒序的训练清单 + FAB「＋」导入 FIT（MD3）。
 * 行数据来自训练库 listActivities（入库键 file_name 即详情页路由参数）。
 * M5：每行可左滑露出删除按钮（ReanimatedSwipeable，需根布局的 GestureHandlerRootView），
 * 确认后删训练行 + 其逐秒数据；已生成的 AI 报告保留（弹窗文案已说明）。
 */
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FAB } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatDuration } from '@/core/metrics';
import { deleteActivity, listActivities, type ActivityListItem } from '@/db';
import { useI18n } from '@/i18n';
import { deleteStoredRecord } from '@/records-store';
import { invalidateReportTitles } from '@/services/aiTitle';
import { palette } from '@/theme';

export default function ActivitiesScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ActivityListItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 左滑行的控制器（按文件名索引）：同一时刻只留一行展开，避免多行悬空
  const swipeRefs = useRef(new Map<string, SwipeableMethods>());

  const load = useCallback(async () => {
    try {
      setItems(await listActivities());
    } catch (e) {
      console.warn('listActivities 失败:', e);
      setItems([]);
    }
  }, []);

  // 每次进入该 tab 刷新（导入返回后立即看到新记录）
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  /** 收起除 keep 之外的所有左滑行（打开新行时调用） */
  const closeOthers = (keep: string) => {
    for (const [name, methods] of swipeRefs.current) {
      if (name !== keep) methods.close();
    }
  };

  const confirmDelete = (fileName: string) => {
    Alert.alert(t('activities.deleteTitle'), t('activities.deleteMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deleteActivity(fileName);
            } catch (e) {
              console.warn('删除训练失败:', e);
              Alert.alert(t('data.err.generic'), e instanceof Error ? e.message : String(e));
              return;
            }
            // 逐秒数据清理失败不该让界面停在旧列表（行已删）：只记警告
            try {
              deleteStoredRecord(fileName);
            } catch (e) {
              console.warn('逐秒数据清理失败（训练已删除）:', e);
            }
            invalidateReportTitles(fileName);
            await load();
          })();
        },
      },
    ]);
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top + 12 }]}>
      <FlatList
        data={items ?? []}
        keyExtractor={(r) => r.file_name}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={palette.muted}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={<Text style={styles.title}>{t('activities.title')}</Text>}
        ListEmptyComponent={
          items == null ? null : ( // null = 首次加载中，不闪空态
            <Text style={styles.empty}>{t('activities.empty')}</Text>
          )
        }
        renderItem={({ item }) => (
          <ReanimatedSwipeable
            // ⚠️ 这个 ref 回调必须保持「返回 undefined」：返回清理函数时 React 19 不再以
            // null 调用它，下面 Map 的失效清理就不会发生（失效引用残留 → closeOthers 崩）
            ref={(r) => {
              if (r) swipeRefs.current.set(item.file_name, r);
              else swipeRefs.current.delete(item.file_name);
            }}
            friction={2}
            rightThreshold={40}
            overshootRight={false}
            containerStyle={styles.swipeContainer}
            onSwipeableWillOpen={(dir) => {
              // 注意方向语义：库在「向左滑露出右侧面板」时回调 LEFT（内部按 translateX
              // 正负派发，右侧面板的目标位移是 -rightWidth），见 ReanimatedSwipeable
              // 的 dispatchImmediateEvents。这里只渲染右侧删除动作，故判 left。
              if (dir === 'left') closeOthers(item.file_name);
            }}
            renderRightActions={() => (
              <Pressable
                style={({ pressed }) => [styles.deleteAction, pressed && { opacity: 0.7 }]}
                onPress={() => confirmDelete(item.file_name)}>
                <Text style={styles.deleteText}>{t('common.delete')}</Text>
              </Pressable>
            )}>
            <Pressable
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
              onPress={() =>
                router.push({
                  pathname: '/activity/[id]',
                  params: { id: encodeURIComponent(item.file_name) },
                })
              }>
              <View style={styles.cardTop}>
                <Text style={styles.date}>{item.date}</Text>
                <View style={styles.badges}>
                  <Text style={[styles.sport, item.category === 'race' && { color: palette.volt }]}>
                    {t(`cat.${item.category}` as never)}
                  </Text>
                  <Text style={styles.sport}>{t(`sport.${item.sport}` as never)}</Text>
                </View>
              </View>
              <View style={styles.metrics}>
                <Metric label={t('act.duration')} value={formatDuration(item.duration_sec)} />
                <Metric label="km" value={item.distance_km != null ? item.distance_km.toFixed(2) : '—'} />
                <Metric label="TSS" value={item.tss != null ? String(item.tss) : '—'} />
                <Metric label="NP" value={item.np != null ? `${item.np}W` : '—'} />
              </View>
            </Pressable>
          </ReanimatedSwipeable>
        )}
        contentContainerStyle={items?.length ? styles.list : { flexGrow: 1, justifyContent: 'center', paddingBottom: 96 }}
      />
      <FAB
        icon="plus"
        label={t('activities.import_fab')}
        color={palette.bg}
        style={styles.fab}
        onPress={() => router.push('/import')}
      />
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricVal}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg, paddingHorizontal: 16 },
  title: { color: palette.text, fontSize: 22, fontWeight: '700', marginBottom: 10 },
  list: { paddingBottom: 96, gap: 10 },
  // 左滑容器要让出 FlatList 的 gap（间距挂在容器上，卡片自身不再带外边距）
  swipeContainer: { borderRadius: 10, overflow: 'hidden' },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  badges: { flexDirection: 'row', gap: 8 },
  date: { color: palette.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sport: { color: palette.muted, fontSize: 12 },
  metrics: { flexDirection: 'row', gap: 18 },
  metric: { gap: 2 },
  metricVal: { color: palette.text, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  metricLabel: { color: palette.faint, fontSize: 11 },
  deleteAction: {
    width: 88,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: palette.red,
  },
  deleteText: { color: palette.bg, fontSize: 13, fontWeight: '700' },
  empty: { color: palette.muted, textAlign: 'center', lineHeight: 24 },
  fab: { position: 'absolute', right: 16, bottom: 16, backgroundColor: palette.volt },
});

/**
 * AI 记忆管理页（M3，自 Web 版 views/memory.js 移植）：只删不编辑（口径同旧版——
 * 记忆由 AI 通过 save_memory 工具维护，用户仅可删除）。
 * v2 分层标注：scope=short 的记忆显示「短期」标签，已过失效线的灰显并标「已过期」
 * （注入时会被过滤，但保留在列表中供追溯；口径见 core/memory.ts）。
 * 2026-10-13 分区改版：短期记忆区置顶（近期上下文最常回看）、长期记忆区在下；
 * 页脚一行提示「需模型支持工具调用」——若服务商拒 tools 静默降级导致记忆绝迹，
 * 这是用户侧的自诊断入口（工具降级在编排层只有 console 痕迹，UI 无从展示）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteMemory, listAllMemories, type AiMemoryRow } from '@/db';
import { localDayFromUtc } from '@/core/local-day';
import { useI18n } from '@/i18n';
import { useDbInvalidation } from '@/components/useDbInvalidation';
import { palette } from '@/theme';

export default function MemoryScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [memories, setMemories] = useState<AiMemoryRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      setMemories(await listAllMemories());
    } catch (e) {
      console.warn('记忆页加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // AI 生成收尾的记忆回顾轮会写库（save_memory），本页可能正开着 → 重取
  useDbInvalidation(['memories'], load);

  const confirmDelete = (m: AiMemoryRow) => {
    Alert.alert(t('mem.delete'), t('mem.deleteMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('mem.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteMemory(m.id);
            load();
          } catch (e) {
            console.warn('删除记忆失败:', e);
          }
        },
      },
    ]);
  };

  const shorts = (memories ?? []).filter((m) => m.scope === 'short');
  const longs = (memories ?? []).filter((m) => m.scope !== 'short');

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={t('mem.title')} titleStyle={styles.headerTitle} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }}>
        <Text style={styles.sub}>{t('mem.sub')}</Text>

        {/* 短期区置顶：近期上下文（有效期内注入 prompt，过期灰显供追溯） */}
        <Text style={styles.sectionTitle}>
          {t('mem.section.short')}
          {memories != null ? ` · ${shorts.length}` : ''}
        </Text>
        {memories != null && shorts.length === 0 && (
          <Text style={styles.empty}>{t('mem.empty.short')}</Text>
        )}
        {shorts.map((m) => (
          <MemoryCard key={m.id} m={m} onDelete={confirmDelete} />
        ))}

        {/* 长期区在下：默认 scope，不过期（除非被取代/删除） */}
        <Text style={styles.sectionTitle}>
          {t('mem.section.long')}
          {memories != null ? ` · ${longs.length}` : ''}
        </Text>
        {memories != null && longs.length === 0 && (
          <Text style={styles.empty}>{t('mem.empty.long')}</Text>
        )}
        {longs.map((m) => (
          <MemoryCard key={m.id} m={m} onDelete={confirmDelete} />
        ))}

        <Text style={styles.hint}>{t('mem.hint')}</Text>
      </ScrollView>
    </View>
  );
}

/** 单条记忆卡（日期/分类/来源/短期标签/状态/#id + 删除），两区共用 */
function MemoryCard({ m, onDelete }: { m: AiMemoryRow; onDelete: (m: AiMemoryRow) => void }) {
  const { t } = useI18n();
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        {/* created_at 是 SQLite UTC 时刻文本 → 本地日历日（双口径统一；解析失败回退原前 10 位） */}
        <Text style={styles.date}>{localDayFromUtc(m.created_at) ?? String(m.created_at).slice(0, 10)}</Text>
        <Text style={[styles.cat, m.category === 'strategy' && styles.strategyCat]}>
          {t(`mem.cat.${m.category}` as never)}
        </Text>
        {m.scope === 'short' && (
          <Text style={[styles.scopeTag, m.expired && styles.expiredTag]}>
            {t('mem.scope.short')}
          </Text>
        )}
        {!!m.source && <Text style={styles.source}>{m.source}</Text>}
        <Text style={[styles.state, { color: m.active ? palette.green : palette.faint }]}>
          {m.active ? t('mem.active') : t('mem.superseded')}
        </Text>
        {m.scope === 'short' && m.expired && (
          <Text style={[styles.state, { color: palette.orange }]}>{t('mem.expired')}</Text>
        )}
        <Text style={[styles.state, { color: palette.faint }]}>#{m.id}</Text>
        <Text style={styles.spacer} />
        <Text onPress={() => onDelete(m)} style={styles.del}>
          {t('mem.delete')}
        </Text>
      </View>
      <Text
        style={[
          styles.content,
          (!m.active || (m.scope === 'short' && m.expired)) && { color: palette.faint },
        ]}>
        {m.content}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, borderBottomWidth: 1, borderBottomColor: palette.lineSoft },
  headerTitle: { color: palette.text, fontSize: 15 },
  sub: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  sectionTitle: { color: palette.volt, fontSize: 13, fontWeight: '700', marginTop: 8 },
  empty: { color: palette.muted, fontSize: 13, textAlign: 'center', marginTop: 8 },
  hint: { color: palette.faint, fontSize: 11, lineHeight: 16, marginTop: 12 },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  date: { color: palette.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  cat: { color: palette.cyan, fontSize: 11 },
  strategyCat: { color: palette.volt, fontWeight: '700' },
  scopeTag: { color: palette.blue, fontSize: 11 },
  expiredTag: { color: palette.faint },
  source: { color: palette.faint, fontSize: 11 },
  state: { fontSize: 11 },
  spacer: { flex: 1 },
  del: { color: palette.red, fontSize: 12 },
  content: { color: palette.text, fontSize: 13, lineHeight: 20 },
});

// 路由级错误边界（架构评审 T2）：本屏渲染异常在此兜底，不再冒泡到根边界丢失导航位置
export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';

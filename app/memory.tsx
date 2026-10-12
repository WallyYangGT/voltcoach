/**
 * AI 记忆管理页（M3，自 Web 版 views/memory.js 移植）：全部记忆列表
 * （日期/分类/来源/内容，含已被取代的记忆并标记），只删不编辑（口径同旧版——
 * 记忆由 AI 通过 save_memory 工具维护，用户仅可删除）。
 * v2 分层标注：scope=short 的记忆显示「短期」标签，已过失效线的灰显并标「已过期」
 * （注入时会被过滤，但保留在列表中供追溯；口径见 core/memory.ts）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteMemory, listAllMemories, type AiMemoryRow } from '@/db';
import { useI18n } from '@/i18n';
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

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={t('mem.title')} titleStyle={styles.headerTitle} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }}>
        <Text style={styles.sub}>{t('mem.sub')}</Text>
        {memories != null && memories.length === 0 && (
          <Text style={styles.empty}>{t('mem.empty')}</Text>
        )}
        {(memories ?? []).map((m) => (
          <View key={m.id} style={styles.card}>
            <View style={styles.head}>
              <Text style={styles.date}>{String(m.created_at).slice(0, 10)}</Text>
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
              <Text onPress={() => confirmDelete(m)} style={styles.del}>
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
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, borderBottomWidth: 1, borderBottomColor: palette.lineSoft },
  headerTitle: { color: palette.text, fontSize: 15 },
  sub: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  empty: { color: palette.muted, fontSize: 13, textAlign: 'center', marginTop: 32 },
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

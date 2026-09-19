/**
 * FIT 导入页（M1）：FAB 触发的全屏模态。
 * 流程：DocumentPicker 多选 .fit → 逐文件 importFitSource（解析+入库+records 落盘）
 * → 结果列表（成功项可跳详情）。支持带 uri 参数进入（安卓分享面板接收，M1）。
 */
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Button, ProgressBar } from 'react-native-paper';
import { useI18n } from '@/i18n';
import type { ImportOutcome } from '@/services/importFit';
import { importFitSource } from '@/services/importFit';
import { takeShareFile } from '@/services/shareQueue';
import { palette } from '@/theme';

/** 待导入源（分享面板进入时由路由参数带入） */
interface PendingSource {
  uri: string;
  fileName: string;
}

export default function ImportScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0); // 本轮文件总数（进度 i/total）
  const [progress, setProgress] = useState<number | null>(null); // 0..1
  const shareChecked = useRef(false);

  const runImport = async (sources: PendingSource[]) => {
    if (!sources.length) return;
    setRunning(true);
    setTotal(sources.length);
    setOutcomes([]);
    const results: ImportOutcome[] = [];
    for (let i = 0; i < sources.length; i++) {
      setProgress(i / sources.length);
      const { uri, fileName } = sources[i];
      try {
        const summary = await importFitSource(uri, fileName);
        results.push({ fileName, ok: true, summary });
      } catch (e) {
        results.push({
          fileName,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      setOutcomes([...results]);
    }
    setProgress(1);
    setRunning(false);
  };

  const pickAndImport = async () => {
    // .fit 无通用 MIME，用 */* 全类型；copyToCacheDirectory 保证 file:// URI 可读
    const picked = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (picked.canceled) return;
    const fits = picked.assets
      .filter((a) => (a.name ?? '').toLowerCase().endsWith('.fit'))
      .map((a) => ({ uri: a.uri, fileName: a.name ?? 'unnamed.fit' }));
    if (!fits.length) {
      setOutcomes([{ fileName: '', ok: false, error: t('import.no_fit') }]);
      return;
    }
    await runImport(fits);
  };

  // 分享面板接收：根布局把文件入队 shareQueue 后跳到本页，挂载时取走导入
  useEffect(() => {
    if (shareChecked.current) return;
    shareChecked.current = true;
    const shared = takeShareFile();
    if (shared) runImport([shared]);
  }, []);

  const okCount = outcomes.filter((o) => o.ok).length;

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={0}>
        <Appbar.BackAction color={palette.text} onPress={() => router.back()} />
        <Appbar.Content title={t('import.title')} titleStyle={{ color: palette.text }} />
      </Appbar.Header>

      <View style={styles.body}>
        <Button
          mode="contained"
          buttonColor={palette.volt}
          textColor={palette.bg}
          icon="file-upload-outline"
          onPress={pickAndImport}
          disabled={running}
          style={styles.pickBtn}>
          {t('import.pick')}
        </Button>

        {running && progress != null && (
          <Text style={styles.running}>
            {t('import.running', { i: Math.min(outcomes.length + 1, total), n: total })}
          </Text>
        )}
        <ProgressBar
          progress={progress ?? 0}
          color={palette.volt}
          visible={running || progress === 1}
          style={styles.progress}
        />

        {!running && outcomes.length > 0 && (
          <Text style={styles.doneLine}>
            {t('import.done', { ok: okCount, fail: outcomes.length - okCount })}
          </Text>
        )}

        <ScrollView style={styles.results} contentContainerStyle={{ gap: 8, paddingBottom: 24 }}>
          {outcomes.map((o, i) => (
            <Pressable
              key={`${o.fileName}-${i}`}
              disabled={!o.ok}
              onPress={() =>
                router.replace({
                  pathname: '/activity/[id]',
                  params: { id: encodeURIComponent(o.fileName) },
                })
              }
              style={({ pressed }) => [
                styles.item,
                o.ok ? styles.itemOk : styles.itemFail,
                pressed && { opacity: 0.7 },
              ]}>
              <Text style={styles.itemName} numberOfLines={1}>
                {o.fileName || '—'}
              </Text>
              {o.ok ? (
                <Text style={styles.itemMeta}>
                  {t('import.item_ok', {
                    np: o.summary?.power?.normalized_power ?? '—',
                    tss: o.summary?.power?.tss ?? '—',
                  })}{' '}
                  ›
                </Text>
              ) : (
                <Text style={styles.itemError} numberOfLines={2}>
                  ✗ {o.error}
                </Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bgSoft },
  body: { flex: 1, padding: 16, gap: 12 },
  pickBtn: { borderRadius: 8 },
  running: { color: palette.muted, fontSize: 13 },
  progress: { backgroundColor: palette.panel2 },
  doneLine: { color: palette.text, fontWeight: '600' },
  results: { flex: 1 },
  item: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  itemOk: { borderLeftColor: palette.green, borderLeftWidth: 3 },
  itemFail: { borderLeftColor: palette.red, borderLeftWidth: 3 },
  itemName: { color: palette.text, fontSize: 13, fontWeight: '600' },
  itemMeta: { color: palette.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  itemError: { color: palette.red, fontSize: 12 },
});

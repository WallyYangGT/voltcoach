/**
 * ErrorScreen — 根布局错误边界兜底页（M5）
 *
 * 由 app/_layout.tsx 以 expo-router 的 ErrorBoundary 导出使用：任何路由段内
 * 未捕获的渲染异常都落到这里，避免整屏白屏/闪退观感。边界渲染时 Provider 树
 * 已不可用（I18nContext/SafeAreaContext 都在 RootLayout 内部），因此语言直接
 * 读 AsyncStorage（缺省 zh）、布局用固定内边距；文案仍走 dict.ts 双语词典，
 * 与全应用同一来源。重试失败可反复点，确定性异常按提示重启应用。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ErrorBoundaryProps } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';
import { DICT, detectLang, LANG_STORAGE_KEY, type DictKey, type Lang } from '@/i18n';
import { palette } from '@/theme';

export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  const [lang, setLang] = useState<Lang>('zh');

  useEffect(() => {
    // logcat 留痕（ReactNativeJS 级可 grep），便于事后排查用户反馈
    console.error('[ErrorBoundary]', error?.message);
    AsyncStorage.getItem(LANG_STORAGE_KEY)
      .then((v) => {
        // 已选语言 → 用之；无记录（首启即崩，I18nProvider 还没落盘）→ 按系统语言检测
        if (v === 'en' || v === 'zh') setLang(v);
        else setLang(detectLang());
      })
      .catch(() => setLang(detectLang())); // 存储异常也按系统语言兜底
  }, [error]);

  const t = (key: DictKey) => DICT[lang][key];

  return (
    <View style={styles.root}>
      <Text variant="headlineSmall" style={styles.title}>
        {t('err.title')}
      </Text>
      <Text variant="bodyMedium" style={styles.hint}>
        {t('err.hint')}
      </Text>
      <ScrollView style={styles.detailBox}>
        <Text selectable style={styles.detail}>
          {error?.message ?? String(error)}
        </Text>
      </ScrollView>
      {/* 边界渲染在 PaperProvider 之外拿不到 MD3 主题（默认紫与品牌不符），颜色全部显式声明 */}
      <Button
        mode="contained"
        contentStyle={{ backgroundColor: palette.volt }}
        textColor={palette.bg}
        onPress={() => retry()}>
        {t('common.retry')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
    paddingHorizontal: 24,
    paddingTop: 96,
    paddingBottom: 48,
    gap: 16,
  },
  title: {
    color: palette.volt,
    fontWeight: '700',
  },
  hint: {
    color: palette.muted,
    lineHeight: 22,
  },
  detailBox: {
    flex: 1,
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  detail: {
    color: palette.muted,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
});

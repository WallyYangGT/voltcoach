/**
 * 根布局：i18n Provider → Paper 主题 → ShareIntentProvider（分享面板接收）→ 根 Stack
 * M1：训练详情（activity/[id]）与 FIT 导入（import 全屏模态）；
 * 分享面板的 ACTION_SEND 文件流由 expo-share-intent 捕获（RN Linking 只覆盖
 * VIEW/data URI，拿不到 EXTRA_STREAM），入队 shareQueue 后跳导入页消费。
 */
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppState, type AppStateStatus } from 'react-native';
import { useEffect, useRef } from 'react';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { I18nProvider } from '@/i18n';
import { queueShareFile } from '@/services/shareQueue';
import { maybeAutoSync } from '@/services/syncOnelap';
import { md3Dark, palette } from '@/theme';

export default function RootLayout() {
  return (
    <I18nProvider>
      <PaperProvider theme={md3Dark}>
        <SafeAreaProvider>
          <ShareIntentProvider>
            <StatusBar style="light" />
            <ShareIntentDispatcher />
            <AutoSyncDispatcher />
            <RootStack />
          </ShareIntentProvider>
        </SafeAreaProvider>
      </PaperProvider>
    </I18nProvider>
  );
}

/** 前台自动同步（§10.4）：App 回前台触发 maybeAutoSync（未配置/节流不满足时内部静默跳过） */
function AutoSyncDispatcher() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') void maybeAutoSync();
    });
    return () => sub.remove();
  }, []);
  return null;
}

/** 监听分享面板送来的文件（.fit），入队并跳导入页；非 fit 文件忽略 */
function ShareIntentDispatcher() {
  const { shareIntent, hasShareIntent } = useShareIntentContext();
  const router = useRouter();
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hasShareIntent) return;
    const file = shareIntent.files?.[0];
    if (!file?.path) return;
    const key = `${file.path}:${file.fileName}`;
    if (handledRef.current === key) return; // Provider 可能重发同一 intent
    const name = file.fileName || file.path.split('/').pop() || 'shared.fit';
    if (!name.toLowerCase().endsWith('.fit')) return; // 只消费 .fit（filter 是 */*）
    handledRef.current = key;
    const uri = file.path.startsWith('file://') ? file.path : `file://${file.path}`;
    queueShareFile(uri, name);
    router.push('/import');
  }, [hasShareIntent, shareIntent, router]);

  return null;
}

function RootStack() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.bg },
      }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="activity/[id]"
        options={{ animation: 'slide_from_right' }}
      />
      {/* M3：AI 会话详情（报告正文+追问 / 直接对话）与记忆管理页 */}
      <Stack.Screen
        name="ai/session/[id]"
        options={{ animation: 'slide_from_right' }}
      />
      <Stack.Screen
        name="memory"
        options={{ animation: 'slide_from_right' }}
      />
      <Stack.Screen name="import" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  );
}

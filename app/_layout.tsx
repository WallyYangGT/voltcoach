/**
 * 根布局：GestureHandlerRootView → i18n Provider → Paper 主题 → ShareIntentProvider
 * （分享面板接收）→ 根 Stack
 * M1：训练详情（activity/[id]）与 FIT 导入（import 全屏模态）；
 * 分享面板的 ACTION_SEND 文件流由 expo-share-intent 捕获（RN Linking 只覆盖
 * VIEW/data URI，拿不到 EXTRA_STREAM），入队 shareQueue 后跳导入页消费。
 * M5：最外层包 GestureHandlerRootView——训练列表的左滑删除（ReanimatedSwipeable）
 * 依赖它，缺了手势会静默失效（库只打一行警告，不报错）。
 */
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppState, type AppStateStatus } from 'react-native';
import { useEffect, useRef } from 'react';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { I18nProvider } from '@/i18n';
import { queueShareFile } from '@/services/shareQueue';
import { resumeInterruptedGenerations } from '@/services/aiGenerate';
import { maybeAutoSync } from '@/services/syncOnelap';
import { md3Dark, palette } from '@/theme';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <I18nProvider>
        <PaperProvider theme={md3Dark}>
          <SafeAreaProvider>
            {/* edge-to-edge 下系统 adjustResize 不再缩放窗口（键盘直接盖住内容），
                键盘 insets 统一交给 react-native-keyboard-controller 接管（M5） */}
            <KeyboardProvider>
              <ShareIntentProvider>
                <StatusBar style="light" />
                <ShareIntentDispatcher />
                <AutoSyncDispatcher />
                <GenerationResumeDispatcher />
                <RootStack />
              </ShareIntentProvider>
            </KeyboardProvider>
          </SafeAreaProvider>
        </PaperProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}

/** 前台自动同步：App 回前台触发 maybeAutoSync（未配置/节流不满足时内部静默跳过） */
function AutoSyncDispatcher() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') void maybeAutoSync();
    });
    return () => sub.remove();
  }, []);
  return null;
}

/**
 * AI 生成自愈（M5）：生成中切后台进程被杀只留 pending 占位，此前唯一恢复路径是
 * 重进 AI 页面补跑。这里冷启动（延迟 3s，避开开库与首帧渲染）+ 每次 background→active
 * 各扫一次，窗口内的残留自动续跑；未配密钥/已在跑/超窗时编排层内部跳过（见
 * resumeInterruptedGenerations），重复调度无副作用。
 */
function GenerationResumeDispatcher() {
  useEffect(() => {
    const run = () =>
      void resumeInterruptedGenerations().catch((e) =>
        console.warn('AI 残留续跑调度失败:', e),
      );
    const timer = setTimeout(run, 3000);
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') run();
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
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
      {/* M4：数据管理页（备份导出导入 / 顽鹿同步 / 本地快照） */}
      <Stack.Screen
        name="data"
        options={{ animation: 'slide_from_right' }}
      />
      {/* 开源维护期：关于页（品牌/简介/仓库/联系/许可） */}
      <Stack.Screen
        name="about"
        options={{ animation: 'slide_from_right' }}
      />
      <Stack.Screen name="import" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  );
}

/**
 * expo-router 错误边界（M5）：任何路由段内未捕获的渲染异常兜底到品牌化恢复页，
 * 避免白屏/闪退。渲染在 Provider 树之外，语言读 AsyncStorage（见 ErrorScreen）。
 */
export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';

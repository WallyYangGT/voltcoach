/**
 * 根布局：i18n Provider → Paper 主题 → 根 Stack
 * M0 阶段只含 (tabs) 四 tab 组与 PoC 验证页；M1 起追加训练详情等模态页。
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { I18nProvider } from '@/i18n';
import { md3Dark, palette } from '@/theme';

export default function RootLayout() {
  return (
    <I18nProvider>
      <PaperProvider theme={md3Dark}>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: palette.bg },
            }}>
            <Stack.Screen name="(tabs)" />
          </Stack>
        </SafeAreaProvider>
      </PaperProvider>
    </I18nProvider>
  );
}

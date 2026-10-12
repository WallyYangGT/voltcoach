/**
 * render.tsx — 组件测试共用渲染 helper（L4，2026-10-13）。
 *
 * renderWithProviders：包 PaperProvider（MD3 组件库需主题上下文）与 I18nProvider
 * （组件取词走 useI18n；初值恒 zh——AsyncStorage 的官方 jest mock getItem 返回
 * null，Provider 走 detectLang()，而 expo-localization 已在 jest.setup 钉 zh）。
 * 用真实 Provider 而非 mock '@/i18n'：顺带把词典取词与 {var} 插值纳入集成面，
 * 断言直接写中文文案。注意 AsyncStorage mock 的存储在同文件用例间持久。
 *
 * RNTL v14 的 render 是 async；cleanup 走 RNTL 注入的全局 afterEach（依赖 jest
 * 隐式 globals——这也是 eslint 给本目录配 globals.jest 的原因）。
 */
import React from 'react';
import { render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { I18nProvider } from '@/i18n';

export async function renderWithProviders(ui: React.ReactElement): Promise<RenderResult> {
  return render(
    <I18nProvider>
      <PaperProvider>{ui}</PaperProvider>
    </I18nProvider>,
  );
}

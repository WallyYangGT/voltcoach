/**
 * render.tsx — 组件测试共用渲染 helper（L4，2026-10-13）。
 *
 * renderWithProviders：包 PaperProvider（MD3 组件库需主题上下文）与 I18nProvider
 * （组件取词走 useI18n；初值恒 zh——AsyncStorage 在 jest 环境的 getItem 会拒绝、
 * 被 Provider 的 .catch 吞掉，不改变初始语言）。用真实 Provider 而非 mock '@/i18n'：
 * 顺带把词典取词与 {var} 插值纳入集成面，断言直接写中文文案。
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

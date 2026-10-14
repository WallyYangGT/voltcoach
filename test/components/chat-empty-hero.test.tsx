/**
 * chat-empty-hero.test.tsx — L4 组件测试：对话页空态引导（AP2）。
 * 钉住：占位主文案与副行渲染（文案与首页输入卡片同族）。'@/db' 只 mock
 * i18n 顶层依赖的 setLang，口径同 chat-invite-card.test.tsx。
 */
import React from 'react';
import { ChatEmptyHero } from '@/components/ChatEmptyHero';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  setLang: jest.fn(),
}));

describe('ChatEmptyHero', () => {
  it('渲染引导主文案与副行', async () => {
    const screen = await renderWithProviders(<ChatEmptyHero />);
    expect(screen.getByText('和教练讨论一下…')).toBeTruthy();
    expect(screen.getByText('输入消息，AI 可查询训练库作答')).toBeTruthy();
  });
});

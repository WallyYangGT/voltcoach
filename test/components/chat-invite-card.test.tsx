/**
 * chat-invite-card.test.tsx — L4 组件测试：首页「和教练讨论一下」输入卡片（AP1）。
 *
 * 钉住：占位文案渲染、点击整卡触发 onPress。渲染门（未配置 Key 整卡隐藏）在首页
 * 侧不在本组件，此处不覆盖。'@/db' 只 mock i18n 顶层依赖的 setLang（防拉起
 * expo-sqlite），口径同 onelap-sync-card.test.tsx 的防御性补齐。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { ChatInviteCard } from '@/components/ChatInviteCard';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  setLang: jest.fn(),
}));

describe('ChatInviteCard', () => {
  it('渲染占位文案「和教练讨论一下…」', async () => {
    const screen = await renderWithProviders(<ChatInviteCard onPress={() => {}} />);
    expect(screen.getByText('和教练讨论一下…')).toBeTruthy();
  });

  it('点击整卡触发 onPress', async () => {
    const onPress = jest.fn();
    const screen = await renderWithProviders(<ChatInviteCard onPress={onPress} />);
    // fireEvent 一律包 act（裸 press 会毒化后续用例，见 onelap-sync-card.test.tsx 头注释）
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-invite-card'));
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

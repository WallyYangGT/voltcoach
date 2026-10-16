/**
 * wahoo-callback.test.tsx — L4 组件测试：Wahoo 授权回调落地页（app/wahoo-callback.tsx）。
 *
 * 钉住的中间层行为（评审 P1-1 的回归位）：授权回调是**深链**唤起 App，收尾必须在这里
 * 完成——而 `useURL` 的初值恒为 null（异步 getInitialURL 才填），早期实现因此首帧就
 * 「没有 URL → 直接回卡片」，收尾彻底失效。故两条断言：
 *  ① 有回调 URL 时：换令牌 + 存凭据 + 回「我的」页；
 *  ② URL 尚未到达时：**不得**提前放弃（不调 completeWahooAuth），超时兜底回卡片。
 * 失败路径（换码被拒）只弹一次提示并回卡片，不把用户卡在过渡页。
 */
import React from 'react';
import { Alert } from 'react-native';
import { act } from '@testing-library/react-native';
import WahooCallbackScreen from '../../app/wahoo-callback';
import { providerById } from '@/services/syncProviders';
import { completeWahooAuth, useWahooCallbackUrl } from '@/services/wahooAuth';
import { renderWithProviders } from './helpers/render';

// jest.mock 的工厂只能引用 mock* 前缀的外部变量
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => mockReplace(...args) }),
}));

jest.mock('@/services/wahooAuth', () => ({
  useWahooCallbackUrl: jest.fn(),
  completeWahooAuth: jest.fn(),
}));

jest.mock('@/services/syncProviders', () => ({
  providerById: jest.fn(),
}));

const saveCredentials = jest.fn(async () => {});
const CREDS = {
  kind: 'oauth',
  clientId: 'cid',
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: 1,
  codeVerifier: 'v'.repeat(43),
  redirectUri: 'voltcoach:///wahoo-callback',
};

beforeEach(() => {
  jest.clearAllMocks();
  (providerById as jest.Mock).mockReturnValue({ saveCredentials });
  (completeWahooAuth as jest.Mock).mockResolvedValue(CREDS);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
  jest.useRealTimers();
});

describe('WahooCallbackScreen', () => {
  it('有回调 URL：换令牌 → 存凭据 → 回「我的」页', async () => {
    const url = 'voltcoach:///wahoo-callback?code=the-code&state=st';
    (useWahooCallbackUrl as jest.Mock).mockReturnValue(url);
    await act(async () => {
      await renderWithProviders(<WahooCallbackScreen />);
    });
    expect(completeWahooAuth).toHaveBeenCalledWith(url);
    expect(providerById).toHaveBeenCalledWith('wahoo');
    expect(saveCredentials).toHaveBeenCalledWith(CREDS);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/me');
  });

  it('URL 还没到（useURL 初值 null 的形态）：不提前放弃，超时兜底才回卡片', async () => {
    jest.useFakeTimers();
    (useWahooCallbackUrl as jest.Mock).mockReturnValue(null);
    await act(async () => {
      await renderWithProviders(<WahooCallbackScreen />);
    });
    // 关键断言：url 未到时不得调 completeWahooAuth（旧实现首帧即放弃 → 收尾失效）
    expect(completeWahooAuth).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(2100);
    });
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/me');
  });

  it('换码被拒：提示一次并回卡片（不把用户卡在过渡页）', async () => {
    (useWahooCallbackUrl as jest.Mock).mockReturnValue('voltcoach:///wahoo-callback?code=bad&state=st');
    (completeWahooAuth as jest.Mock).mockRejectedValue(new Error('PKCE 校验失败'));
    await act(async () => {
      await renderWithProviders(<WahooCallbackScreen />);
    });
    expect(Alert.alert).toHaveBeenCalledWith('Wahoo 授权未完成', 'PKCE 校验失败');
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/me');
  });

  it('没有进行中的授权（completeWahooAuth 返回 null）：静默回卡片，不弹提示', async () => {
    (useWahooCallbackUrl as jest.Mock).mockReturnValue('voltcoach:///wahoo-callback?code=x&state=st');
    (completeWahooAuth as jest.Mock).mockResolvedValue(null);
    await act(async () => {
      await renderWithProviders(<WahooCallbackScreen />);
    });
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/me');
  });
});

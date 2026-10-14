/**
 * reset-follow-up-button.test.tsx — L4 组件测试：重设追问按钮（AP4）。
 *
 * 钉住：点击弹确认框（标题 + 正文按 scope 区分 + 取消/删除双按钮）、取消分支
 * 不执行、确认分支执行 onReset、disabled 不弹窗。Alert 用 jest.spyOn 收集
 * （口径同 onelap-sync-card.test.tsx）。'@/db' 只 mock i18n 顶层依赖的 setLang。
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent } from '@testing-library/react-native';
import { ResetFollowUpButton } from '@/components/ResetFollowUpButton';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  setLang: jest.fn(),
}));

type AlertButton = { text: string; style?: string; onPress?: () => void };
const buttonsOf = (callIdx = 0) =>
  (Alert.alert as jest.Mock).mock.calls[callIdx][2] as AlertButton[];

describe('ResetFollowUpButton', () => {
  beforeEach(() => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => {
    (Alert.alert as jest.Mock).mockRestore();
  });

  it('followup scope：确认框标题「重设追问」+ 报告追问正文 + 双按钮', async () => {
    const screen = await renderWithProviders(
      <ResetFollowUpButton scope="followup" disabled={false} onReset={() => {}} />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('重设追问'));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '重设追问',
      '将删除该报告下的全部追问消息，不可恢复。',
      expect.any(Array),
    );
    expect(buttonsOf()).toHaveLength(2);
  });

  it('plan scope：正文换计划会话口径', async () => {
    const screen = await renderWithProviders(
      <ResetFollowUpButton scope="plan" disabled={false} onReset={() => {}} />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('重设追问'));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '重设追问',
      '将删除计划会话的全部消息，不可恢复。',
      expect.any(Array),
    );
  });

  it('取消分支不执行 onReset', async () => {
    const onReset = jest.fn();
    const screen = await renderWithProviders(
      <ResetFollowUpButton scope="followup" disabled={false} onReset={onReset} />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('重设追问'));
    });
    await act(async () => {
      buttonsOf()[0].onPress?.();
    });
    expect(onReset).not.toHaveBeenCalled();
  });

  it('确认分支（destructive）执行 onReset', async () => {
    const onReset = jest.fn();
    const screen = await renderWithProviders(
      <ResetFollowUpButton scope="followup" disabled={false} onReset={onReset} />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('重设追问'));
    });
    await act(async () => {
      buttonsOf()[1].onPress?.();
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('disabled 时不弹确认框', async () => {
    const onReset = jest.fn();
    const screen = await renderWithProviders(
      <ResetFollowUpButton scope="followup" disabled onReset={onReset} />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('重设追问'));
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});

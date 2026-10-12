/**
 * ask-input.test.tsx — L4 组件测试：追问输入行（AskInput）。
 *
 * 钉住的中间层行为（原靠 L3 轻量冒烟）：草稿自持、提交 trim + 清空、
 * sending 中按钮禁用且 submit 守卫不触发 onSend。
 * Paper 的 Button 文案「发送」（dict: session.send）来自真实 I18nProvider。
 * 文本输入用 userEvent.type、断言「按压后 UI 更新」时把 fireEvent.press 包进
 * act——RNTL v14 的裸 fireEvent 只触发回调、不提交受控重渲染（实测）；且事后
 * 补 `act(async () => {})` 会毒化后续用例的渲染树，必须把事件包进 act。
 */
import React from 'react';
import { act, fireEvent, userEvent } from '@testing-library/react-native';
import { AskInput } from '@/components/AskInput';
import { renderWithProviders } from './helpers/render';

describe('AskInput', () => {
  it('空草稿时发送按钮禁用', async () => {
    const onSend = jest.fn();
    const { getByText } = await renderWithProviders(
      <AskInput placeholder="问点什么" sending={false} onSend={onSend} />,
    );
    expect(getByText('发送')).toBeDisabled();
  });

  it('提交时 trim 首尾空白并清空输入框', async () => {
    const onSend = jest.fn();
    const { getByPlaceholderText, getByText, queryByDisplayValue } =
      await renderWithProviders(<AskInput placeholder="问点什么" sending={false} onSend={onSend} />);
    await userEvent.type(getByPlaceholderText('问点什么'), '这次骑行 NP 为什么偏高？');
    expect(getByText('发送')).toBeEnabled();
    await act(async () => {
      fireEvent.press(getByText('发送'));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('这次骑行 NP 为什么偏高？');
    // 草稿已清空：提交后输入框回到空值
    expect(queryByDisplayValue('这次骑行 NP 为什么偏高？')).toBeNull();
  });

  it('sending 中按钮禁用，submit 守卫也不触发 onSend', async () => {
    const onSend = jest.fn();
    const { getByPlaceholderText, getByText } = await renderWithProviders(
      <AskInput placeholder="问点什么" sending onSend={onSend} />,
    );
    await userEvent.type(getByPlaceholderText('问点什么'), '有条追问');
    expect(getByText('发送')).toBeDisabled();
    fireEvent.press(getByText('发送'));
    expect(onSend).not.toHaveBeenCalled();
  });
});

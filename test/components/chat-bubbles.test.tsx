/**
 * chat-bubbles.test.tsx — L4 组件测试：追问/对话气泡流（ChatBubbles）。
 *
 * 钉住的中间层行为（M5 修复项回归）：重试按消息逐条生效（点第 N 条回调第 N 条
 * 的 messageId）、该消息有进程内任务在跑时重试按钮禁用并换「重试中…」、
 * pending 态生成中提示与重试进度、completed 态按角色渲染。
 * 进程内注册表（isChatGenerating/getChatProgress）来自 '@/services/aiGenerate'，
 * 设备侧模块——整体 mock 后按 (chatId, messageId) 定向返回。
 */
import React from 'react';
import { fireEvent } from '@testing-library/react-native';
import { ChatBubbles } from '@/components/ChatBubbles';
import type { AiChatMessageRow } from '@/db';
import { isChatGenerating, getChatProgress } from '@/services/aiGenerate';
import { renderWithProviders } from './helpers/render';

// 进程内注册表（isChatGenerating/getChatProgress）来自设备侧模块，整体 mock；
// babel-plugin-jest-hoist 会把 jest.mock 提到所有 import 之前，此处顺序合规
jest.mock('@/services/aiGenerate', () => ({
  isChatGenerating: jest.fn(() => false),
  getChatProgress: jest.fn(() => null),
}));

const CHAT_ID = 5;

function msg(partial: Partial<AiChatMessageRow>): AiChatMessageRow {
  return {
    id: 1,
    chat_id: CHAT_ID,
    role: 'user',
    content: '',
    status: 'completed',
    error: null,
    created_at: '2026-10-13 00:00:00',
    ...partial,
  };
}

beforeEach(() => {
  (isChatGenerating as jest.Mock).mockReset().mockReturnValue(false);
  (getChatProgress as jest.Mock).mockReset().mockReturnValue(null);
});

describe('ChatBubbles', () => {
  it('completed 消息按角色渲染：user 纯文本、assistant Markdown', async () => {
    const { getByText } = await renderWithProviders(
      <ChatBubbles
        chatId={CHAT_ID}
        messages={[
          msg({ id: 1, role: 'user', content: '这周练得怎么样？' }),
          msg({ id: 2, role: 'assistant', content: '**疲劳管理**做得不错。', status: 'completed' }),
        ]}
        onRetry={() => {}}
      />,
    );
    expect(getByText('这周练得怎么样？')).toBeTruthy();
    expect(getByText('疲劳管理')).toBeTruthy();
  });

  it('pending 消息显示生成中与重试进度', async () => {
    (getChatProgress as jest.Mock).mockReturnValue({ attempt: 2, note: 'SSE 断连' });
    const { getByText } = await renderWithProviders(
      <ChatBubbles
        chatId={CHAT_ID}
        messages={[msg({ id: 3, role: 'assistant', status: 'pending' })]}
        onRetry={() => {}}
      />,
    );
    expect(getByText('生成中…')).toBeTruthy();
    expect(getByText('响应被中断，正在自动重试（第 2 次尝试） · SSE 断连')).toBeTruthy();
  });

  it('failed 消息重试逐条生效：点第几条回调第几条的 messageId（M5 回归）', async () => {
    const onRetry = jest.fn();
    const { getAllByText } = await renderWithProviders(
      <ChatBubbles
        chatId={CHAT_ID}
        messages={[
          msg({ id: 7, role: 'assistant', status: 'failed', error: '超时' }),
          msg({ id: 8, role: 'assistant', status: 'failed', error: '空响应' }),
        ]}
        onRetry={onRetry}
      />,
    );
    const retryButtons = getAllByText('重试');
    expect(retryButtons).toHaveLength(2);
    fireEvent.press(retryButtons[1]); // 点第二条失败气泡
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(8);
  });

  it('failed 消息在跑时重试禁用并换「重试中…」（M5 回归）', async () => {
    (isChatGenerating as jest.Mock).mockImplementation((_chatId: number, mid: number) => mid === 7);
    const onRetry = jest.fn();
    const { getAllByText } = await renderWithProviders(
      <ChatBubbles
        chatId={CHAT_ID}
        messages={[
          msg({ id: 7, role: 'assistant', status: 'failed', error: '超时' }),
          msg({ id: 8, role: 'assistant', status: 'failed', error: '空响应' }),
        ]}
        onRetry={onRetry}
      />,
    );
    const buttons = getAllByText(/^(重试|重试中…)$/);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeDisabled(); // id 7 在跑
    expect(buttons[1]).toBeEnabled();
    fireEvent.press(buttons[0]);
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.press(buttons[1]);
    expect(onRetry).toHaveBeenCalledWith(8);
  });
});

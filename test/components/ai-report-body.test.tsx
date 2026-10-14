/**
 * ai-report-body.test.tsx — L4 组件测试：报告三态正文（AiReportBody）。
 *
 * 钉住的中间层行为：pending 态已等待时长（m:ss）与传输级重试进度、failed 态
 * 重试按钮随 generating 禁用/换文案（M5 修复的「实际在重试还能点」回归）、
 * completed 态渲染 Markdown、report 为 null 不渲染。
 */
import React from 'react';
import { Alert } from 'react-native';
import { fireEvent } from '@testing-library/react-native';
import { AiReportBody } from '@/components/AiReportBody';
import type { AiReportRow } from '@/db';
import type { GenProgress } from '@/services/aiGenerate';
import { renderWithProviders } from './helpers/render';

// 取消确认框（Alert.alert）mock：断言弹窗文案并手动触发破坏性按钮的 onPress
jest.spyOn(Alert, 'alert').mockImplementation(() => {});

beforeEach(() => {
  (Alert.alert as jest.Mock).mockClear();
});

function reportOf(partial: Partial<AiReportRow>): AiReportRow {
  return {
    id: 1,
    mode: 'review',
    file_name: '2026-10-10 ride.fit',
    race_date: null,
    compare_with: null,
    status: 'completed',
    error: null,
    created_at: '2026-10-13 00:00:00',
    prompt: '',
    markdown: '',
    ...partial,
  };
}

describe('AiReportBody', () => {
  it('report 为 null 时不渲染任何态', async () => {
    const { queryByText } = await renderWithProviders(
      <AiReportBody report={null} progress={null} elapsedSec={null} generating={false} onRetry={() => {}} />,
    );
    expect(queryByText('报告生成中，完成后会自动显示（长报告可能需要几分钟）。可切到后台或锁屏，生成会继续，回来自动显示。')).toBeNull();
  });

  it('pending 态：显示已等待时长（m:ss）与自动重试进度', async () => {
    const progress: GenProgress = { attempt: 2, note: '连接被网关掐断' };
    const { getByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'pending' })}
        progress={progress}
        elapsedSec={65}
        generating
        onRetry={() => {}}
      />,
    );
    expect(getByText('已等待 1:05')).toBeTruthy();
    expect(getByText('响应被中断，正在自动重试（第 2 次尝试） · 连接被网关掐断')).toBeTruthy();
  });

  it('failed 态：generating=false 时重试可点并回调 onRetry', async () => {
    const onRetry = jest.fn();
    const { getByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'failed', error: 'JSON 解析失败' })}
        progress={null}
        elapsedSec={null}
        generating={false}
        onRetry={onRetry}
      />,
    );
    expect(getByText('生成失败')).toBeTruthy();
    expect(getByText('JSON 解析失败')).toBeTruthy();
    const btn = getByText('重试');
    expect(btn).toBeEnabled();
    fireEvent.press(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('failed 态：generating=true 时重试禁用且文案换为「重试中…」（M5 回归）', async () => {
    const onRetry = jest.fn();
    const { getByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'failed', error: null })}
        progress={{ attempt: 3, note: '空响应' }}
        elapsedSec={null}
        generating
        onRetry={onRetry}
      />,
    );
    expect(getByText('重试中…')).toBeDisabled();
    expect(getByText('响应被中断，正在自动重试（第 3 次尝试） · 空响应')).toBeTruthy();
    fireEvent.press(getByText('重试中…'));
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('completed 态：渲染 Markdown 正文', async () => {
    const { getByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'completed', markdown: '# 本周复盘\n\n训练负荷结构合理。' })}
        progress={null}
        elapsedSec={null}
        generating={false}
        onRetry={() => {}}
      />,
    );
    expect(getByText('训练负荷结构合理。')).toBeTruthy();
  });

  // ---------------- 2026-10：增量落库实时预览 + 取消 + cancelled 态 ----------------

  it('pending 态：显示工具调用动态行与已生成部分正文（增量落库预览）', async () => {
    const progress: GenProgress = { attempt: 0, note: '', activity: '✓ get_activity_summary · 2048 字符' };
    const { getByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'pending', markdown: '已生成的开头部分。' })}
        progress={progress}
        elapsedSec={12}
        generating
        onRetry={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getByText('✓ get_activity_summary · 2048 字符')).toBeTruthy();
    expect(getByText('已生成的开头部分。')).toBeTruthy();
  });

  it('pending 态：onCancel 缺省时不显示取消按钮', async () => {
    const { queryByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'pending' })}
        progress={null}
        elapsedSec={null}
        generating
        onRetry={() => {}}
      />,
    );
    expect(queryByText('取消生成')).toBeNull();
  });

  it('pending 态：取消按钮先弹二次确认，确认后才回调 onCancel（token 防误触）', async () => {
    const onCancel = jest.fn();
    const { getByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'pending' })}
        progress={null}
        elapsedSec={null}
        generating
        onRetry={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.press(getByText('取消生成'));
    expect(onCancel).not.toHaveBeenCalled(); // 确认框阶段不触发
    expect(Alert.alert).toHaveBeenCalledWith(
      '取消本次生成？',
      '将停止生成，已生成的部分会保留，可稍后重试；已消耗的 token 不退还。',
      expect.any(Array),
    );
    // 模拟用户点确认框的破坏性按钮（第三枚：destructive）
    const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)[2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === '取消生成')?.onPress?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancelled 态：已取消横幅 + 部分正文保留 + 重试回调 onRetry（原行重跑）', async () => {
    const onRetry = jest.fn();
    const { getByText } = await renderWithProviders(
      <AiReportBody
        report={reportOf({ status: 'cancelled', markdown: '# 已生成的部分\n\n前半段分析。' })}
        progress={null}
        elapsedSec={null}
        generating={false}
        onRetry={onRetry}
      />,
    );
    expect(getByText('已取消')).toBeTruthy();
    expect(getByText('生成已取消，以下为已生成的部分：')).toBeTruthy();
    expect(getByText('前半段分析。')).toBeTruthy();
    fireEvent.press(getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

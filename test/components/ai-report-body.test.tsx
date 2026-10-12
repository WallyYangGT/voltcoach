/**
 * ai-report-body.test.tsx — L4 组件测试：报告三态正文（AiReportBody）。
 *
 * 钉住的中间层行为：pending 态已等待时长（m:ss）与传输级重试进度、failed 态
 * 重试按钮随 generating 禁用/换文案（M5 修复的「实际在重试还能点」回归）、
 * completed 态渲染 Markdown、report 为 null 不渲染。
 */
import React from 'react';
import { fireEvent } from '@testing-library/react-native';
import { AiReportBody } from '@/components/AiReportBody';
import type { AiReportRow } from '@/db';
import type { GenProgress } from '@/services/aiGenerate';
import { renderWithProviders } from './helpers/render';

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
});

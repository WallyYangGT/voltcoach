/**
 * plan-report-section.test.tsx — L4 组件测试：计划页「规划解读」只读块（AP3）。
 *
 * 钉住：completed 渲染正文与「查看生成报告」链接、pending/failed 降级行、
 * report 为 null 整段隐藏（trimAiReports 清出/未生成的降级口径）、链接点击
 * 回调触发。AiMarkdown 以最简正文段落断言。'@/db' 只 mock i18n 顶层依赖的
 * setLang，口径同 chat-invite-card.test.tsx。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { PlanReportSection } from '@/components/PlanReportSection';
import type { AiReportRow } from '@/db';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  setLang: jest.fn(),
}));

function rowOf(partial: Partial<AiReportRow>): AiReportRow {
  return {
    id: 7,
    mode: 'plan',
    file_name: null,
    race_date: null,
    compare_with: null,
    status: 'completed',
    error: null,
    created_at: '2026-10-14 08:00:00',
    prompt: '',
    markdown: '',
    ...partial,
  };
}

describe('PlanReportSection', () => {
  it('report 为 null 时整段不渲染（未生成/被滚动清出的降级口径）', async () => {
    const screen = await renderWithProviders(
      <PlanReportSection report={null} onViewReport={() => {}} />,
    );
    expect(screen.queryByText('规划解读')).toBeNull();
  });

  it('completed：渲染正文与「查看生成报告」链接', async () => {
    const screen = await renderWithProviders(
      <PlanReportSection
        report={rowOf({ status: 'completed', markdown: '计划解读正文第一段' })}
        onViewReport={() => {}}
      />,
    );
    expect(screen.getByText('规划解读')).toBeTruthy();
    expect(screen.getByText('计划解读正文第一段')).toBeTruthy();
    expect(screen.getByText('查看生成报告')).toBeTruthy();
  });

  it('pending：显示「生成中…」降级行，链接仍可跳报告页看进度', async () => {
    const screen = await renderWithProviders(
      <PlanReportSection report={rowOf({ status: 'pending' })} onViewReport={() => {}} />,
    );
    expect(screen.getByText('生成中…')).toBeTruthy();
    expect(screen.getByText('查看生成报告')).toBeTruthy();
  });

  it('failed：显示「生成失败」降级行', async () => {
    const screen = await renderWithProviders(
      <PlanReportSection report={rowOf({ status: 'failed', error: 'boom' })} onViewReport={() => {}} />,
    );
    expect(screen.getByText('生成失败')).toBeTruthy();
  });

  it('链接点击触发 onViewReport', async () => {
    const onViewReport = jest.fn();
    const screen = await renderWithProviders(
      <PlanReportSection report={rowOf({})} onViewReport={onViewReport} />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('查看生成报告'));
    });
    expect(onViewReport).toHaveBeenCalledTimes(1);
  });
});

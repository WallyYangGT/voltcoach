/**
 * plan-link-chip.test.tsx — L4 组件测试：报告↔计划关联 chip（PlanLinkChip，U1 收尾③）。
 *
 * 钉住的中间层行为：有关联且版本在历史内 → 「关联计划 · 第 N 版」可跳计划页并带
 * version 参数；关联版本已被裁出历史 → 「已归档」不可跳；无关联（存量报告）整段
 * 隐藏。
 *
 * mock 边界：'@/db'（getPlanReportLink/getCurrentPlan/getPlanHistory）设备侧模块
 * 整体替换；locatePlanVersion 纯函数不 mock（真实定位）。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { PlanLinkChip } from '@/components/PlanLinkChip';
import { getCurrentPlan, getPlanHistory, getPlanReportLink } from '@/db';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getPlanReportLink: jest.fn(),
  getCurrentPlan: jest.fn(),
  getPlanHistory: jest.fn(),
  setLang: jest.fn(), // 真实 '@/i18n' 顶层从 '@/db' 取 setLang——防御性补齐
}));

jest.mock('expo-router', () => {
  const React = require('react'); // eslint-disable-line @typescript-eslint/no-require-imports
  const push = jest.fn();
  return {
    useRouter: () => ({ push, back: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (cb: () => void) => React.useEffect(() => { void cb(); }, [cb]),
    __mockPush: push,
  };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __mockPush: routerPush } = require('expo-router');

const ANCHOR = '2026-10-14T08:00:00.000Z';
const current = {
  created_at: '2026-10-15T08:00:00.000Z',
  plan: { valid_from: '2026-10-15', valid_to: '2026-10-28', goal: '', sessions: [] },
};
const historical = {
  created_at: ANCHOR,
  plan: { valid_from: '2026-10-01', valid_to: '2026-10-14', goal: '', sessions: [] },
};

beforeEach(() => {
  (getPlanReportLink as jest.Mock).mockReset().mockResolvedValue(null);
  (getCurrentPlan as jest.Mock).mockReset().mockResolvedValue(current);
  (getPlanHistory as jest.Mock).mockReset().mockResolvedValue([historical]);
  routerPush.mockClear();
});

async function mountChip(reportId = 7) {
  const screen = await renderWithProviders(<PlanLinkChip reportId={reportId} />);
  await act(async () => {});
  return screen;
}

describe('PlanLinkChip', () => {
  it('无关联（存量报告）整段隐藏', async () => {
    const screen = await mountChip();
    expect(screen.queryByText(/关联计划/)).toBeNull();
  });

  it('关联版本在历史内：第 N 版文案 + 深链计划页带 version 参数', async () => {
    (getPlanReportLink as jest.Mock).mockResolvedValue(ANCHOR);
    const screen = await mountChip();
    expect(screen.getByText('关联计划 · 第 1 版（2026-10-01 ~ 2026-10-14）')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText(/关联计划/));
    });
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/plan',
      params: { version: '1' },
    });
  });

  it('关联的是当前版：版本号 = history.length + 1', async () => {
    (getPlanReportLink as jest.Mock).mockResolvedValue(current.created_at);
    const screen = await mountChip();
    expect(screen.getByText(/第 2 版（2026-10-15 ~ 2026-10-28）/)).toBeTruthy(); // 1 历史 + 1
  });

  it('版本已裁出历史：「已归档」不可跳', async () => {
    (getPlanReportLink as jest.Mock).mockResolvedValue('2026-01-01T00:00:00.000Z');
    const screen = await mountChip();
    expect(screen.getByText('关联计划版本已归档')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('关联计划版本已归档'));
    });
    expect(routerPush).not.toHaveBeenCalled();
  });
});

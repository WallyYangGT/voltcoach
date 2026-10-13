/**
 * weekly-plan-card.test.tsx — L4 组件测试：首页「本周训练计划」卡（WeeklyPlanCard）。
 *
 * 钉住的中间层行为（roadmap 口径）：未配置 LLM Key 整卡隐藏（不出占位）、
 * 有效期内计划显示本周摘要与「今天」行、无计划级联文案（从未生成 vs 上次未产出
 * 有效计划）、CTA 走 report 生成链路（createReportDraft + 跳报告页 + fire 生成）。
 *
 * mock 边界：'@/db' 与 '@/services/aiGenerate' 设备侧模块整体替换；expo-router 的
 * useRouter.push 用模块内导出的 mock 断言（factory 内创建，避免提升时序问题）。
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent } from '@testing-library/react-native';
import { WeeklyPlanCard } from '@/components/WeeklyPlanCard';
import { createReportDraft, generateReport } from '@/services/aiGenerate';
import { getAiConfig, getCurrentPlan, listAiReports, type StoredPlan } from '@/db';
import { localDay } from '@/core/local-day';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getAiConfig: jest.fn(),
  getCurrentPlan: jest.fn(),
  listAiReports: jest.fn(),
  // 真实 '@/i18n' 顶层从 '@/db' 取 setLang（语言切换时用）——防御性补齐防图谱缺键
  setLang: jest.fn(),
}));

jest.mock('@/services/aiGenerate', () => ({
  createReportDraft: jest.fn(),
  generateReport: jest.fn(),
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

/** 相对今天偏移 n 天的本地日历日（计划窗夹住今天，有效性判定确定化） */
const day = (offset: number) =>
  new Date(Date.parse(localDay() + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

const planFixture = (): StoredPlan => ({
  plan: {
    valid_from: day(-1),
    valid_to: day(13),
    goal: '基础期：有氧量与踏频稳定性',
    sessions: [
      { date: day(0), type: 'threshold', duration_min: 75, intensity: '95–105% FTP', tss: 85, note: '3×12min 阈值' },
      { date: day(2), type: 'rest', duration_min: null, intensity: null, tss: 0, note: '休息日' },
    ],
  },
  created_at: '2026-10-13T08:00:00.000Z',
  origin: 'generate',
  source_report_id: 9,
  change_note: null,
  warnings: [],
});

async function mountCard() {
  const screen = await renderWithProviders(<WeeklyPlanCard />);
  await act(async () => {});
  return screen;
}

beforeEach(() => {
  (getAiConfig as jest.Mock).mockReset().mockResolvedValue({ config: {}, configured: true });
  (getCurrentPlan as jest.Mock).mockReset().mockResolvedValue(null);
  (listAiReports as jest.Mock).mockReset().mockResolvedValue([]);
  (createReportDraft as jest.Mock).mockReset().mockResolvedValue(42);
  (generateReport as jest.Mock).mockReset().mockResolvedValue({ started: true });
  routerPush.mockClear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
});

describe('WeeklyPlanCard', () => {
  it('未配置 LLM Key：整卡隐藏，不出占位与引导', async () => {
    (getAiConfig as jest.Mock).mockResolvedValue({ config: {}, configured: false });
    const screen = await mountCard();
    expect(screen.queryByTestId('weekly-plan-card')).toBeNull();
  });

  it('有效期内计划：本周摘要 + 今天行 + 查看课表入口', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard();
    expect(screen.getByText('本周训练计划')).toBeTruthy();
    expect(screen.getByText(/本周 \d 次课 · 计划 TSS 85/)).toBeTruthy();
    expect(screen.getByText(/今天：阈值 · .+ · TSS 85/)).toBeTruthy();
    expect(screen.getByText('查看课表')).toBeTruthy();
    expect(screen.queryByText('生成计划')).toBeNull();
  });

  it('计划未开始（upcoming）：显示开始日期与总课次，不显示「本周」摘要口径', async () => {
    const fixture = planFixture();
    fixture.plan = {
      ...fixture.plan,
      valid_from: day(3), // 三天后才开始
      valid_to: day(16),
      sessions: [{ date: day(3), type: 'threshold', duration_min: 75, intensity: null, tss: 85, note: null }],
    };
    (getCurrentPlan as jest.Mock).mockResolvedValue(fixture);
    const screen = await mountCard();
    expect(screen.getByText(`${day(3)} 开始 · 共 1 次课`)).toBeTruthy();
    expect(screen.queryByText(/本周 \d 次课/)).toBeNull();
  });

  it('无计划（从未生成）：引导语 + CTA 走 report 生成链路（draft→跳转→fire）', async () => {
    const screen = await mountCard();
    expect(screen.getByText('还没有训练计划，让 AI 教练按你的近期负荷生成一份')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('生成计划'));
    });
    expect(createReportDraft).toHaveBeenCalledWith('plan', {}, 'zh');
    expect(routerPush).toHaveBeenCalledWith('/ai/session/report-42');
    expect(generateReport).toHaveBeenCalledWith(42, 'zh');
  });

  it('无计划（上次未产出有效计划）：换「重新生成」级联文案', async () => {
    (listAiReports as jest.Mock).mockResolvedValue([
      { id: 7, mode: 'plan', status: 'completed', created_at: '2026-10-12 10:00:00' },
    ]);
    const screen = await mountCard();
    expect(screen.getByText('上次未产出有效计划，重新生成一份？')).toBeTruthy();
    expect(screen.queryByText('还没有训练计划，让 AI 教练按你的近期负荷生成一份')).toBeNull();
  });

  it('计划已过期：摘要置灰 + 生成 CTA', async () => {
    const fixture = planFixture();
    fixture.plan = {
      ...fixture.plan,
      valid_from: day(-21),
      valid_to: day(-8), // 已过期 8 天
      sessions: [{ date: day(-21), type: 'rest', duration_min: null, intensity: null, tss: 0, note: null }],
    };
    (getCurrentPlan as jest.Mock).mockResolvedValue(fixture);
    const screen = await mountCard();
    expect(screen.getByText('计划已过期')).toBeTruthy();
    expect(screen.getByText('生成计划')).toBeTruthy();
    expect(screen.queryByText('查看课表')).toBeNull();
  });
});

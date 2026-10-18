/**
 * plan-adjust-banner.test.tsx — L4 组件测试：计划「AI 调整披露条」（PlanAdjustBanner）。
 *
 * 钉住的中间层行为（U1 收尾④）：origin='adjust' 才显示（generate/无计划隐藏）、
 * 摘要含本地日与 change_note、撤销走 Alert 二次确认后调 undoLastPlanVersion 并
 * 自刷新、无历史版本时撤销不可达。
 *
 * mock 边界：'@/db' 设备侧模块整体替换；localDayFromUtc 真实跑（UTC 文本换算）。
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent } from '@testing-library/react-native';
import { PlanAdjustBanner } from '@/components/PlanAdjustBanner';
import {
  getAdjustNoticeSeen,
  getCurrentPlan,
  getPlanHistory,
  markAdjustNoticeSeen,
  undoLastPlanVersion,
  type StoredPlan,
} from '@/db';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getCurrentPlan: jest.fn(),
  getPlanHistory: jest.fn(),
  undoLastPlanVersion: jest.fn(),
  getAdjustNoticeSeen: jest.fn(),
  markAdjustNoticeSeen: jest.fn(),
  setLang: jest.fn(), // 真实 '@/i18n' 顶层从 '@/db' 取 setLang——防御性补齐
}));

jest.mock('expo-router', () => {
  const React = require('react'); // eslint-disable-line @typescript-eslint/no-require-imports
  return {
    // 组件自加载走 useFocusEffect——测试里退化为挂载即拉一次（weekly-plan-card 同款）；
    // 保留 cb 的 cleanup，已读锚 Hook 靠它防止旧身份异步结果回写
    useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]),
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  };
});

const plan = (): StoredPlan => ({
  plan: {
    valid_from: '2026-10-12',
    valid_to: '2026-10-25',
    goal: '基础期',
    sessions: [{ date: '2026-10-13', type: 'threshold', duration_min: 75, intensity: null, tss: 85, note: null }],
  },
  created_at: '2026-10-13T08:00:00.000Z',
  origin: 'adjust',
  source_report_id: null,
  change_note: '周一阈值课顺延至周二',
  warnings: [],
});

const generateOrigin = (): StoredPlan => ({ ...plan(), origin: 'generate', change_note: null });

/** undo 的 then → load → setData 是多级微任务链，act 的一轮排空不够——补真实宏任务等待 */
const flushAsync = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount() {
  const screen = await renderWithProviders(<PlanAdjustBanner />);
  // 两轮：计划数据（load）→ 已读锚（useAdjustNoticeVisible）→ 写锚 effect
  await flushAsync();
  await flushAsync();
  return screen;
}

beforeEach(() => {
  (getCurrentPlan as jest.Mock).mockReset().mockResolvedValue(null);
  (getPlanHistory as jest.Mock).mockReset().mockResolvedValue([]);
  (undoLastPlanVersion as jest.Mock).mockReset().mockResolvedValue(true);
  (getAdjustNoticeSeen as jest.Mock).mockReset().mockResolvedValue(null);
  (markAdjustNoticeSeen as jest.Mock).mockReset().mockResolvedValue(undefined);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
});

describe('PlanAdjustBanner', () => {
  it('origin=generate / 无计划：整条隐藏', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(generateOrigin());
    const screen = await mount();
    expect(screen.queryByTestId('plan-adjust-banner')).toBeNull();
  });

  it('adjust 版：摘要含本地日与 change_note + 撤销入口，并写已读锚', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(plan());
    (getPlanHistory as jest.Mock).mockResolvedValue([{ ...plan(), origin: 'generate' }]);
    const screen = await mount();
    expect(screen.getByText(/AI 教练已于 .* 调整计划：周一阈值课顺延至周二/)).toBeTruthy();
    expect(screen.getByText('撤销调整')).toBeTruthy();
    // 本次仍可见（撤销入口不被抽走），但已读锚已落库：下次聚焦即隐藏
    expect(markAdjustNoticeSeen).toHaveBeenCalledWith('plan_adjust', plan().created_at);
  });

  it('已读锚等于当前版本：再次进入不再显示（浏览过即消失）', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(plan());
    (getPlanHistory as jest.Mock).mockResolvedValue([{ ...plan(), origin: 'generate' }]);
    (getAdjustNoticeSeen as jest.Mock).mockResolvedValue(plan().created_at);
    const screen = await mount();
    expect(screen.queryByTestId('plan-adjust-banner')).toBeNull();
    expect(markAdjustNoticeSeen).not.toHaveBeenCalled();
  });

  it('旧已读锚 + 新调整版本：重新披露一次并覆盖为新锚', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(plan());
    (getPlanHistory as jest.Mock).mockResolvedValue([{ ...plan(), origin: 'generate' }]);
    (getAdjustNoticeSeen as jest.Mock).mockResolvedValue('2026-10-12T08:00:00.000Z');
    const screen = await mount();
    expect(screen.getByTestId('plan-adjust-banner')).toBeTruthy();
    expect(markAdjustNoticeSeen).toHaveBeenCalledWith('plan_adjust', plan().created_at);
  });

  it('无历史版本（异常态）：不显示撤销入口', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(plan());
    (getPlanHistory as jest.Mock).mockResolvedValue([]);
    const screen = await mount();
    expect(screen.getByTestId('plan-adjust-banner')).toBeTruthy();
    expect(screen.queryByText('撤销调整')).toBeNull();
  });

  it('props 模式（plan 页）：不自查请求，adjust 版直接显示；宿主刷新下传 generate 版即隐藏', async () => {
    const screen = await renderWithProviders(
      <PlanAdjustBanner stored={plan()} history={[generateOrigin()]} />,
    );
    await act(async () => {});
    expect(screen.getByTestId('plan-adjust-banner')).toBeTruthy();
    expect(screen.getByText(/周一阈值课顺延至周二/)).toBeTruthy();
    expect(getCurrentPlan).not.toHaveBeenCalled(); // props 模式不自查（冒烟实证本页内调整的即时反映）

    const regenerated = await renderWithProviders(
      <PlanAdjustBanner stored={generateOrigin()} history={[plan()]} />,
    );
    await act(async () => {});
    expect(regenerated.queryByTestId('plan-adjust-banner')).toBeNull();
  });

  // ⚠️ 撤销流必须放本文件最后：其 then → load → setData 的异步链即使整链收进单个
  // act（两级宏任务落定），React 的 act 栈仍可能带伤传染给后续用例（effect 永不
  // flush）——「撤销后条目隐藏」的渲染面由首例的 origin 守卫（generate → null）覆盖，
  // 这里只钉撤销调用链（Alert 确认 → undoLastPlanVersion 恰一次）
  it('撤销：Alert 确认后调用 undoLastPlanVersion（Alert 流程钉住）', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(plan());
    (getPlanHistory as jest.Mock).mockResolvedValue([{ ...plan(), origin: 'generate' }]);
    const screen = await mount();
    await act(async () => {
      fireEvent.press(screen.getByText('撤销调整'));
    });
    // 确认框阶段不触发（防误触），手动执行破坏性按钮（第三枚）后恰调一次撤销
    expect(undoLastPlanVersion).not.toHaveBeenCalled();
    const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)[2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((b) => b.text === '撤销调整')?.onPress?.();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(undoLastPlanVersion).toHaveBeenCalledTimes(1);
  });
});

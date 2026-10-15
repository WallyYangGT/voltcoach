/**
 * today-advice-card.test.tsx — L4 组件测试：首页「今日建议」卡（TodayAdviceCard，U1 收尾①）。
 *
 * 钉住的中间层行为：空库整卡隐藏（无 Key 不门控——本卡纯本地计算，db 挂了也只
 * 降级为空）、状态档结论行（能练/轻松练+降级提示/计划休息日/已练免扰）、双出口
 * （看今日课表 = generateWorkout 本地出表并展开渲染；和教练聊聊 = 深链 chat-new
 * 且 draft 预填上下文）、无计划引导出口跳 /plan。
 *
 * mock 边界：'@/db' 设备侧模块整体替换；generateWorkout 是纯函数不 mock（真实
 * 出表渲染）；expo-router 的 push 用模块内导出的 mock 断言（weekly-plan-card 先例）。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { TodayAdviceCard } from '@/components/TodayAdviceCard';
import { getCurrentPlan, type StoredPlan } from '@/db';
import { localDay } from '@/core/local-day';
import { FORM_SIMULATION } from '@/core/settings';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getCurrentPlan: jest.fn(),
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

const REC = FORM_SIMULATION.tsb_recovery;
const LOW = FORM_SIMULATION.tsb_low;

const day = (offset: number) =>
  new Date(Date.parse(localDay() + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

const planFixture = (): StoredPlan => ({
  plan: {
    valid_from: day(-1),
    valid_to: day(13),
    goal: '基础期',
    sessions: [
      { date: day(0), type: 'threshold', duration_min: 75, intensity: '95–105% FTP', tss: 85, note: '3×12min 阈值' },
    ],
  },
  created_at: '2026-10-13T08:00:00.000Z',
  origin: 'generate',
  source_report_id: 9,
  change_note: null,
  warnings: [],
});

const point = (tsb: number) => ({ date: localDay(), tss: 60, ctl: 50, atl: 50 + -tsb, tsb });
const athlete = { ftp_watts: 220, max_hr: 190, weight_kg: 70 };

async function mountCard(props = {}) {
  const screen = await renderWithProviders(
    <TodayAdviceCard last={point(0)} athlete={athlete} trainedToday={false} {...props} />,
  );
  await act(async () => {});
  return screen;
}

beforeEach(() => {
  (getCurrentPlan as jest.Mock).mockReset().mockResolvedValue(null);
  routerPush.mockClear();
});

describe('TodayAdviceCard', () => {
  it('空库（last=null）整卡隐藏；db 有无 Key 均不影响（纯本地不被 Key 门控）', async () => {
    const screen = await renderWithProviders(
      <TodayAdviceCard last={null} athlete={athlete} trainedToday={false} />,
    );
    await act(async () => {});
    expect(screen.queryByTestId('today-advice-card')).toBeNull();
  });

  it('能练档 + 计划质量课：按计划结论 + 双出口', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ last: point(5) });
    expect(screen.getByText('今日建议')).toBeTruthy();
    expect(screen.getByText('能练')).toBeTruthy();
    expect(screen.getByText('按计划进行：阈值')).toBeTruthy();
    expect(screen.getByText(/TSB \+5 · 计划 阈值/)).toBeTruthy();
    expect(screen.getByText('看今日课表')).toBeTruthy();
    expect(screen.getByText('和教练聊聊')).toBeTruthy();
    expect(screen.queryByText('去生成计划')).toBeNull();
  });

  it('轻松练档 + 质量课深负：降级提示 + 轻松骑车表（generateWorkout 真实出表）', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ last: point(REC - 5) });
    expect(screen.getByText('轻松练')).toBeTruthy();
    expect(screen.getByText('建议把阈值降为轻松骑，或顺延')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('看今日课表'));
    });
    // recovery 模板是稳态课：label 走 WORKOUT_TEMPLATES 出厂值
    expect(screen.getByText(/恢复骑 · 75 分钟 · 预计 TSS \d/)).toBeTruthy();
    expect(screen.getByText(/稳态 75 分钟 @ \d+–\d+W/)).toBeTruthy();
  });

  it('计划休息日：休息结论不出课表出口', async () => {
    const fixture = planFixture();
    fixture.plan.sessions = [
      { date: day(0), type: 'rest', duration_min: null, intensity: null, tss: 0, note: null },
    ];
    (getCurrentPlan as jest.Mock).mockResolvedValue(fixture);
    const screen = await mountCard({ last: point(10) });
    expect(screen.getByText('建议休息')).toBeTruthy();
    expect(screen.getByText('计划休息日，好好恢复')).toBeTruthy();
    expect(screen.queryByText('看今日课表')).toBeNull();
  });

  it('已练免扰档：不出任何出口', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ trainedToday: true });
    expect(screen.getByText('已练')).toBeTruthy();
    expect(screen.getByText('今天已练，好好恢复')).toBeTruthy();
    expect(screen.queryByText('看今日课表')).toBeNull();
    expect(screen.queryByText('和教练聊聊')).toBeNull();
  });

  it('无生效计划：纯状态建议 + 去计划页引导', async () => {
    const screen = await mountCard({ last: point(8) });
    expect(screen.getByText('状态不错，来场自由骑')).toBeTruthy();
    expect(screen.getByText(/无生效计划/)).toBeTruthy();
    expect(screen.getByText('去生成计划')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('和教练聊聊'));
    });
    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/ai/session/[id]', params: expect.objectContaining({ id: 'chat-new' }) }),
    );
    const arg = routerPush.mock.calls[0][0];
    expect(String(arg.params.draft)).toContain('暂无生效计划');
  });

  it('和教练聊聊出口：draft 预填 TSB 与计划课型上下文', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ last: point(-15) });
    await act(async () => {
      fireEvent.press(screen.getByText('和教练聊聊'));
    });
    const arg = routerPush.mock.calls[0][0];
    expect(arg.pathname).toBe('/ai/session/[id]');
    expect(arg.params.id).toBe('chat-new');
    expect(String(arg.params.draft)).toContain('TSB -15');
    expect(String(arg.params.draft)).toContain('计划排了阈值');
  });

  it('深度疲劳：休息结论（计划质量课时附降级提示语义）', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ last: point(LOW - 5) });
    expect(screen.getByText('建议休息')).toBeTruthy();
    expect(screen.getByText('深度疲劳，建议休息')).toBeTruthy();
    expect(screen.queryByText('看今日课表')).toBeNull();
  });
});

/**
 * plan-adherence-card.test.tsx — L4 组件测试：计划页「本周执行情况」卡（PlanAdherenceCard）。
 *
 * 钉住的中间层行为：UTC ±1 天缓冲拉取、实际训练按本地日归并（labels 命中走本地日、
 * 缺首帧回退 UTC 日、同日多骑合计）、三态与 pending 渲染、rest 日不评、
 * 整周无计划课（全 rest）整卡隐藏、今天已练按实际判。
 *
 * mock 边界：'@/db'（listActivitiesInRange）与 '@/services/aiTitle'（resolveRideDateLabels）
 * 设备侧模块整体替换；computeAdherence 纯函数不 mock（真实判定）。
 * 夹具日历：2026-10-12（周一）threshold 80 / 10-13（周二）endurance 60 / 10-14 rest /
 * 10-15（周四）threshold 85；today=10-13。
 */
import React from 'react';
import { act } from '@testing-library/react-native';
import { PlanAdherenceCard } from '@/components/PlanAdherenceCard';
import { listActivitiesInRange, type ActivityListItem } from '@/db';
import { resolveRideDateLabels } from '@/services/aiTitle';
import { addDays, type TrainingPlan } from '@/core/training-plan';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  listActivitiesInRange: jest.fn(),
  setLang: jest.fn(), // 真实 '@/i18n' 顶层从 '@/db' 取 setLang——防御性补齐
}));

jest.mock('@/services/aiTitle', () => ({
  resolveRideDateLabels: jest.fn(),
}));

const TODAY = '2026-10-13'; // 周二；周锚点 2026-10-12（周一）
const WEEK = '2026-10-12';

const plan: TrainingPlan = {
  valid_from: '2026-10-12',
  valid_to: '2026-10-25',
  goal: '基础期',
  sessions: [
    { date: '2026-10-12', type: 'threshold', duration_min: 60, intensity: null, tss: 80, note: null },
    { date: '2026-10-13', type: 'endurance', duration_min: 60, intensity: null, tss: 60, note: null },
    { date: '2026-10-14', type: 'rest', duration_min: null, intensity: null, tss: 0, note: null },
    { date: '2026-10-15', type: 'threshold', duration_min: 60, intensity: null, tss: 85, note: null },
  ],
};

const act_ = (file_name: string, date: string, tss: number, duration_sec = 3600): ActivityListItem => ({
  // 本测试只关心本地日归并：uuid 直接用文件名占位，标签 Map 的键同源
  uuid: file_name,
  file_name,
  date,
  sport: 'cycling',
  category: 'training',
  duration_sec,
  distance_km: 30,
  elevation_gain_m: 100,
  tss,
  np: null,
  avg_power: null,
  intensity_factor: null,
});

async function mount(acts: ActivityListItem[], labels: Record<string, string> = {}) {
  (listActivitiesInRange as jest.Mock).mockReset().mockResolvedValue(acts);
  (resolveRideDateLabels as jest.Mock).mockReset().mockResolvedValue(new Map(Object.entries(labels)));
  const screen = await renderWithProviders(<PlanAdherenceCard plan={plan} weekStart={WEEK} today={TODAY} />);
  await act(async () => {});
  return screen;
}

beforeEach(() => {
  (listActivitiesInRange as jest.Mock).mockReset().mockResolvedValue([]);
  (resolveRideDateLabels as jest.Mock).mockReset().mockResolvedValue(new Map());
});

describe('PlanAdherenceCard', () => {
  it('UTC ±1 天缓冲拉取；三态与 pending 渲染；rest 日不评', async () => {
    // a.fit UTC 10-11（提前一天）经首帧标签归并到周一；b.fit 缺标签回退 UTC 10-13（周二）
    const screen = await mount(
      [act_('a.fit', '2026-10-11', 80), act_('b.fit', '2026-10-13', 30)],
      { 'a.fit': '2026-10-12' },
    );
    expect(listActivitiesInRange).toHaveBeenCalledWith(addDays(WEEK, -1), addDays(WEEK, 7));
    expect(screen.getByTestId('plan-adherence-card')).toBeTruthy();
    expect(screen.getByText('本周执行情况')).toBeTruthy();
    expect(screen.getByText('完成')).toBeTruthy(); // 周一 80 ≥ 80×0.8
    expect(screen.getByText('降强完成')).toBeTruthy(); // 周二 30 < 60×0.8
    expect(screen.getByText('未到')).toBeTruthy(); // 周四未来
    expect(screen.queryByText(/休息/)).toBeNull(); // 显式 rest 不进表
  });

  it('本地日归并：同日多骑合计（含首帧标签换算）与缺首帧回退并存', async () => {
    const screen = await mount(
      [
        act_('a.fit', '2026-10-11', 80, 3600), // 标签 → 周一
        act_('c.fit', '2026-10-12', 20, 3600), // 标签 → 周一（同日合计 100）
        act_('b.fit', '2026-10-13', 10), // 缺首帧回退 UTC 日 → 周二
      ],
      { 'a.fit': '2026-10-12', 'c.fit': '2026-10-12' },
    );
    expect(resolveRideDateLabels).toHaveBeenCalledWith(['a.fit', 'c.fit', 'b.fit']);
    expect(screen.getByText('完成')).toBeTruthy(); // 周一 100 ≥ 64
    expect(screen.getByText('2h00')).toBeTruthy(); // 周一实际时长合计
    expect(screen.getByText('降强完成')).toBeTruthy(); // 周二 10 < 48
  });

  it('整周全是 rest（无已评课）整卡隐藏', async () => {
    const restWeek: TrainingPlan = {
      ...plan,
      sessions: [
        { date: '2026-10-26', type: 'rest', duration_min: null, intensity: null, tss: 0, note: null },
        { date: '2026-10-27', type: 'rest', duration_min: null, intensity: null, tss: 0, note: null },
      ],
    };
    const screen = await renderWithProviders(
      <PlanAdherenceCard plan={restWeek} weekStart="2026-10-26" today={TODAY} />,
    );
    await act(async () => {});
    expect(screen.queryByTestId('plan-adherence-card')).toBeNull();
  });

  it('今天已练按实际判（不判 pending）', async () => {
    const screen = await mount([act_('c.fit', '2026-10-13', 50)]);
    // 今天（周二）实际 50 ≥ 60×0.8=48 → 完成
    expect(screen.getByText('完成')).toBeTruthy();
  });
});

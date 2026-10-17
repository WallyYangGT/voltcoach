/**
 * weekly-activity-tile.test.tsx — L4 组件测试：首页 WHO 周活动量健康瓦片。
 *
 * 钉住：达成/未达成文案、目标与折算说明、高强度/轻松骑披露。数据汇总在
 * core/health-activity（L1 覆盖），本组件只验展示接线。
 */
import React from 'react';
import { WeeklyActivityTile } from '@/components/WeeklyActivityTile';
import { renderWithProviders } from './helpers/render';

const base = {
  days: 7,
  moderate_min: 120,
  vigorous_min: 90,
  light_min: 30,
  equivalent_min: 300,
  target_min: 150,
  extra_min: 300,
};

describe('WeeklyActivityTile', () => {
  it('达成目标：显示已达成、目标线、高强度与轻松骑披露', async () => {
    const screen = await renderWithProviders(<WeeklyActivityTile summary={base} />);
    expect(screen.getByText('近 7 天健康活动量')).toBeTruthy();
    expect(screen.getByText('已达成')).toBeTruthy();
    expect(screen.getByText('目标 150 分钟 · 额外收益线 300 分钟')).toBeTruthy();
    expect(screen.getByText('含高强度 90 分钟（已按 2 倍折算）')).toBeTruthy();
    expect(screen.getByText('另有轻松骑 30 分钟未计入')).toBeTruthy();
    expect(screen.getByTestId('weekly-activity-value')).toBeTruthy();
  });

  it('未达成目标：不显示已达成；无高强度/轻松分钟时不渲染对应行', async () => {
    const screen = await renderWithProviders(
      <WeeklyActivityTile
        summary={{ ...base, moderate_min: 60, vigorous_min: 0, light_min: 0, equivalent_min: 60 }}
      />,
    );
    expect(screen.queryByText('已达成')).toBeNull();
    expect(screen.queryByText(/含高强度/)).toBeNull();
    expect(screen.queryByText(/另有轻松骑/)).toBeNull();
    expect(screen.getByText('目标 150 分钟 · 额外收益线 300 分钟')).toBeTruthy();
  });
});

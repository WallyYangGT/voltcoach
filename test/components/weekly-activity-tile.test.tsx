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
  vigorous_equivalent_min: 180,
  light_min: 30,
  equivalent_min: 300,
  target_min: 150,
  extra_min: 300,
  power_state: 'calibrated' as const,
};

describe('WeeklyActivityTile', () => {
  it('达成目标：显示已达成、目标线、高强度与轻松骑披露', async () => {
    const screen = await renderWithProviders(<WeeklyActivityTile summary={base} />);
    expect(screen.getByText('近 7 天健康活动量')).toBeTruthy();
    expect(screen.getByText('已达成')).toBeTruthy();
    expect(screen.getByText('目标 150 分钟 · 额外收益线 300 分钟')).toBeTruthy();
    expect(screen.getByText('高强度原始 90 分钟（等效 180 分钟中等）')).toBeTruthy();
    expect(screen.getByText('另有轻松骑 30 分钟未计入')).toBeTruthy();
    expect(screen.getByTestId('weekly-activity-value')).toHaveTextContent(
      '300 分钟（中等强度等效）',
    );
  });

  it('未达成目标：不显示已达成；无高强度/轻松分钟时不渲染对应行', async () => {
    const screen = await renderWithProviders(
      <WeeklyActivityTile
        summary={{ ...base, moderate_min: 60, vigorous_min: 0, light_min: 0, equivalent_min: 60 }}
      />,
    );
    expect(screen.queryByText('已达成')).toBeNull();
    expect(screen.queryByText(/高强度原始/)).toBeNull();
    expect(screen.queryByText(/另有轻松骑/)).toBeNull();
    expect(screen.getByTestId('weekly-activity-value')).toHaveTextContent(
      '60 分钟（中等强度等效）',
    );
    expect(screen.getByText('目标 150 分钟 · 额外收益线 300 分钟')).toBeTruthy();
  });

  it('149 分钟未达成、150 分钟达成（边界）', async () => {
    const under = await renderWithProviders(
      <WeeklyActivityTile summary={{ ...base, moderate_min: 149, vigorous_min: 0, light_min: 0, equivalent_min: 149 }} />,
    );
    expect(under.queryByText('已达成')).toBeNull();
    const at = await renderWithProviders(
      <WeeklyActivityTile summary={{ ...base, moderate_min: 150, vigorous_min: 0, light_min: 0, equivalent_min: 150 }} />,
    );
    expect(at.getByText('已达成')).toBeTruthy();
  });

  it('FTP 未校准（有功率数据）：显示「未校准」披露', async () => {
    const screen = await renderWithProviders(
      <WeeklyActivityTile summary={{ ...base, power_state: 'uncalibrated' }} />,
    );
    expect(
      screen.getByText('检测到功率数据，但 FTP 未校准：强度按保守口径估算，校准后更准确'),
    ).toBeTruthy();
    expect(screen.queryByText(/近 7 天无功率数据/)).toBeNull();
  });

  it('无功率数据：显示「无功率」披露（与未校准分开）', async () => {
    const screen = await renderWithProviders(
      <WeeklyActivityTile summary={{ ...base, power_state: 'no_power' }} />,
    );
    expect(screen.getByText('近 7 天无功率数据：强度按保守口径估算')).toBeTruthy();
    expect(screen.queryByText(/FTP 未校准/)).toBeNull();
  });

  it('已校准：两种披露都不显示', async () => {
    const screen = await renderWithProviders(<WeeklyActivityTile summary={base} />);
    expect(screen.queryByText(/FTP 未校准/)).toBeNull();
    expect(screen.queryByText(/无功率数据/)).toBeNull();
  });
});

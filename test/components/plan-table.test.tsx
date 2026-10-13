/**
 * plan-table.test.tsx — L4 组件测试：轻量表格（PlanTable）。
 * 钉住：表头与行渲染、字符串/ReactNode 单元格、右对齐、高亮行样式（周视图"今天"行）。
 * 组件自身不取词（文案由调用方拼好传入），断言直接用注入字符串。
 */
import React from 'react';
import { Text } from 'react-native';
import { PlanTable } from '@/components/PlanTable';
import { palette } from '@/theme';
import { renderWithProviders } from './helpers/render';

describe('PlanTable', () => {
  const columns = [
    { key: 'day', label: '日期', flex: 1.5 },
    { key: 'tss', label: 'TSS', flex: 0.7, align: 'right' as const },
  ];

  it('表头与字符串行渲染；右对齐列', async () => {
    const screen = await renderWithProviders(
      <PlanTable columns={columns} rows={[['周一 10-12', '100'], ['周二 10-13', '85']]} />,
    );
    expect(screen.getByText('日期')).toBeTruthy();
    expect(screen.getByText('TSS')).toBeTruthy();
    expect(screen.getByText('周一 10-12')).toBeTruthy();
    expect(screen.getByText('85')).toBeTruthy();
    expect(screen.getByTestId('plan-row-1')).toBeTruthy();
  });

  it('ReactNode 单元格原样渲染（课型标签等待色场景）', async () => {
    const screen = await renderWithProviders(
      <PlanTable
        columns={columns}
        rows={[[<Text key="t" style={{ color: palette.volt }}>阈值</Text>, '100']]}
      />,
    );
    expect(screen.getByText('阈值')).toBeTruthy();
  });

  it('highlightIndex 行加高亮底色（今天行）', async () => {
    const screen = await renderWithProviders(
      <PlanTable columns={columns} rows={[['a', '1'], ['b', '2']]} highlightIndex={1} />,
    );
    expect(screen.getByTestId('plan-row-1')).toHaveStyle({ backgroundColor: palette.panel2 });
    expect(screen.getByTestId('plan-row-0')).not.toHaveStyle({ backgroundColor: palette.panel2 });
  });
});

/**
 * gen-status-row.test.tsx — L4 组件测试：AI 生成过程状态行（2026-10 生成可视化）。
 *
 * 钉住的中间层行为：无 progress 的 live 态默认「模型思考中…」、非 live 不渲染、
 * 工具阶段放大镜/文案、reasoning 单行 ticker（空白折叠、纯空白回落标签）、
 * streaming/tool_done 的图标与文案。闪烁动画本身是原生驱动、卸载即停，不做帧级断言。
 */
import React from 'react';
import { GenStatusRow } from '@/components/GenStatusRow';
import { renderWithProviders } from './helpers/render';

describe('GenStatusRow', () => {
  it('live 且无 progress：显示默认「模型思考中…」', async () => {
    const { getByText, getByTestId } = await renderWithProviders(
      <GenStatusRow progress={null} live />,
    );
    expect(getByText('模型思考中…')).toBeTruthy();
    expect(getByTestId('gen-status-icon-thinking')).toBeTruthy();
  });

  it('非 live 且无 progress：不渲染', async () => {
    const { queryByTestId } = await renderWithProviders(<GenStatusRow progress={null} />);
    expect(queryByTestId('gen-status')).toBeNull();
  });

  it('tool 阶段：放大镜图标 + 工具名文案', async () => {
    const { getByText, getByTestId } = await renderWithProviders(
      <GenStatusRow
        progress={{ attempt: 0, note: '', phase: 'tool', activity: '正在调用 get_form_series…' }}
        live
      />,
    );
    expect(getByTestId('gen-status-icon-tool')).toBeTruthy();
    expect(getByText('正在调用 get_form_series…')).toBeTruthy();
  });

  it('thinking + 思考正文：显示单行滚动 ticker（空白折叠）', async () => {
    const { getByText, getByTestId, queryByText } = await renderWithProviders(
      <GenStatusRow
        progress={{
          attempt: 0,
          note: '',
          phase: 'thinking',
          activity: '模型思考中…',
          thinking: '先看\n最近  负荷',
        }}
        live
      />,
    );
    expect(getByTestId('gen-thinking-ticker')).toBeTruthy();
    expect(getByText('先看 最近 负荷')).toBeTruthy();
    expect(queryByText('模型思考中…')).toBeNull(); // ticker 取代标签（用户要的"或"）
  });

  it('thinking + 纯空白正文：不显示 ticker，回落标签', async () => {
    const { getByText, queryByTestId } = await renderWithProviders(
      <GenStatusRow
        progress={{
          attempt: 0,
          note: '',
          phase: 'thinking',
          activity: '模型思考中…',
          thinking: '  \n ',
        }}
        live
      />,
    );
    expect(queryByTestId('gen-thinking-ticker')).toBeNull();
    expect(getByText('模型思考中…')).toBeTruthy();
  });

  it('streaming 阶段：圆点图标 + 生成中文案', async () => {
    const { getByText, getByTestId } = await renderWithProviders(
      <GenStatusRow
        progress={{ attempt: 0, note: '', phase: 'streaming', activity: '生成中…' }}
        live
      />,
    );
    expect(getByTestId('gen-status-icon-streaming')).toBeTruthy();
    expect(getByText('生成中…')).toBeTruthy();
  });

  it('tool_done 阶段：勾选图标 + 完成文案', async () => {
    const { getByText, getByTestId } = await renderWithProviders(
      <GenStatusRow
        progress={{
          attempt: 0,
          note: '',
          phase: 'tool_done',
          activity: '✓ get_form_series · 12 字符',
        }}
        live
      />,
    );
    expect(getByTestId('gen-status-icon-tool_done')).toBeTruthy();
    expect(getByText('✓ get_form_series · 12 字符')).toBeTruthy();
  });
});

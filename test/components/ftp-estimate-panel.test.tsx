/**
 * ftp-estimate-panel.test.tsx — L4 组件测试：FTP 科学估算面板（FtpEstimatePanel）。
 *
 * 钉住的中间层行为（原靠 L3 冒烟）：loading → done → error 三相状态机、
 * 采纳门控（仅「高置信 + 与当前配置有差异」可写回——Web 版同款门控）、
 * 采纳动作调 setAthlete(source: 'estimate') 并回调 onApplied、
 * insufficient 态的数据清单排版。
 *
 * mock 边界：'@/db' 设备侧替换；'@/core/ftp' 的 estimateFtpFromHistory 也 mock——
 * 估算器本体已有 node:test 覆盖（src/core 行覆盖 ≥90% 门槛），这里只钉面板接线，
 * 用成品 FtpEstimationResult 夹具驱动各分支。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { FtpEstimatePanel } from '@/components/FtpEstimatePanel';
import type { FtpEstimationResult } from '@/core/ftp';
import { cyclingSummariesSince, getEffectiveAthlete, setAthlete } from '@/db';
import { estimateFtpFromHistory } from '@/core/ftp';
import { renderWithProviders } from './helpers/render';

// 估算器本体已有 node:test 覆盖（src/core ≥90% 门槛），面板测试整体 mock；
// babel-plugin-jest-hoist 会把 jest.mock 提到所有 import 之前，此处顺序合规
jest.mock('@/db', () => ({
  cyclingSummariesSince: jest.fn(),
  getEffectiveAthlete: jest.fn(),
  setAthlete: jest.fn(),
}));

jest.mock('@/core/ftp', () => ({
  estimateFtpFromHistory: jest.fn(),
}));

function okResult(over: Partial<FtpEstimationResult> = {}): FtpEstimationResult {
  return {
    status: 'ok',
    window_days: 42,
    sample: { cycling_rides: 12, rides_with_power: 10, usable_power_rides: 9, rides_with_hr: 8 },
    estimate: {
      ftp_w: 260,
      range_low: 250,
      range_high: 270,
      confidence: 'high',
      confidence_note: '样本充足，两法收敛',
      current_ftp_w: 220,
      diff_w: 40,
      methods: {
        cp_model: null,
        coggan_20min: { ftp_w: 260, peak_20min_w: 274, date: '2026-09-01', uuid: 'a'.repeat(32), file_name: 'a.fit' },
        hr_check: {
          maximal_effort: true,
          best20_max_hr: 178,
          threshold_hr: 162,
          zone_mismatch: null,
          median_hr_drift_pct: null,
        },
      },
    },
    data_needs: ['再积累 3 次有效功率骑行'],
    notes: ['20min 峰功率出现在 9 月初'],
    references: ['Coggan'],
    ...over,
  };
}

async function mountWithResult(result: FtpEstimationResult | Promise<never>) {
  (cyclingSummariesSince as jest.Mock).mockResolvedValue([]);
  (getEffectiveAthlete as jest.Mock).mockResolvedValue({});
  (estimateFtpFromHistory as jest.Mock).mockReturnValue(result);
  return renderWithProviders(<FtpEstimatePanel onApplied={() => {}} />);
}

beforeEach(() => {
  (cyclingSummariesSince as jest.Mock).mockReset();
  (getEffectiveAthlete as jest.Mock).mockReset();
  (setAthlete as jest.Mock).mockReset().mockResolvedValue(undefined);
  (estimateFtpFromHistory as jest.Mock).mockReset();
});

describe('FtpEstimatePanel', () => {
  it('loading 相：取数期间显示分析中', async () => {
    (cyclingSummariesSince as jest.Mock).mockReturnValue(new Promise(() => {}));
    (getEffectiveAthlete as jest.Mock).mockReturnValue(new Promise(() => {}));
    const { getByText } = await renderWithProviders(<FtpEstimatePanel onApplied={() => {}} />);
    expect(getByText('正在分析最近窗口期的功率与心率数据…')).toBeTruthy();
  });

  it('error 相：取数失败显示错误原文', async () => {
    (cyclingSummariesSince as jest.Mock).mockRejectedValue(new Error('库打不开'));
    (getEffectiveAthlete as jest.Mock).mockResolvedValue({});
    const { getByText } = await renderWithProviders(<FtpEstimatePanel onApplied={() => {}} />);
    expect(getByText('FTP 估算失败：库打不开')).toBeTruthy();
  });

  it('insufficient 相：数据不足文案 + 补数清单，无采纳按钮', async () => {
    const result = okResult({
      status: 'insufficient',
      estimate: null,
      data_needs: ['需要 ≥6 次有效功率骑行'],
      notes: [],
    });
    const { getByText, queryByText } = await mountWithResult(result);
    expect(getByText('FTP 科学估算 — 数据不足')).toBeTruthy();
    expect(getByText('需要补充收集的数据：')).toBeTruthy();
    expect(getByText('· 需要 ≥6 次有效功率骑行')).toBeTruthy();
    expect(queryByText(/采纳 /)).toBeNull();
  });

  it('ok + 高置信 + 有差异：显示大数字与采纳按钮，采纳写回训练库并回调', async () => {
    const onApplied = jest.fn();
    (cyclingSummariesSince as jest.Mock).mockResolvedValue([]);
    (getEffectiveAthlete as jest.Mock).mockResolvedValue({});
    (estimateFtpFromHistory as jest.Mock).mockReturnValue(okResult());
    (setAthlete as jest.Mock).mockResolvedValue(undefined);
    const { getByText, queryByText } = await renderWithProviders(<FtpEstimatePanel onApplied={onApplied} />);
    await act(async () => {});
    expect(getByText('260 W')).toBeTruthy(); // 大数字（'260' 与单位 ' W' 嵌套拼接）
    expect(getByText('置信度 高')).toBeTruthy();
    expect(getByText('参考区间 250–270W · 比当前配置（220W）高 40W')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByText('采纳 260W 并保存到训练库'));
    });
    expect(setAthlete).toHaveBeenCalledWith({ ftp_watts: 260 }, 'zh', { source: 'estimate' });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(getByText('已保存到训练库并即时生效')).toBeTruthy();
    expect(queryByText(/采纳 260W/)).toBeNull(); // 按钮收起
  });

  it('ok + 无差异：显示「与当前配置一致」，不出采纳入口', async () => {
    const result = okResult();
    result.estimate!.current_ftp_w = 260;
    result.estimate!.diff_w = 0;
    const { getByText, queryByText } = await mountWithResult(result);
    // diff 文案与参考区间拼在同一行（ftp.range 模板整体插值）
    expect(getByText('参考区间 250–270W · 与当前配置一致')).toBeTruthy();
    expect(queryByText(/采纳 /)).toBeNull();
    expect(queryByText('置信度不足，不建议写回 — 请先按下方清单补充数据后重新估算')).toBeNull();
  });

  it('ok + 中置信：采纳门控生效，仅显示不建议写回', async () => {
    const result = okResult();
    result.estimate!.confidence = 'medium';
    result.estimate!.confidence_note = '样本偏少';
    const { getByText, queryByText } = await mountWithResult(result);
    expect(getByText('置信度 中')).toBeTruthy();
    expect(getByText('置信度不足，不建议写回 — 请先按下方清单补充数据后重新估算')).toBeTruthy();
    expect(queryByText(/采纳 260W/)).toBeNull();
  });
});

/**
 * ai-ftp-update-banner.test.tsx — L4 组件测试：AI 教练 FTP 更新披露条（AiFtpUpdateBanner）。
 *
 * 钉住的中间层行为（架构评审 S3 追认入口）：快照存在且当前 FTP 等于快照 new 值
 * 才渲染（被后续手动/AI 修改即隐藏）、撤销走 Alert 二次确认、确认分支调
 * undoAiFtpUpdate 并在成功后回调 onChanged 且披露条消失、快照失效分支重查自愈。
 *
 * mock 边界：'@/db'（快照/骑手参数读取）与 '@/services/ftp-apply'（撤销编排——
 * 已由 services 层职责边界划出，组件测试只钉接线）。Alert 用 jest.spyOn 收集
 * 按钮回调（模式同 reset-follow-up-button.test.tsx）。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { AiFtpUpdateBanner } from '@/components/AiFtpUpdateBanner';
import { getAiFtpUpdate, getEffectiveAthlete } from '@/db';
import { undoAiFtpUpdate } from '@/services/ftp-apply';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getAiFtpUpdate: jest.fn(),
  getEffectiveAthlete: jest.fn(),
}));

jest.mock('@/services/ftp-apply', () => ({
  undoAiFtpUpdate: jest.fn(),
}));

type AlertButton = { text: string; style?: string; onPress?: () => void };
/** 取第 callIdx 次 Alert.alert 的按钮数组（title/message/buttons 三参形态） */
const alertButtons = (callIdx: number) =>
  (Alert.alert as jest.Mock).mock.calls[callIdx][2] as AlertButton[];

const snap = { old_ftp_w: 245, new_ftp_w: 258, updated_at: '2026-10-14T08:30:00.000Z' };

async function mount(s: typeof snap | null, ftp: number, onChanged?: () => void) {
  (getAiFtpUpdate as jest.Mock).mockResolvedValue(s);
  (getEffectiveAthlete as jest.Mock).mockResolvedValue({ ftp_watts: ftp });
  return renderWithProviders(<AiFtpUpdateBanner onChanged={onChanged} />);
}

beforeEach(() => {
  (getAiFtpUpdate as jest.Mock).mockReset();
  (getEffectiveAthlete as jest.Mock).mockReset();
  (undoAiFtpUpdate as jest.Mock).mockReset().mockResolvedValue({ undone: true, restored_ftp_w: 245 });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
});

describe('AiFtpUpdateBanner', () => {
  it('无快照：不渲染', async () => {
    const { queryByText } = await mount(null, 245);
    await act(async () => {});
    expect(queryByText(/AI 教练已于/)).toBeNull();
  });

  it('快照存在但当前 FTP 已被后续修改：不渲染（stale 隐藏）', async () => {
    const { queryByText } = await mount(snap, 250);
    await act(async () => {});
    expect(queryByText(/AI 教练已于/)).toBeNull();
  });

  it('快照有效：披露 old→new 与日期，点撤销先弹二次确认', async () => {
    const { getByText } = await mount(snap, 258);
    await act(async () => {});
    expect(getByText('AI 教练已于 2026-10-14 将 FTP 从 245W 调整为 258W（数据自动估算，依据见会话）')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByText('撤销'));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '撤销 AI 的 FTP 更新？',
      'FTP 将恢复为 245W，训练档案随之重建。',
      expect.any(Array),
    );
    expect(undoAiFtpUpdate).not.toHaveBeenCalled(); // 确认前不动数据
  });

  it('确认分支：调 undoAiFtpUpdate，成功后回调 onChanged 且披露条消失', async () => {
    const onChanged = jest.fn();
    const { getByText, queryByText } = await mount(snap, 258, onChanged);
    await act(async () => {});
    await act(async () => {
      fireEvent.press(getByText('撤销'));
    });
    await act(async () => {
      alertButtons(0).find((b) => b.style === 'destructive')?.onPress?.();
    });
    expect(undoAiFtpUpdate).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(queryByText(/AI 教练已于/)).toBeNull();
  });

  it('撤销时快照已失效（stale）：不回调 onChanged，重查后整条隐藏', async () => {
    (undoAiFtpUpdate as jest.Mock).mockResolvedValue({ undone: false, reason: 'stale' });
    // 直接设 mock（不经 mount 助手——其 mockResolvedValue 会覆盖本用例的首次/后续差异）
    (getAiFtpUpdate as jest.Mock).mockResolvedValue(snap);
    (getEffectiveAthlete as jest.Mock)
      .mockResolvedValueOnce({ ftp_watts: 258 }) // 首次渲染：FTP 仍等于快照 new 值
      .mockResolvedValue({ ftp_watts: 250 }); // 撤销重查：已被改为 250 → 整条隐藏
    const onChanged = jest.fn();
    const { getByText, queryByText } = await renderWithProviders(<AiFtpUpdateBanner onChanged={onChanged} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.press(getByText('撤销'));
    });
    await act(async () => {
      alertButtons(0).find((b) => b.style === 'destructive')?.onPress?.();
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(queryByText(/AI 教练已于/)).toBeNull();
  });
});

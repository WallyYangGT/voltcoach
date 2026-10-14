/**
 * ai-ftp-update-banner.test.tsx — L4 组件测试：AI 教练 FTP 更新披露条（AiFtpUpdateBanner）。
 *
 * 钉住的中间层行为（架构评审 S3 追认入口；2026-10-14 code-review 修复批改为
 * props 驱动——快照/当前 FTP 由首页 load()（useFocusEffect）下传，组件内部不再
 * 自查，否则 tab 常驻挂载下 AI 更新后返回首页看不到披露条）：显示条件（快照存在
 * 且当前 FTP 等于快照 new 值）、撤销走 Alert 二次确认、确认分支调 undoAiFtpUpdate
 * 并回调 onChanged、撤销失败 Alert 反馈、props 变化（当前值被改）即隐藏。
 *
 * mock 边界：仅 '@/services/ftp-apply'（撤销编排——已由 services 层职责边界划出，
 * 组件测试只钉接线）。Alert 用 jest.spyOn 收集按钮回调（模式同
 * reset-follow-up-button.test.tsx）。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { AiFtpUpdateBanner } from '@/components/AiFtpUpdateBanner';
import { undoAiFtpUpdate } from '@/services/ftp-apply';
import { renderWithProviders, wrapWithProviders } from './helpers/render';

jest.mock('@/services/ftp-apply', () => ({
  undoAiFtpUpdate: jest.fn(),
}));

type AlertButton = { text: string; style?: string; onPress?: () => void };
/** 取第 callIdx 次 Alert.alert 的按钮数组（title/message/buttons 三参形态） */
const alertButtons = (callIdx: number) =>
  (Alert.alert as jest.Mock).mock.calls[callIdx][2] as AlertButton[];

const snap = { old_ftp_w: 245, new_ftp_w: 258, updated_at: '2026-10-14T12:00:00.000Z' }; // 正午 UTC：极端西时区也不跨日

beforeEach(() => {
  (undoAiFtpUpdate as jest.Mock).mockReset().mockResolvedValue({ undone: true, restored_ftp_w: 245 });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
});

describe('AiFtpUpdateBanner', () => {
  it('无快照或当前 FTP 已被后续修改：不渲染', async () => {
    const { queryByText, rerender } = await renderWithProviders(
      <AiFtpUpdateBanner snapshot={null} currentFtp={245} />,
    );
    expect(queryByText(/AI 教练已于/)).toBeNull();
    rerender(wrapWithProviders(<AiFtpUpdateBanner snapshot={snap} currentFtp={250} />));
    expect(queryByText(/AI 教练已于/)).toBeNull();
  });

  it('快照有效：披露 old→new 与本地日期，点撤销先弹二次确认且确认前不动数据', async () => {
    const { getByText } = await renderWithProviders(
      <AiFtpUpdateBanner snapshot={snap} currentFtp={258} />,
    );
    expect(getByText('AI 教练已于 2026-10-14 将 FTP 从 245W 调整为 258W（数据自动估算，依据见会话）')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByText('撤销'));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '撤销 AI 的 FTP 更新？',
      'FTP 将恢复为 245W，训练档案随之重建。',
      expect.any(Array),
    );
    expect(undoAiFtpUpdate).not.toHaveBeenCalled();
  });

  it('确认分支：调 undoAiFtpUpdate 并回调 onChanged（首页据此重取快照与 FTP 收敛显示）', async () => {
    const onChanged = jest.fn();
    const { getByText, rerender, queryByText } = await renderWithProviders(
      <AiFtpUpdateBanner snapshot={snap} currentFtp={258} onChanged={onChanged} />,
    );
    await act(async () => {
      fireEvent.press(getByText('撤销'));
    });
    await act(async () => {
      alertButtons(0).find((b) => b.style === 'destructive')?.onPress?.();
    });
    expect(undoAiFtpUpdate).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 撤销成功后首页 load() 重取：快照清空 → props 变化 → 整条隐藏
    // （rerender 包 act：撤销链路的 setState 需在断言前彻底冲刷）
    await act(async () => {
      rerender(wrapWithProviders(<AiFtpUpdateBanner snapshot={null} currentFtp={245} onChanged={onChanged} />));
    });
    expect(queryByText(/AI 教练已于/)).toBeNull();
  });

  it('撤销失败（如快照 old 值越界/DB 异常）：Alert 反馈而非静默', async () => {
    (undoAiFtpUpdate as jest.Mock).mockRejectedValue(new Error('athlete.range'));
    const onChanged = jest.fn();
    const { getByText } = await renderWithProviders(
      <AiFtpUpdateBanner snapshot={snap} currentFtp={258} onChanged={onChanged} />,
    );
    await act(async () => {
      fireEvent.press(getByText('撤销'));
    });
    await act(async () => {
      alertButtons(0).find((b) => b.style === 'destructive')?.onPress?.();
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('操作失败', 'athlete.range');
  });
});

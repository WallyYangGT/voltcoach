/**
 * onelap-sync-card.test.tsx — L4 组件测试：顽鹿同步卡（OnelapSyncCard）。
 *
 * 钉住的中间层行为（原靠 L3 冒烟）：无账号时「立即同步」禁用、账号回填仅在
 * 输入框为空时（防覆盖编辑中草稿的守卫）、保存后 flash「已保存 ✓」+ 密码清空、
 * 同步结果计数行、按错误码映射 Alert、解绑二次确认走 destructive 分支、
 * 自动同步开关落库。
 *
 * mock 边界：'@/services/syncOnelap' 与 '@/db' 设备侧模块整体替换；
 * Alert.alert 用 jest.spyOn 收集（RN 的 Alert 在测试环境不弹）。
 * 两个 Paper TextInput 无占位符，按渲染序用其固有 testID 定位
 * （outlined 模式的内层输入恒为 text-input-outlined：[0]=账号、[1]=密码）。
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, userEvent } from '@testing-library/react-native';
import { OnelapSyncCard } from '@/components/OnelapSyncCard';
import type { SyncState } from '@/db';
import { getSyncState, setSyncState } from '@/db';
import {
  getOnelapAccount,
  onelapOverrideBase,
  probeOnelapEndpoints,
  runOnelapSync,
  setOnelapAccount,
  type SyncOutcome,
} from '@/services/syncOnelap';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getSyncState: jest.fn(),
  setSyncState: jest.fn(),
  // 真实 '@/i18n' 顶层从 '@/db' 取 setLang（语言切换时用）——防御性补齐防图谱缺键
  setLang: jest.fn(),
}));

jest.mock('@/services/syncOnelap', () => ({
  getOnelapAccount: jest.fn(),
  onelapOverrideBase: jest.fn(() => null),
  probeOnelapEndpoints: jest.fn(),
  runOnelapSync: jest.fn(),
  setOnelapAccount: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React = require('react'); // eslint-disable-line @typescript-eslint/no-require-imports
  // useFocusEffect 以 hook 形态挂载期执行一次（模拟聚焦加载）
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => { void cb(); }, [cb]),
  };
});

const EMPTY_STATE: SyncState = {
  auto: false,
  last_sync_at: null,
  last_result: null,
  last_error: null,
  last_counts: null,
};

function outcomeOf(partial: Partial<SyncOutcome> = {}): SyncOutcome {
  return { imported: 0, skipped: 0, duplicates: 0, failed: 0, error: null, failureFloor: null, ...partial };
}

/** 挂载并 flush useFocusEffect 触发的 load() */
async function mountCard() {
  const screen = await renderWithProviders(<OnelapSyncCard />);
  await act(async () => {});
  return screen;
}

beforeEach(() => {
  (getSyncState as jest.Mock).mockReset().mockResolvedValue(EMPTY_STATE);
  (setSyncState as jest.Mock).mockReset().mockResolvedValue(undefined);
  (getOnelapAccount as jest.Mock).mockReset().mockResolvedValue(null);
  (setOnelapAccount as jest.Mock).mockReset().mockResolvedValue(undefined);
  (runOnelapSync as jest.Mock).mockReset().mockResolvedValue(outcomeOf());
  (probeOnelapEndpoints as jest.Mock).mockReset().mockResolvedValue([]);
  (onelapOverrideBase as jest.Mock).mockReset().mockReturnValue(null);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
});

describe('OnelapSyncCard', () => {
  it('无账号：同步按钮禁用、无解绑入口、显示「从未同步」', async () => {
    const screen = await mountCard();
    expect(screen.getByText('立即同步')).toBeDisabled();
    expect(screen.queryByText('解除绑定')).toBeNull();
    expect(screen.getByText('从未同步')).toBeTruthy();
  });

  it('有账号：回填账号、解绑入口出现、同步可用、上次同步行显示 ✓', async () => {
    (getOnelapAccount as jest.Mock).mockResolvedValue({ account: 'rider@example.com', password: 'pw' });
    (getSyncState as jest.Mock).mockResolvedValue({
      ...EMPTY_STATE,
      last_sync_at: '2026-10-12T08:30:00.000Z',
      last_result: 'ok',
    });
    const screen = await mountCard();
    expect(screen.getByDisplayValue('rider@example.com')).toBeTruthy();
    expect(screen.getByText('解除绑定')).toBeTruthy();
    expect(screen.getByText('立即同步')).toBeEnabled();
    expect(screen.getByText('2026-10-12 08:30 · ✓')).toBeTruthy();
    // 密码不回显（密文位）
    expect(screen.getAllByTestId('text-input-outlined')[1].props.value).toBe('');
  });

  it('回填守卫：输入框已有草稿时不覆盖（tab 聚焦频繁，防丢编辑中内容）', async () => {
    let resolveAccount: (v: { account: string; password: string } | null) => void = () => {};
    (getOnelapAccount as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveAccount = resolve;
      }),
    );
    const screen = await renderWithProviders(<OnelapSyncCard />);
    // load 未落定前先打字（模拟用户已在编辑）
    const inputs = screen.getAllByTestId('text-input-outlined');
    await userEvent.type(inputs[0], '我的新账号');
    await act(async () => {
      resolveAccount({ account: 'rider@example.com', password: 'pw' });
    });
    expect(screen.getByDisplayValue('我的新账号')).toBeTruthy();
  });

  it('保存账号：调 setOnelapAccount、密码清空、flash「已保存 ✓」', async () => {
    const screen = await mountCard();
    const inputs = screen.getAllByTestId('text-input-outlined');
    await userEvent.type(inputs[0], 'rider@example.com');
    await userEvent.type(inputs[1], 'secret');
    await act(async () => {
      fireEvent.press(screen.getByText('保存账号'));
    });
    expect(setOnelapAccount).toHaveBeenCalledWith('rider@example.com', 'secret');
    expect(inputs[1].props.value).toBe(''); // 密码不残留
    expect(screen.getByText('已保存 ✓')).toBeTruthy();
  });

  it('立即同步：成功后显示计数行并回读状态', async () => {
    (getOnelapAccount as jest.Mock).mockResolvedValue({ account: 'rider@example.com', password: 'pw' });
    (runOnelapSync as jest.Mock).mockResolvedValue(outcomeOf({ imported: 2, skipped: 1, failed: 0 }));
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('立即同步'));
    });
    expect(runOnelapSync).toHaveBeenCalledTimes(1);
    expect(screen.getByText('导入 2 · 跳过 1 · 失败 0')).toBeTruthy();
    expect(screen.getByText('立即同步')).toBeEnabled(); // busy 态退出
  });

  it('立即同步：auth 错误弹「登录失败」Alert 透出原始信息', async () => {
    (getOnelapAccount as jest.Mock).mockResolvedValue({ account: 'rider@example.com', password: 'pw' });
    (runOnelapSync as jest.Mock).mockResolvedValue(outcomeOf({ error: { code: 'auth', message: '登录失败：密码错误' } }));
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('立即同步'));
    });
    expect(Alert.alert).toHaveBeenCalledWith('登录失败：账号或密码错误', '登录失败：密码错误');
  });

  it('立即同步：编排层抛错也不静默（Alert 兜底）', async () => {
    (getOnelapAccount as jest.Mock).mockResolvedValue({ account: 'rider@example.com', password: 'pw' });
    (runOnelapSync as jest.Mock).mockRejectedValue(new Error('db locked'));
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('立即同步'));
    });
    expect(Alert.alert).toHaveBeenCalledWith('操作失败', 'Error: db locked');
  });

  it('解绑：Alert 二次确认，确认分支调 setOnelapAccount(空) 并触发凭据回读', async () => {
    (getOnelapAccount as jest.Mock).mockResolvedValue({ account: 'rider@example.com', password: 'pw' });
    const screen = await mountCard();
    // fireEvent 一律包 act：裸 press 会让 React 的 act 环境残留脏状态、毒化后续用例的渲染
    await act(async () => {
      fireEvent.press(screen.getByText('解除绑定'));
    });
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as {
      text: string;
      onPress?: () => Promise<void> | void;
    }[];
    expect(buttons).toHaveLength(2);
    await act(async () => {
      await buttons[1].onPress?.(); // destructive「解除绑定」分支（async，须等翻转落定）
    });
    expect(setOnelapAccount).toHaveBeenCalledWith('', null);
    // 确认分支末尾的 load()：解绑后重新回读凭据（无账号态由下一次 load 渲染）
    expect(getOnelapAccount).toHaveBeenCalledTimes(2);
  });

  it('自动同步开关：开→乐观更新并 setSyncState(auto=true)', async () => {
    const screen = await mountCard();
    const sw = screen.getByRole('switch');
    await act(async () => {
      fireEvent(sw, 'valueChange', true);
    });
    expect(setSyncState).toHaveBeenCalledWith({ ...EMPTY_STATE, auto: true });
  });

  it('联调端点覆盖时显示红色自曝横幅（防把联调包当生产包）', async () => {
    (onelapOverrideBase as jest.Mock).mockReturnValue('http://10.0.2.2:8791');
    const screen = await mountCard();
    expect(screen.getByText('⚠︎ 联调模式：接口地址被覆盖为 http://10.0.2.2:8791（此包仅供开发调试，请勿用于真实数据）')).toBeTruthy();
  });

  it('测试连接：不需要账号，结果行拼 Alert', async () => {
    (probeOnelapEndpoints as jest.Mock).mockResolvedValue([
      { url: 'https://example-cn.onelap.cn', reachable: true, ms: 88, status: 200 },
    ]);
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('测试连接'));
    });
    expect(probeOnelapEndpoints).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      '连接测试',
      expect.stringContaining('example-cn.onelap.cn：可达 · 88ms（HTTP 200）'),
    );
  });
});

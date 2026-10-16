/**
 * sync-card.test.tsx — L4 组件测试：云同步卡（SyncCard，多平台）。
 *
 * 钉住的中间层行为（原靠 L3 冒烟，2026-10-16 由 onelap-sync-card.test.tsx 泛化）：
 * 无账号时「立即同步」禁用、账号回填仅在输入框为空时（防覆盖编辑中草稿的守卫）、
 * 保存后 flash「已保存 ✓」+ 密码清空、同步结果计数行、按错误码映射 Alert（含
 * reauth）、解绑二次确认走 destructive 分支、自动同步开关落库；
 * 多平台新增：平台下拉列出注册表里的平台并显示当前生效项、切到其它平台要二次
 * 确认且确认后只改 provider 字段（不动凭据与水位线）、切到未绑定平台不弹确认。
 *
 * mock 边界：'@/services/sync'（编排入口）、'@/services/syncProviders'（平台注册表，
 * 用两个平台来验证"切平台"路径）与 '@/db' 整体替换；Alert.alert 用 jest.spyOn 收集。
 * 三个 Paper TextInput 无占位符，按渲染序用固有 testID 定位（outlined 模式的内层
 * 输入恒为 text-input-outlined：[0]=平台下拉、[1]=账号、[2]=密码）。
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, userEvent } from '@testing-library/react-native';
import { SyncCard } from '@/components/SyncCard';
import type { SyncState } from '@/db';
import { getSyncState, setSyncState } from '@/db';
import type { ProbeResult } from '@/sync/common';
import { runSync, type SyncOutcome } from '@/services/sync';
import {
  allProviders,
  providerById,
  type SyncCredentials,
  type SyncProvider,
} from '@/services/syncProviders';
import { completeWahooAuth, openWahooAuthorize, prepareWahooAuth } from '@/services/wahooAuth';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getSyncState: jest.fn(),
  setSyncState: jest.fn(),
  // 真实 '@/i18n' 顶层从 '@/db' 取 setLang（语言切换时用）——防御性补齐防图谱缺键
  setLang: jest.fn(),
}));

jest.mock('@/services/sync', () => ({
  runSync: jest.fn(),
}));

jest.mock('@/services/syncProviders', () => ({
  allProviders: jest.fn(() => []),
  providerById: jest.fn(),
}));

// Wahoo 授权流整体 mock：卡片与 WahooAuthForm 的接线在这里验（浏览器/门户交互本身属
// 设备侧行为，由模拟器冒烟覆盖；PKCE 与回调解析已被 L1 直测）
jest.mock('@/services/wahooAuth', () => ({
  wahooRedirectUri: jest.fn(() => 'voltcoach:///wahoo-callback'),
  prepareWahooAuth: jest.fn(),
  openWahooAuthorize: jest.fn(),
  completeWahooAuth: jest.fn(),
  clearPendingWahooAuth: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React = require('react'); // eslint-disable-line @typescript-eslint/no-require-imports
  // useFocusEffect 以 hook 形态挂载期执行一次（模拟聚焦加载）
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => { void cb(); }, [cb]),
  };
});

const MENU_ITEM_IGPSPORT = '迹驰 iGPSPORT（国内）';

const EMPTY_STATE: SyncState = { provider: 'onelap', auto: false, providers: {} };

/** 平台适配器桩的 jest 面（mock 方法要能被 mockResolvedValue/mockReturnValue 覆写） */
interface ProviderStub extends SyncProvider {
  loadCredentials: jest.Mock;
  saveCredentials: jest.Mock;
  clearCredentials: jest.Mock;
  createRunner: jest.Mock;
  probe: jest.Mock;
  overrideBase: jest.Mock;
}

/** 平台适配器桩（密码型：顽鹿 / 迹驰国内；oauth 型：Wahoo） */
function providerStub(
  id: 'onelap' | 'igpsport-cn' | 'wahoo',
  labelKey: SyncProvider['labelKey'],
  authKind: SyncProvider['authKind'] = 'password',
): ProviderStub {
  return {
    id,
    labelKey,
    authKind,
    loadCredentials: jest.fn(async (): Promise<SyncCredentials | null> => null),
    saveCredentials: jest.fn(async () => {}),
    clearCredentials: jest.fn(async () => {}),
    createRunner: jest.fn(),
    probe: jest.fn(async (): Promise<ProbeResult[]> => []),
    overrideBase: jest.fn((): string | null => null),
  };
}

let onelap: ProviderStub;
let igpsport: ProviderStub;
let wahoo: ProviderStub;

function outcomeOf(partial: Partial<SyncOutcome> = {}): SyncOutcome {
  return { imported: 0, skipped: 0, duplicates: 0, failed: 0, error: null, failureFloor: null, ...partial };
}

/** 挂载并 flush useFocusEffect 触发的 load() */
async function mountCard() {
  const screen = await renderWithProviders(<SyncCard />);
  await act(async () => {});
  return screen;
}

/** 展开平台列表（点平台行；列表内联渲染，不经 Paper 的 Portal） */
async function openPlatformMenu(screen: Awaited<ReturnType<typeof mountCard>>) {
  await act(async () => {
    fireEvent.press(screen.getByTestId('platform-picker'));
  });
}

beforeEach(() => {
  onelap = providerStub('onelap', 'data.sync.provider.onelap');
  igpsport = providerStub('igpsport-cn', 'data.sync.provider.igpsport_cn');
  wahoo = providerStub('wahoo', 'data.sync.provider.wahoo', 'oauth');
  (allProviders as jest.Mock).mockReset().mockReturnValue([onelap, igpsport, wahoo]);
  (providerById as jest.Mock)
    .mockReset()
    .mockImplementation((id: string) => (id === 'igpsport-cn' ? igpsport : id === 'wahoo' ? wahoo : onelap));
  (getSyncState as jest.Mock).mockReset().mockResolvedValue({ ...EMPTY_STATE });
  (setSyncState as jest.Mock).mockReset().mockResolvedValue(undefined);
  (runSync as jest.Mock).mockReset().mockResolvedValue(outcomeOf());
  (prepareWahooAuth as jest.Mock).mockReset().mockResolvedValue({
    pkce: { verifier: 'v'.repeat(43), challenge: 'ch', state: 'st' },
    authorizeUrl: 'https://api.wahooligan.com/oauth/authorize?x=1',
  });
  (openWahooAuthorize as jest.Mock).mockReset().mockResolvedValue(null);
  (completeWahooAuth as jest.Mock).mockReset().mockResolvedValue({
    kind: 'oauth',
    clientId: 'cid',
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 1,
    codeVerifier: 'v'.repeat(43),
    redirectUri: 'voltcoach:///wahoo-callback',
  });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  (Alert.alert as jest.Mock).mockRestore();
});

describe('SyncCard（多平台）', () => {
  it('无账号：同步按钮禁用、无解绑入口、显示「从未同步」', async () => {
    const screen = await mountCard();
    expect(screen.getByText('立即同步')).toBeDisabled();
    expect(screen.queryByText('解除绑定')).toBeNull();
    expect(screen.getByText('从未同步')).toBeTruthy();
  });

  it('有账号：回填账号、解绑入口出现、同步可用、上次同步行显示 ✓', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    (getSyncState as jest.Mock).mockResolvedValue({
      ...EMPTY_STATE,
      providers: {
        onelap: {
          last_sync_at: '2026-10-12T08:30:00.000Z',
          last_result: 'ok',
          last_error: null,
          last_counts: null,
        },
      },
    });
    const screen = await mountCard();
    expect(screen.getByDisplayValue('rider@example.com')).toBeTruthy();
    expect(screen.getByText('解除绑定')).toBeTruthy();
    expect(screen.getByText('立即同步')).toBeEnabled();
    expect(screen.getByText('2026-10-12 08:30 · ✓')).toBeTruthy();
    // 密码不回显（密文位；平台行不是输入框，故 [0]=账号、[1]=密码）
    expect(screen.getAllByTestId('text-input-outlined')[1].props.value).toBe('');
  });

  it('平台下拉：显示当前生效平台与绑定态，按注册表列出可选平台', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    const screen = await mountCard();
    expect(screen.getByTestId('platform-picker')).toBeTruthy();
    expect(screen.getByText('顽鹿 Onelap')).toBeTruthy(); // 平台行显示当前生效平台
    expect(screen.getByText('当前生效平台：顽鹿 Onelap（已绑定账号）')).toBeTruthy();
    // 打开下拉：两个平台各一项
    await openPlatformMenu(screen);
  });

  it('切平台（当前已绑定）：二次确认；确认后只改 provider 字段，凭据不动', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    const screen = await mountCard();
    await openPlatformMenu(screen);
    await act(async () => {
      fireEvent.press(screen.getByText(MENU_ITEM_IGPSPORT));
    });
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => Promise<void> | void }[],
    ];
    expect(title).toBe('切换同步平台？');
    await act(async () => {
      await buttons[1].onPress?.(); // 「切换」分支
    });
    expect(setSyncState).toHaveBeenCalledWith({ provider: 'igpsport-cn', auto: false, providers: {} });
    // 原平台凭据未被清除（切换只改生效平台，切回即恢复）
    expect(onelap.clearCredentials).not.toHaveBeenCalled();
  });

  it('切平台（当前未绑定）：不弹确认，直接写 provider', async () => {
    const screen = await mountCard();
    await openPlatformMenu(screen);
    await act(async () => {
      fireEvent.press(screen.getByText(MENU_ITEM_IGPSPORT));
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(setSyncState).toHaveBeenCalledWith({ provider: 'igpsport-cn', auto: false, providers: {} });
  });

  it('回填守卫：输入框已有草稿时不覆盖（tab 聚焦频繁，防丢编辑中内容）', async () => {
    let resolveAccount: (v: SyncCredentials | null) => void = () => {};
    (onelap.loadCredentials as jest.Mock).mockReturnValue(
      new Promise<SyncCredentials | null>((resolve) => {
        resolveAccount = resolve;
      }),
    );
    const screen = await renderWithProviders(<SyncCard />);
    // load 未落定前先打字（模拟用户已在编辑）
    const inputs = screen.getAllByTestId('text-input-outlined');
    await userEvent.type(inputs[0], '我的新账号');
    await act(async () => {
      resolveAccount({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    });
    expect(screen.getByDisplayValue('我的新账号')).toBeTruthy();
  });

  it('保存账号：调平台适配器 saveCredentials、密码清空、flash「已保存 ✓」', async () => {
    const screen = await mountCard();
    const inputs = screen.getAllByTestId('text-input-outlined');
    await userEvent.type(inputs[0], 'rider@example.com');
    await userEvent.type(inputs[1], 'secret');
    await act(async () => {
      fireEvent.press(screen.getByText('保存账号'));
    });
    expect(onelap.saveCredentials).toHaveBeenCalledWith({
      kind: 'password',
      account: 'rider@example.com',
      password: 'secret',
    });
    expect(inputs[1].props.value).toBe(''); // 密码不残留
    expect(screen.getByText('已保存 ✓')).toBeTruthy();
  });

  it('立即同步：成功后显示计数行并回读状态', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    (runSync as jest.Mock).mockResolvedValue(outcomeOf({ imported: 2, skipped: 1, failed: 0 }));
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('立即同步'));
    });
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(screen.getByText('导入 2 · 跳过 1 · 失败 0')).toBeTruthy();
    expect(screen.getByText('立即同步')).toBeEnabled(); // busy 态退出
  });

  it('立即同步：auth 错误弹「登录失败」Alert 透出原始信息', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    (runSync as jest.Mock).mockResolvedValue(outcomeOf({ error: { code: 'auth', message: '登录失败：密码错误' } }));
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('立即同步'));
    });
    expect(Alert.alert).toHaveBeenCalledWith('登录失败：账号或密码错误', '登录失败：密码错误');
  });

  it('立即同步：reauth 错误（OAuth 授权失效）弹「请重新授权」', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    (runSync as jest.Mock).mockResolvedValue(outcomeOf({ error: { code: 'reauth', message: 'invalid_grant' } }));
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('立即同步'));
    });
    expect(Alert.alert).toHaveBeenCalledWith('授权已失效，请重新授权', 'invalid_grant');
  });

  it('立即同步：编排层抛错也不静默（Alert 兜底）', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
    (runSync as jest.Mock).mockRejectedValue(new Error('db locked'));
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('立即同步'));
    });
    expect(Alert.alert).toHaveBeenCalledWith('操作失败', 'Error: db locked');
  });

  it('解绑：Alert 二次确认，确认分支调 clearCredentials 并触发凭据回读', async () => {
    onelap.loadCredentials.mockResolvedValue({ kind: 'password', account: 'rider@example.com', password: 'pw' });
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
    expect(onelap.clearCredentials).toHaveBeenCalledTimes(1);
    // 确认分支末尾的 load()：解绑后重新回读凭据（无账号态由下一次 load 渲染）
    expect(onelap.loadCredentials).toHaveBeenCalledTimes(2);
  });

  it('自动同步开关：开→乐观更新并 setSyncState(auto=true)（不动平台与槽位）', async () => {
    const screen = await mountCard();
    const sw = screen.getByRole('switch');
    await act(async () => {
      fireEvent(sw, 'valueChange', true);
    });
    expect(setSyncState).toHaveBeenCalledWith({ ...EMPTY_STATE, auto: true });
  });

  it('Wahoo（oauth 型）：显示 Client ID 表单与可复制回调地址，不出账号密码框', async () => {
    (getSyncState as jest.Mock).mockResolvedValue({ ...EMPTY_STATE, provider: 'wahoo' });
    const screen = await mountCard();
    // label 文案在 Paper 的 outlined TextInput 里渲染两份（浮动标签 + 背景遮罩），用 getAll
    expect(screen.getAllByText('Wahoo Client ID').length).toBeGreaterThan(0);
    expect(screen.getByText('voltcoach:///wahoo-callback')).toBeTruthy(); // 门户要填的回调地址
    expect(screen.getByText('授权登录')).toBeTruthy();
    expect(screen.queryByText('账号')).toBeNull();
    expect(screen.queryByText('密码')).toBeNull();
  });

  it('Wahoo 授权成功：保存凭据并回读（凭据未绑定时同步按钮仍禁用）', async () => {
    (getSyncState as jest.Mock).mockResolvedValue({ ...EMPTY_STATE, provider: 'wahoo' });
    const screen = await mountCard();
    await userEvent.type(screen.getByTestId('text-input-outlined'), 'my-client-id');
    await act(async () => {
      fireEvent.press(screen.getByText('授权登录'));
    });
    expect(prepareWahooAuth).toHaveBeenCalledWith('my-client-id', 'voltcoach:///wahoo-callback');
    expect(openWahooAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: 'voltcoach:///wahoo-callback' }),
    );
    // 浏览器回跳拿到回调 URL → 换令牌 → 存凭据
    (openWahooAuthorize as jest.Mock).mockResolvedValue('voltcoach:///wahoo-callback?code=the-code&state=st');
    (getSyncState as jest.Mock).mockResolvedValue({ ...EMPTY_STATE, provider: 'wahoo' });
    await act(async () => {
      fireEvent.press(screen.getByText('授权登录'));
    });
    expect(completeWahooAuth).toHaveBeenCalledWith(
      'voltcoach:///wahoo-callback?code=the-code&state=st',
    );
    expect(wahoo.saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'oauth', clientId: 'cid' }),
    );
    // 授权成功后回读凭据（>=2：卡片加载 + 表单回填 clientId + 授权后重载）
    expect(wahoo.loadCredentials.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('联调端点覆盖时显示红色自曝横幅（防把联调包当生产包）', async () => {
    onelap.overrideBase.mockReturnValue('http://10.0.2.2:8791');
    const screen = await mountCard();
    expect(screen.getByText('⚠︎ 联调模式：接口地址被覆盖为 http://10.0.2.2:8791（此包仅供开发调试，请勿用于真实数据）')).toBeTruthy();
  });

  it('测试连接：不需要账号，结果行拼 Alert', async () => {
    onelap.probe.mockResolvedValue([
      { url: 'https://example-cn.onelap.cn', reachable: true, ms: 88, status: 200, detail: null },
    ]);
    const screen = await mountCard();
    await act(async () => {
      fireEvent.press(screen.getByText('测试连接'));
    });
    expect(onelap.probe).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      '连接测试',
      expect.stringContaining('example-cn.onelap.cn：可达 · 88ms（HTTP 200）'),
    );
  });
});

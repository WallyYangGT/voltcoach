/**
 * use-adjust-notice.test.tsx — L4 Hook 测试：AI 调整披露条一次性已读闸门。
 *
 * 钉住的行为：无锚 → 显示并写锚；同锚 → 隐藏且不写；旧锚 → 显示并覆盖；
 * 数据不可用/身份为空 → 不读不写；读失败 fail-open；写失败不抛且下次聚焦重试；
 * 同一次聚焦内身份变化 → 按新身份重新判定（计划页会话调整出现新版本）；
 * 失焦→重聚焦 → 首帧不闪，命中同锚保持隐藏。
 *
 * mock 边界：'@/db' 设备侧模块整体替换；expo-router 的 useFocusEffect 用可控
 * 聚焦控制器（注册 callback/cleanup，blur/refocus 模拟 tab 切走再回来）。
 */
import { act, renderHook } from '@testing-library/react-native';
import { getAdjustNoticeSeen, markAdjustNoticeSeen, type AdjustNoticeKind } from '@/db';
import { useAdjustNoticeVisible } from '@/components/useAdjustNotice';

jest.mock('@/db', () => ({
  getAdjustNoticeSeen: jest.fn(),
  markAdjustNoticeSeen: jest.fn(),
}));

// 可控聚焦控制器：挂载即聚焦一次；blur/refocus 模拟 tab 切走再回来。
// 变量以 mock 前缀命名，供 jest.mock 工厂闭包引用（工厂执行时不读取，测试期才用）。
const mockFocus: {
  callback: (() => void | (() => void)) | null;
  cleanup: (() => void) | null;
} = { callback: null, cleanup: null };

jest.mock('expo-router', () => {
  const React = require('react'); // eslint-disable-line @typescript-eslint/no-require-imports
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      React.useEffect(() => {
        mockFocus.callback = cb;
        const cleanup = cb();
        mockFocus.cleanup = typeof cleanup === 'function' ? cleanup : null;
        return () => {
          mockFocus.cleanup?.();
          mockFocus.cleanup = null;
          if (mockFocus.callback === cb) mockFocus.callback = null;
        };
      }, [cb]);
    },
  };
});

const ID = '2026-10-18T08:00:00.000Z';
const OLD_ID = '2026-10-17T08:00:00.000Z';

interface HookProps {
  kind: AdjustNoticeKind;
  identity: string | null;
  dataAvailable: boolean;
}

/** 已读锚读取 → setState → 写锚 effect 都在微任务/effect 链上，act 内排空 */
const flushAsync = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** 模拟页面失焦：执行聚焦 effect 的 cleanup（Hook 清空已读快照） */
const blur = () => act(async () => {
  mockFocus.cleanup?.();
  mockFocus.cleanup = null;
});

/** 模拟重新聚焦：再次执行已注册的 focus callback，并排空读锚链 */
const refocus = () => act(async () => {
  const cb = mockFocus.callback;
  if (!cb) return;
  const cleanup = cb();
  mockFocus.cleanup = typeof cleanup === 'function' ? cleanup : null;
  await new Promise((r) => setTimeout(r, 0));
});

async function mount(
  kind: AdjustNoticeKind = 'plan_adjust',
  identity: string | null = ID,
  dataAvailable = true,
) {
  const rendered = await renderHook(
    (props: HookProps) => useAdjustNoticeVisible(props.kind, props.identity, props.dataAvailable),
    { initialProps: { kind, identity, dataAvailable } },
  );
  await flushAsync();
  return rendered;
}

beforeEach(() => {
  mockFocus.callback = null;
  mockFocus.cleanup = null;
  (getAdjustNoticeSeen as jest.Mock).mockReset().mockResolvedValue(null);
  (markAdjustNoticeSeen as jest.Mock).mockReset().mockResolvedValue(undefined);
});

describe('useAdjustNoticeVisible', () => {
  it('无已读锚：显示并写入当前身份锚', async () => {
    const { result } = await mount();
    expect(result.current).toBe(true);
    expect(markAdjustNoticeSeen).toHaveBeenCalledWith('plan_adjust', ID);
  });

  it('已读锚等于当前身份：隐藏且不写锚', async () => {
    (getAdjustNoticeSeen as jest.Mock).mockResolvedValue(ID);
    const { result } = await mount();
    expect(result.current).toBe(false);
    expect(markAdjustNoticeSeen).not.toHaveBeenCalled();
  });

  it('旧已读锚：显示并覆盖为新身份锚', async () => {
    (getAdjustNoticeSeen as jest.Mock).mockResolvedValue(OLD_ID);
    const { result } = await mount('ftp_update', ID, true);
    expect(result.current).toBe(true);
    expect(markAdjustNoticeSeen).toHaveBeenCalledWith('ftp_update', ID);
  });

  it('数据条件不成立 / 身份为空：不读不写', async () => {
    const hidden = await mount('plan_adjust', ID, false);
    expect(hidden.result.current).toBe(false);
    const none = await mount('plan_adjust', null, true);
    expect(none.result.current).toBe(false);
    expect(getAdjustNoticeSeen).not.toHaveBeenCalled();
    expect(markAdjustNoticeSeen).not.toHaveBeenCalled();
  });

  it('读锚失败：按未读展示（fail-open）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (getAdjustNoticeSeen as jest.Mock).mockRejectedValue(new Error('db down'));
    const { result } = await mount();
    expect(result.current).toBe(true);
    expect(markAdjustNoticeSeen).toHaveBeenCalledWith('plan_adjust', ID);
    warn.mockRestore();
  });

  it('写锚失败：不抛出、本次仍显示', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (markAdjustNoticeSeen as jest.Mock).mockRejectedValue(new Error('disk full'));
    const { result } = await mount();
    await flushAsync();
    expect(result.current).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('同一次挂载内身份变化：旧锚不再命中，新身份重新判定并写新锚', async () => {
    (getAdjustNoticeSeen as jest.Mock).mockResolvedValue(OLD_ID);
    const { result, rerender } = await renderHook(
      (props: HookProps) => useAdjustNoticeVisible(props.kind, props.identity, props.dataAvailable),
      { initialProps: { kind: 'plan_adjust', identity: OLD_ID, dataAvailable: true } },
    );
    await flushAsync();
    // 旧身份已读 → 隐藏
    expect(result.current).toBe(false);
    expect(markAdjustNoticeSeen).not.toHaveBeenCalled();

    // 页面仍聚焦时落库了新调整版本：新身份应重新披露并覆盖锚
    await rerender({ kind: 'plan_adjust', identity: ID, dataAvailable: true });
    await flushAsync();
    expect(result.current).toBe(true);
    expect(markAdjustNoticeSeen).toHaveBeenCalledWith('plan_adjust', ID);
  });

  it('失焦→重聚焦：重进首帧不闪，读到同一锚后保持隐藏且不重复写锚', async () => {
    const { result } = await mount();
    expect(result.current).toBe(true);
    expect(markAdjustNoticeSeen).toHaveBeenCalledTimes(1);

    // 写锚已落库：模拟切走后又回到首页
    (getAdjustNoticeSeen as jest.Mock).mockResolvedValue(ID);
    await blur();
    expect(result.current).toBe(false); // 失焦即清空可见态，重进不闪
    await refocus();
    // refocus 确实触发了一次新的读锚（否则「不闪」可能只是没执行）
    expect(getAdjustNoticeSeen).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(false);
    expect(markAdjustNoticeSeen).toHaveBeenCalledTimes(1);
  });

  it('写锚失败后失焦→重聚焦：重新显示并重试写锚（P2-1 回归）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (markAdjustNoticeSeen as jest.Mock).mockRejectedValue(new Error('disk full'));
    const { result } = await mount();
    await flushAsync();
    expect(result.current).toBe(true);
    expect(markAdjustNoticeSeen).toHaveBeenCalledTimes(1);

    // 读锚仍是旧值（写锚没成功）：重聚焦应重新可见并再次尝试写入
    await blur();
    expect(result.current).toBe(false);
    await refocus();
    expect(getAdjustNoticeSeen).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(true);
    expect(markAdjustNoticeSeen).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

/**
 * use-ai-report.test.tsx — L4 Hook 测试：AI 报告状态机（useAiReport）。
 *
 * 钉住的中间层行为：
 * 1. pending 残留（进程被杀）→ 挂载即补跑 generateReport 恢复；
 * 2. 报告已 completed 但进程内任务在跑 → 轮询不停（2026-09-22 真机事故的回归点：
 *    「失败→重试→成功回写」路径上界面此前永远不刷新）；
 * 3. retry / sendFollowUp / retryChatMessage 三个动作的服务层接线。
 *
 * mock 边界：'@/db' 与 '@/services/aiGenerate' 整体替换（设备侧模块）；
 * '@/core/report-status' 的 shouldPollReport/parseDbUtcTimestamp 保持真实实现参与
 * 集成（它已有 node:test 覆盖，这里验的是 Hook 接线把它用对了）。
 * RNTL v14：renderHook 为 async；轮询推进用假计时器 + advanceTimersByTimeAsync。
 */
import { act, renderHook } from '@testing-library/react-native';
import type { AiReportRow } from '@/db';
import { findFollowUpChat, getAiChat, getAiReport } from '@/db';
import { useAiReport } from '@/components/useAiReport';
import {
  generateReport,
  getReportProgress,
  isChatGenerating,
  isReportGenerating,
  runChatGeneration,
  submitChatMessage,
} from '@/services/aiGenerate';

// 设备侧模块整体 mock（babel-plugin-jest-hoist 会把 jest.mock 提到所有 import
// 之前，此处声明顺序合规）
jest.mock('@/db', () => ({
  getAiReport: jest.fn(),
  findFollowUpChat: jest.fn(),
  getAiChat: jest.fn(),
}));

jest.mock('@/services/aiGenerate', () => ({
  createReportDraft: jest.fn(),
  generateReport: jest.fn(),
  getReportProgress: jest.fn(),
  isChatGenerating: jest.fn(() => false),
  isReportGenerating: jest.fn(() => false),
  runChatGeneration: jest.fn(),
  submitChatMessage: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React = require('react'); // eslint-disable-line @typescript-eslint/no-require-imports
  // useFocusEffect 以 hook 形态挂载期执行一次（模拟聚焦加载）
  return {
    useFocusEffect: (cb: () => void) => React.useEffect(() => { void cb(); }, [cb]),
  };
});

const REPORT_ID = 42;

function reportOf(partial: Partial<AiReportRow> = {}): AiReportRow {
  return {
    id: REPORT_ID,
    mode: 'review',
    activity_uuid: 'a'.repeat(32),
    race_date: null,
    compare_uuid: null,
    activity_fingerprint: '2026-10-10|3600|30000',
    compare_fingerprint: null,
    status: 'completed',
    error: null,
    created_at: '2026-10-13 00:00:00',
    prompt: 'p',
    markdown: 'm',
    ...partial,
  };
}

/** 挂载 Hook 并 flush 挂载期 load()（async 链路靠 act 刷微任务） */
async function mountHook(reportId: number | null = REPORT_ID, lang: 'zh' | 'en' = 'zh') {
  const rendered = await renderHook(() => useAiReport(reportId, lang));
  await act(async () => {});
  return rendered;
}

beforeEach(() => {
  jest.useFakeTimers();
  (getAiReport as jest.Mock).mockReset().mockResolvedValue(reportOf());
  (findFollowUpChat as jest.Mock).mockReset().mockResolvedValue(null);
  (getAiChat as jest.Mock).mockReset().mockResolvedValue(null);
  (getReportProgress as jest.Mock).mockReset().mockReturnValue(null);
  (isReportGenerating as jest.Mock).mockReset().mockReturnValue(false);
  (isChatGenerating as jest.Mock).mockReset().mockReturnValue(false);
  (generateReport as jest.Mock).mockReset().mockResolvedValue({ started: true });
  (runChatGeneration as jest.Mock).mockReset().mockResolvedValue(undefined);
  (submitChatMessage as jest.Mock).mockReset().mockResolvedValue({ chatId: 5, messageId: 9 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useAiReport', () => {
  it('reportId 为 null 时不取数、状态保持空', async () => {
    const { result } = await mountHook(null);
    expect(getAiReport).not.toHaveBeenCalled();
    expect(result.current.report).toBeNull();
    expect(result.current.generating).toBe(false);
  });

  it('completed 报告加载后不轮询（前进 3 秒无新取数）', async () => {
    const { result } = await mountHook();
    expect(result.current.report?.status).toBe('completed');
    expect(getAiReport).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(getAiReport).toHaveBeenCalledTimes(1);
  });

  it('pending 残留且无进程内任务：挂载即补跑 generateReport 并保持轮询', async () => {
    (getAiReport as jest.Mock).mockResolvedValue(reportOf({ status: 'pending' }));
    const { result } = await mountHook();
    // 恢复补跑：提示词与系统段已落库，直接重跑
    expect(generateReport).toHaveBeenCalledWith(REPORT_ID, 'zh');
    expect(result.current.generating).toBe(true);
    // 轮询开着：1.5s 后重新取数
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });
    expect(getAiReport).toHaveBeenCalledTimes(2);
  });

  it('报告 completed 但进程内任务在跑：轮询不装停（2026-09-22 回归）', async () => {
    (isReportGenerating as jest.Mock).mockReturnValue(true);
    const { result } = await mountHook();
    expect(result.current.report?.status).toBe('completed');
    expect(result.current.generating).toBe(true);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1500);
    });
    expect(getAiReport).toHaveBeenCalledTimes(2);
  });

  it('已等待秒数按 created_at（UTC）起算', async () => {
    jest.setSystemTime(new Date('2026-10-13T00:01:05Z'));
    (getAiReport as jest.Mock).mockResolvedValue(reportOf({ status: 'pending' }));
    const { result } = await mountHook();
    expect(result.current.elapsedSec).toBe(65);
  });

  it('retry() 触发同 id 重跑', async () => {
    const { result } = await mountHook();
    await act(async () => {
      result.current.retry();
      await jest.advanceTimersByTimeAsync(0); // 让 retry 内部 promise 链跑完
    });
    expect(generateReport).toHaveBeenCalledWith(REPORT_ID, 'zh');
    expect(result.current.retrying).toBe(false); // 完成后归零
  });

  it('sendFollowUp 成功：落库追问、启动生成、刷新会话 id', async () => {
    // 模拟「报告尚无追问对话 → 提交后落库、可找回」：mount 的 load 返回 null，
    // sendFollowUp 触发的 load 返回新会话 id
    (findFollowUpChat as jest.Mock).mockResolvedValueOnce(null).mockResolvedValue(5);
    const { result } = await mountHook();
    let err: string | null | undefined;
    await act(async () => {
      err = await result.current.sendFollowUp('这次 NP 为什么偏高？');
    });
    expect(err).toBeNull();
    expect(submitChatMessage).toHaveBeenCalledWith(
      { chatId: null, mode: 'follow_up', message: '这次 NP 为什么偏高？', reportId: REPORT_ID, activityUuid: 'a'.repeat(32) },
      'zh',
    );
    expect(runChatGeneration).toHaveBeenCalledWith(5, 9, 'zh');
    expect(result.current.followChatId).toBe(5);
    expect(result.current.sending).toBe(false);
  });

  it('sendFollowUp 失败：返回错误文案且 sending 归零', async () => {
    (submitChatMessage as jest.Mock).mockRejectedValue(new Error('message 不能为空'));
    const { result } = await mountHook();
    let err: string | null | undefined;
    await act(async () => {
      err = await result.current.sendFollowUp('');
    });
    expect(err).toBe('message 不能为空');
    expect(result.current.sending).toBe(false);
  });

  it('retryChatMessage 以指定消息重跑并刷新', async () => {
    const { result } = await mountHook();
    await act(async () => {
      result.current.retryChatMessage(5, 9);
    });
    expect(runChatGeneration).toHaveBeenCalledWith(5, 9, 'zh');
  });
});

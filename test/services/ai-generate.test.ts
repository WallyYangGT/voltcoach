/**
 * ai-generate.test.ts — AI 生成编排层（services 层可测化，A7/T3）
 *
 * 钉历史事故点（评审 A7：这一层「纯函数测不到、冒烟测不细」，P1 级修复都发生在此）：
 *  1. 双跑注册表：同一报告并发 fire 只跑一次，第二次立即返回 started=false；
 *  2. 注册表在成功/失败/取消三条路径的 finally 里都清干净（否则该报告永不再生成）；
 *  3. pendingFlush 串行链：在途的部分正文写必须**先于**终态写落地（P2-2 竞态回归：
 *     否则半成品会覆盖完整报告）；
 *  4. 取消：在跑任务 abort → 保留部分正文回写 cancelled；无在跑 → 走 db 层 pending 守卫；
 *  5. 续跑判定：窗口内 pending 补跑、窗口外跳过、未配置 AI 整体不扫（不把 pending 扫成 failed）。
 *
 * mock 边界：'@/db'（数据访问注入点）+ '@/ai/agent'（模型输出桩）+ '@/ai/keepalive'
 * （保活句柄）+ '@/records-store'（逐秒数据）。db 层自身行为由 test/db/* 真 SQL 覆盖，
 * 这里只验编排决策。
 *
 * 模块级注册表（runningReports/aborts）不提供测试重置出口（生产代码不为测试留钩子）：
 * 每个用例用**独立 reportId** 隔离，且都在用例内 await 到任务收尾（finally 清注册表）。
 */
import {
  cancelReportGeneration,
  generateReport,
  isReportGenerating,
  resumeInterruptedGenerations,
} from '@/services/aiGenerate';

// 模型输出桩（变量须以 mock 前缀命名，供 jest.mock 工厂闭包引用）
const mockCallAI = jest.fn();
const mockAcquire = jest.fn();
const mockRelease = jest.fn(async () => {});

jest.mock('@/db/client', () => ({ getDb: jest.fn() }));
jest.mock('@/db', () => ({
  getAiConfig: jest.fn(),
  getAiReport: jest.fn(),
  updateAiReport: jest.fn(),
  cancelPendingAiReport: jest.fn(),
  saveAiReport: jest.fn(),
  createPendingAiReport: jest.fn(),
  listPendingAiReportRefs: jest.fn(),
  listPendingChatMessageRefs: jest.fn(),
  cancelPendingChatMessage: jest.fn(),
  updateAiChatMessage: jest.fn(),
  addAiChatMessage: jest.fn(),
  touchAiChat: jest.fn(),
  getAiChat: jest.fn(),
  createAiChat: jest.fn(),
  listMemories: jest.fn(async () => []),
  getProfile: jest.fn(async () => null),
  getCurrentPlan: jest.fn(async () => null),
  recordPlanReportLink: jest.fn(async () => {}),
  savePlanVersion: jest.fn(async () => 1),
  getDossier: jest.fn(async () => null),
  getEffectiveAthlete: jest.fn(async () => null),
  getAthleteState: jest.fn(async () => ({ athlete: null, configured: false })),
  isFtpCalibrated: jest.fn(async () => false),
  getActivitySummary: jest.fn(async () => null),
  getActivityFileName: jest.fn(async () => null),
  listActivities: jest.fn(async () => []),
  listActivityRideKeys: jest.fn(async () => []),
  monthlySummary: jest.fn(async () => []),
  recentFormDaily: jest.fn(async () => []),
  computeForm: jest.fn(async () => null),
  cyclingSummariesSince: jest.fn(async () => []),
  getChatSummary: jest.fn(async () => null),
  saveChatSummary: jest.fn(async () => {}),
  saveMemory: jest.fn(async () => 1),
  setProfile: jest.fn(async () => ({})),
}));
jest.mock('@/ai/keepalive', () => ({
  acquireGenerationKeepAlive: (...args: unknown[]) => mockAcquire(...args),
}));
jest.mock('@/records-store', () => ({
  loadStoredRecords: jest.fn(async () => null),
}));
jest.mock('@/services/ftp-apply', () => ({ applyAiFtpUpdate: jest.fn(), undoAiFtpUpdate: jest.fn() }));
jest.mock('@/services/reanalyze', () => ({ reanalyzeActivity: jest.fn() }));
jest.mock('@/services/power-calib', () => ({
  setPowerFlagAndRefresh: jest.fn(),
  recalibrateActivityPower: jest.fn(),
}));
jest.mock('@/ai/agent', () => ({
  runAgentLoop: (...args: unknown[]) => mockCallAI(...args),
  callAI: (...args: unknown[]) => mockCallAI(...args),
}));
jest.mock('@/ai/http', () => {
  // AiCancelledError 用真实实现（取消身份靠 instanceof，桩不能替代）
  const actual = jest.requireActual('@/ai/http');
  return { ...actual, loadDefaultFetch: jest.fn(async () => jest.fn()) };
});

type DbMock = {
  getAiConfig: jest.Mock;
  getAiReport: jest.Mock;
  updateAiReport: jest.Mock;
  cancelPendingAiReport: jest.Mock;
  listPendingAiReportRefs: jest.Mock;
  listPendingChatMessageRefs: jest.Mock;
};
const dbMock = (): DbMock => jest.requireMock('@/db') as DbMock;

/** 每用例独立 reportId（模块级注册表不重置，靠 id 隔离） */
let idSeq = 100;
const newId = (): number => (idSeq += 1);

const makeReport = (id: number) => ({
  id,
  mode: 'review' as const,
  activity_uuid: 'a'.repeat(32),
  race_date: null,
  compare_uuid: null,
  activity_fingerprint: 'fp',
  compare_fingerprint: null,
  prompt: '请复盘这次训练',
  markdown: '',
  status: 'pending',
  error: null,
  created_at: '2026-10-21T00:00:00Z',
});

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  mockAcquire.mockResolvedValue({ release: mockRelease });
  dbMock().getAiConfig.mockResolvedValue({
    config: { api_key: 'sk-test', model: 'm', base_url: 'https://x', agentic: false },
    configured: true,
  });
  dbMock().getAiReport.mockImplementation(async (id: number) => makeReport(id));
  dbMock().updateAiReport.mockResolvedValue(undefined);
  dbMock().cancelPendingAiReport.mockResolvedValue(true);
  dbMock().listPendingAiReportRefs.mockResolvedValue([]);
  dbMock().listPendingChatMessageRefs.mockResolvedValue([]);
  // agentic:false → 模型输出走 callAI（非 agentic 单轮路径）
  mockCallAI.mockResolvedValue('完整报告正文');
});

describe('双跑注册表', () => {
  test('同一报告并发 fire：第二次立即返回 started=false，模型只调一次', async () => {
    const id = newId();
    let releaseFirst!: (v: string) => void;
    mockCallAI.mockImplementation(
      () => new Promise<string>((res) => { releaseFirst = res; }),
    );

    const first = generateReport(id);
    await flushMicrotasks();
    expect(isReportGenerating(id)).toBe(true);

    const second = await generateReport(id); // 第一轮还在跑
    expect(second).toEqual({ started: false });
    expect(mockCallAI).toHaveBeenCalledTimes(1);

    releaseFirst('完成');
    expect(await first).toEqual({ started: true });
  });

  test('成功后注册表清空（同一报告可再次生成）', async () => {
    const id = newId();
    await generateReport(id);
    expect(isReportGenerating(id)).toBe(false);
    expect(await generateReport(id)).toEqual({ started: true });
    expect(mockCallAI).toHaveBeenCalledTimes(2);
  });

  test('失败后注册表清空（不把报告永久锁死）', async () => {
    const id = newId();
    mockCallAI.mockRejectedValue(new Error('网关 502'));
    await generateReport(id);
    expect(isReportGenerating(id)).toBe(false);
    expect(dbMock().updateAiReport).toHaveBeenCalledWith(id, {
      status: 'failed',
      error: '网关 502',
    });
    mockCallAI.mockResolvedValue('重试成功');
    expect(await generateReport(id)).toEqual({ started: true });
  });
});

describe('成功路径的收尾口径', () => {
  test('completed 回写 + 保活 acquire/release 各一次', async () => {
    const id = newId();
    await generateReport(id);
    expect(dbMock().updateAiReport).toHaveBeenCalledWith(id, {
      markdown: '完整报告正文',
      status: 'completed',
      error: null,
    });
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('取数阶段 fast-fail（报告不存在）不 acquire 保活（不闪通知）', async () => {
    const id = newId();
    dbMock().getAiReport.mockResolvedValue(null);
    await generateReport(id);
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(dbMock().updateAiReport).toHaveBeenCalledWith(id, {
      status: 'failed',
      error: expect.any(String),
    });
    expect(isReportGenerating(id)).toBe(false);
  });
});

describe('pendingFlush 串行链（P2-2 竞态回归）', () => {
  test('在途的部分正文写先落地，终态写不得抢跑（半成品不会覆盖完整正文）', async () => {
    const id = newId();
    const order: string[] = [];
    let resolvePartial!: () => void;
    dbMock().updateAiReport.mockImplementation(
      async (_id: number, patch: { markdown?: string; status?: string }) => {
        if (patch.status === 'completed') {
          order.push('completed');
          return;
        }
        order.push('partial:start');
        await new Promise<void>((res) => { resolvePartial = res; });
        order.push('partial:end');
      },
    );
    mockCallAI.mockImplementation(
      async (
        _f: unknown,
        _c: unknown,
        _m: unknown,
        opts: { onChunk?: (d: string) => void },
      ) => {
        opts.onChunk?.('x'.repeat(300)); // 单帧越过 shouldFlushPartial 的字符阈值
        await flushMicrotasks(); // 让节流写进入在途
        return '完整正文';
      },
    );

    const run = generateReport(id);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(order).toEqual(['partial:start']); // 终态写被 pendingFlush 拦住
    resolvePartial();
    await run;
    expect(order).toEqual(['partial:start', 'partial:end', 'completed']);
  });
});

describe('取消', () => {
  test('在跑任务被取消：回写 cancelled 并保留部分正文，注册表清空', async () => {
    const id = newId();
    mockCallAI.mockImplementation(
      (
        _f: unknown,
        _c: unknown,
        _m: unknown,
        opts: { signal: AbortSignal; onChunk?: (d: string) => void },
      ) =>
        new Promise<string>((_res, rej) => {
          opts.onChunk?.('y'.repeat(300)); // 有部分正文
          opts.signal.addEventListener('abort', () => rej(opts.signal.reason));
        }),
    );

    const run = generateReport(id);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(isReportGenerating(id)).toBe(true);

    expect(await cancelReportGeneration(id)).toBe(true);
    await run;

    const cancelled = dbMock().updateAiReport.mock.calls.find(
      ([, patch]) => (patch as { status?: string }).status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    expect((cancelled![1] as { markdown?: string }).markdown).toContain('yyy'); // 部分正文保留
    expect(isReportGenerating(id)).toBe(false);
  });

  test('无在跑任务：委托 db 层 pending 守卫（不改完成/失败行）', async () => {
    const id = newId();
    dbMock().cancelPendingAiReport.mockResolvedValue(false);
    expect(await cancelReportGeneration(id)).toBe(false);
    expect(dbMock().cancelPendingAiReport).toHaveBeenCalledWith(id);
  });
});

describe('续跑判定（resumeInterruptedGenerations）', () => {
  const NOW = Date.now();

  test('窗口内 pending 补跑；窗口外跳过（不为早已放弃的任务重复烧 token）', async () => {
    const inWindow = newId();
    const outWindow = newId();
    dbMock().listPendingAiReportRefs.mockResolvedValue([
      { id: inWindow, created_at: new Date(NOW - 5 * 60_000).toISOString() },
      { id: outWindow, created_at: new Date(NOW - 90 * 60_000).toISOString() },
    ]);
    let release!: () => void;
    mockCallAI.mockImplementation(
      () => new Promise<string>((res) => { release = () => res('正文'); }),
    );

    await resumeInterruptedGenerations('zh');
    await flushMicrotasks();
    expect(isReportGenerating(inWindow)).toBe(true); // 窗口内被补跑
    expect(isReportGenerating(outWindow)).toBe(false); // 窗口外未动
    release();
    await flushMicrotasks();
  });

  test('未配置 AI 密钥：整体跳过（不把 pending 扫成 failed）', async () => {
    dbMock().getAiConfig.mockResolvedValue({
      config: { api_key: null, model: 'm', base_url: 'https://x' },
      configured: false,
    });
    dbMock().listPendingAiReportRefs.mockResolvedValue([
      { id: newId(), created_at: new Date().toISOString() },
    ]);
    await resumeInterruptedGenerations('zh');
    expect(dbMock().listPendingAiReportRefs).not.toHaveBeenCalled();
    expect(mockCallAI).not.toHaveBeenCalled();
    expect(dbMock().updateAiReport).not.toHaveBeenCalled();
  });

  test('不在窗口内的对话残留同样跳过', async () => {
    dbMock().listPendingChatMessageRefs.mockResolvedValue([
      { chat_id: 3, message_id: 30, created_at: new Date(NOW - 120 * 60_000).toISOString() },
    ]);
    await resumeInterruptedGenerations('zh');
    expect(mockCallAI).not.toHaveBeenCalled();
  });
});

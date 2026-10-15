/**
 * today-advice-card.test.tsx — L4 组件测试：首页「今日建议」卡（TodayAdviceCard）。
 *
 * 2026-10-15 用户拍板：原「本周训练计划」卡整卡并入——本测试同时钉住计划四态
 * 级联概要（valid 摘要+今天行 / upcoming 开始日 / expired 置灰+生成 CTA / 无计划
 * 两档引导+生成 CTA）、状态结论行（能练/轻松练+降级/计划休息日/已练免扰）、
 * 课表出口三分支（今天有课=看今日课表按课出表 / 无课但有未来课=看下一节课带日期 /
 * 真无课表=看建议课表兜底，真机误读回归）、深链 chat 预填、一键生成走 report 链路。
 *
 * mock 边界：'@/db' 与 '@/services/aiGenerate' 设备侧模块整体替换；expo-router 的
 * push 用模块内导出的 mock 断言（weekly-plan-card 先例）；generateWorkout 纯函数
 * 不 mock（真实出表渲染）。
 */
import React from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import { TodayAdviceCard } from '@/components/TodayAdviceCard';
import { createReportDraft, generateReport } from '@/services/aiGenerate';
import { getCurrentPlan, listAiReports, type StoredPlan } from '@/db';
import { localDay } from '@/core/local-day';
import { FORM_SIMULATION } from '@/core/settings';
import { renderWithProviders } from './helpers/render';

jest.mock('@/db', () => ({
  getCurrentPlan: jest.fn(),
  listAiReports: jest.fn(),
  setLang: jest.fn(), // 真实 '@/i18n' 顶层从 '@/db' 取 setLang——防御性补齐
}));

jest.mock('@/services/aiGenerate', () => ({
  createReportDraft: jest.fn(),
  generateReport: jest.fn(),
}));

jest.mock('expo-router', () => {
  const React = require('react'); // eslint-disable-line @typescript-eslint/no-require-imports
  const push = jest.fn();
  return {
    useRouter: () => ({ push, back: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (cb: () => void) => React.useEffect(() => { void cb(); }, [cb]),
    __mockPush: push,
  };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __mockPush: routerPush } = require('expo-router');

const REC = FORM_SIMULATION.tsb_recovery;
const LOW = FORM_SIMULATION.tsb_low;

/** 相对今天偏移 n 天的本地日历日（计划窗夹住今天，有效性判定确定化） */
const day = (offset: number) =>
  new Date(Date.parse(localDay() + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

const planFixture = (): StoredPlan => ({
  plan: {
    valid_from: day(-1),
    valid_to: day(13),
    goal: '基础期',
    sessions: [
      { date: day(0), type: 'threshold', duration_min: 75, intensity: '95–105% FTP', tss: 85, note: '3×12min 阈值' },
      { date: day(2), type: 'rest', duration_min: null, intensity: null, tss: 0, note: '休息日' },
    ],
  },
  created_at: '2026-10-13T08:00:00.000Z',
  origin: 'generate',
  source_report_id: 9,
  change_note: null,
  warnings: [],
});

const point = (tsb: number) => ({ date: localDay(), tss: 60, ctl: 50, atl: 50 - tsb, tsb });
const athlete = { ftp_watts: 220, max_hr: 190, weight_kg: 70 };

async function mountCard(props = {}) {
  const screen = await renderWithProviders(
    <TodayAdviceCard last={point(5)} athlete={athlete} trainedToday={false} {...props} />,
  );
  await act(async () => {});
  return screen;
}

beforeEach(() => {
  (getCurrentPlan as jest.Mock).mockReset().mockResolvedValue(null);
  (listAiReports as jest.Mock).mockReset().mockResolvedValue([]);
  (createReportDraft as jest.Mock).mockReset().mockResolvedValue(42);
  (generateReport as jest.Mock).mockReset().mockResolvedValue({ started: true });
  routerPush.mockClear();
});

describe('TodayAdviceCard', () => {
  it('空库（last=null）整卡隐藏', async () => {
    const screen = await renderWithProviders(
      <TodayAdviceCard last={null} athlete={athlete} trainedToday={false} />,
    );
    await act(async () => {});
    expect(screen.queryByTestId('today-advice-card')).toBeNull();
  });

  it('生效计划 + 今天质量课：本周摘要 + 今日训练内容行 + 状态结论 + 双出口 + 查看课表', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard();
    expect(screen.getByText('今日建议')).toBeTruthy();
    expect(screen.getByText('能练')).toBeTruthy();
    expect(screen.getByText(/本周 1 次课 · 计划 TSS 85/)).toBeTruthy();
    expect(screen.getByText(/今天：阈值 · .+ · TSS 85/)).toBeTruthy();
    expect(screen.getByText('查看课表')).toBeTruthy();
    expect(screen.getByText('按计划进行：阈值')).toBeTruthy();
    expect(screen.getByText('看今日课表')).toBeTruthy();
    expect(screen.getByText('和教练聊聊')).toBeTruthy();
    expect(screen.queryByText('生成计划')).toBeNull(); // 生效期不出生成 CTA
  });

  it('未开始（upcoming）：开始日期概要 + 依据行不误称「无生效计划」（真机反馈回归）+ 下一节课出口带日期', async () => {
    const fixture = planFixture();
    fixture.plan = {
      ...fixture.plan,
      valid_from: day(3),
      valid_to: day(16),
      sessions: [{ date: day(3), type: 'threshold', duration_min: 75, intensity: null, tss: 85, note: null }],
    };
    (getCurrentPlan as jest.Mock).mockResolvedValue(fixture);
    const screen = await mountCard({ last: point(8) });
    expect(screen.getByText(`${day(3)} 开始 · 共 1 次课`)).toBeTruthy();
    expect(screen.getByText('查看课表')).toBeTruthy();
    expect(screen.getByText(/计划待开始/)).toBeTruthy();
    expect(screen.queryByText(/无计划/)).toBeNull();
    expect(screen.getByText('状态不错，来场自由骑')).toBeTruthy();
    // 无课日不出兜底课表（upcoming 误落兜底分支是真机 bug 根因），转「下一节课」带日期
    expect(screen.queryByText('看今日课表')).toBeNull();
    expect(screen.queryByText('看建议课表')).toBeNull();
    expect(screen.getByText('看下一节课')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('看下一节课'));
    });
    expect(screen.getByText(/· 阈值 · 1h15 · TSS 85/)).toBeTruthy();
    expect(screen.getByText(/（周/)).toBeTruthy(); // 日期带星期
  });

  it('已过期：置灰摘要 + 一键生成 CTA 走 report 链路', async () => {
    const fixture = planFixture();
    fixture.plan = {
      ...fixture.plan,
      valid_from: day(-21),
      valid_to: day(-8),
      sessions: [{ date: day(-21), type: 'rest', duration_min: null, intensity: null, tss: 0, note: null }],
    };
    (getCurrentPlan as jest.Mock).mockResolvedValue(fixture);
    const screen = await mountCard();
    expect(screen.getByText('计划已过期')).toBeTruthy();
    expect(screen.queryByText('查看课表')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByText('生成计划'));
    });
    expect(createReportDraft).toHaveBeenCalledWith('plan', {}, 'zh');
    expect(routerPush).toHaveBeenCalledWith('/ai/session/report-42');
    expect(generateReport).toHaveBeenCalledWith(42, 'zh');
  });

  it('无计划（从未生成）：引导文案 + 一键生成 CTA；兜底出口叫「看建议课表」；深聊预填无计划上下文', async () => {
    const screen = await mountCard();
    expect(screen.getByText('还没有训练计划，让 AI 教练按你的近期负荷生成一份')).toBeTruthy();
    expect(screen.getByText('生成计划')).toBeTruthy();
    expect(screen.getByText(/无计划/)).toBeTruthy();
    expect(screen.getByText('看建议课表')).toBeTruthy(); // 兜底文案不暗示计划内容
    expect(screen.queryByText('看今日课表')).toBeNull();
    expect(screen.queryByText('看下一节课')).toBeNull(); // 无计划没有「下一节」可指
    await act(async () => {
      fireEvent.press(screen.getByText('和教练聊聊'));
    });
    const arg = routerPush.mock.calls[0][0];
    expect(arg.pathname).toBe('/ai/session/[id]');
    expect(arg.params.id).toBe('chat-new');
    expect(String(arg.params.draft)).toContain('TSB +5');
    expect(String(arg.params.draft)).toContain('暂无生效计划');
  });

  it('无计划（上次未产出有效计划）：换「重新生成」级联文案', async () => {
    (listAiReports as jest.Mock).mockResolvedValue([
      { id: 7, mode: 'plan', status: 'completed', created_at: '2026-10-12 10:00:00' },
    ]);
    const screen = await mountCard();
    expect(screen.getByText('上次未产出有效计划，重新生成一份？')).toBeTruthy();
    expect(screen.queryByText('还没有训练计划，让 AI 教练按你的近期负荷生成一份')).toBeNull();
  });

  it('轻松练档 + 质量课深负：降级提示 + 轻松骑车表（generateWorkout 真实出表）', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ last: point(REC - 5) });
    expect(screen.getByText('轻松练')).toBeTruthy();
    expect(screen.getByText('建议把阈值降为轻松骑，或顺延')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('看今日课表'));
    });
    expect(screen.getByText(/恢复骑 · 75 分钟 · 预计 TSS \d/)).toBeTruthy();
    expect(screen.getByText(/稳态 75 分钟 @ \d+–\d+W/)).toBeTruthy();
  });

  it('计划休息日（整日无课）：休息结论不出课表出口', async () => {
    const fixture = planFixture();
    fixture.plan.sessions = [
      { date: day(0), type: 'rest', duration_min: null, intensity: null, tss: 0, note: null },
    ];
    (getCurrentPlan as jest.Mock).mockResolvedValue(fixture);
    const screen = await mountCard({ last: point(10) });
    expect(screen.getByText('建议休息')).toBeTruthy();
    expect(screen.getByText('计划休息日，好好恢复')).toBeTruthy();
    expect(screen.queryByText('看今日课表')).toBeNull();
    expect(screen.queryByText('看下一节课')).toBeNull(); // 窗内没有未来课，出口隐藏
  });

  it('计划休息日 + 后面还有课：不出课表但出「下一节课」带日期', async () => {
    const fixture = planFixture();
    fixture.plan.sessions = [
      { date: day(0), type: 'rest', duration_min: null, intensity: null, tss: 0, note: null },
      { date: day(2), type: 'threshold', duration_min: 60, intensity: null, tss: 70, note: null },
    ];
    (getCurrentPlan as jest.Mock).mockResolvedValue(fixture);
    const screen = await mountCard({ last: point(10) });
    expect(screen.getByText('计划休息日，好好恢复')).toBeTruthy();
    expect(screen.queryByText('看今日课表')).toBeNull();
    expect(screen.getByText('看下一节课')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('看下一节课'));
    });
    expect(screen.getByText(/· 阈值 · 1h00 · TSS 70/)).toBeTruthy();
  });

  it('已练免扰档：不出任何出口', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ trainedToday: true });
    expect(screen.getByText('已练')).toBeTruthy();
    expect(screen.getByText('今天已练，好好恢复')).toBeTruthy();
    expect(screen.queryByText('看今日课表')).toBeNull();
    expect(screen.queryByText('和教练聊聊')).toBeNull();
  });

  it('和教练聊聊出口：draft 预填 TSB 与计划课型上下文', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ last: point(-15) });
    await act(async () => {
      fireEvent.press(screen.getByText('和教练聊聊'));
    });
    const arg = routerPush.mock.calls[0][0];
    expect(arg.pathname).toBe('/ai/session/[id]');
    expect(arg.params.id).toBe('chat-new');
    expect(String(arg.params.draft)).toContain('TSB -15');
    expect(String(arg.params.draft)).toContain('计划排了阈值');
  });

  it('深度疲劳：休息结论且不出课表', async () => {
    (getCurrentPlan as jest.Mock).mockResolvedValue(planFixture());
    const screen = await mountCard({ last: point(LOW - 5) });
    expect(screen.getByText('建议休息')).toBeTruthy();
    expect(screen.getByText('深度疲劳，建议休息')).toBeTruthy();
    expect(screen.queryByText('看今日课表')).toBeNull();
  });
});

/**
 * chat.ts — 对话系统段拼装（自 fit-reader Web 版 server.js buildChatSystemSection 平移为纯函数）。
 *
 * 每轮后台生成时按当前状态重新拼装（记忆/备注/profile 修改即时生效），历史消息只带
 * 正文；拼出的系统段以**首条 user 消息形式**注入（非 system role，与旧版口径一致）。
 * 数据（报告正文/训练 summary/记忆/背景/技能段/生效骑手参数）由编排层注入——本模块
 * 无 IO，node:test 可直接断言结构。
 *
 * E1 上下文装配（2026-10-17）：
 * - 系统段改为带 id/priority 的分段，经 assembleBudgetedSections 装配（system_max_chars）；
 * - 训练 summary 序列化超 summary_json_max_chars 时直接降 headline（不再区分轮次）；
 * - 被窗口挤出窗口的旧对话经编排层模型摘要后以 historySummary 注入（DATA:MODEL 块）；
 * - 报告正文/记忆/profile 按 S4 数据块包裹（wrapDataBlock，prompts 层负责）。
 *
 * - follow_up：快答指令 + 当前时间 + 关联报告正文（超限瘦身为首末章）+ 关联训练压缩数据
 *   （第 2 轮起降为 headline 摘要，E1）+ 训练档案段 + 工具指引 + 用户记忆段 + 历史摘要；
 * - chat：教练角色 + 指标口径 + 当前时间 + 专业知识库 + 用户背景 + 训练档案段 + 对话指令 + 工具指引 + 用户记忆段 + 历史摘要；
 * - plan：与 chat 同构，对话指令换成计划会话口径（先查计划/调整走 update_training_plan 过校验，v2 训练计划载体）。
 * 记忆段只在 agentic 模式注入——其中的 save_memory 指引依赖工具调用能力；
 * 训练档案段是本地确定性数据（非工具指引），各模式都注入。
 * 专业知识库段只注入 chat/plan 与四场景报告；follow_up 快答场景不注入。
 */

// 本模块进 node:test（L1 层），导入须用相对 .ts 路径（Node 原生跑 TS 不解析 tsconfig paths）
import { t, type Lang } from '../core/i18n.ts';
import { CONTEXT_BUDGET, type AthleteParams } from '../core/settings.ts';
import { assembleBudgetedSections, truncateTextBlock, type PromptSection } from './context.ts';
import { truncateSkillsSection } from './skills.ts';
import {
  buildAgenticSection,
  buildChatInstruction,
  buildDateSection,
  buildMemorySection,
  buildMetricGlossary,
  buildProfileSection,
  compactReportForPrompt,
  compactSummaryForPrompt,
  dataBlockNote,
  headlineSummaryForPrompt,
  ROLE,
  ROLE_EN,
  wrapDataBlock,
  type PromptMemory,
  type PromptProfile,
} from './prompts.ts';

/** 对话系统段输入（数据由编排层取好注入） */
export interface ChatSystemInput {
  mode: 'follow_up' | 'chat' | 'plan';
  /** agentic 开关（记忆段与工具指引仅开启时注入） */
  agentic: boolean;
  /** 生效骑手参数（指标口径段展示） */
  athlete: AthleteParams;
  /** 用户背景与训练目标（可空） */
  profile: PromptProfile | null;
  /** 专业知识库段（buildSkillsSection 输出；chat/plan 注入，follow_up 不注入） */
  skills: string | null;
  /** 有效记忆清单（listMemories 输出，id DESC；编排层已按相关度 rank 过） */
  memories: PromptMemory[];
  /** 当前时刻（每轮重拼，AI 对「今天」的感知始终最新） */
  now: Date;
  /** 个人训练档案段（buildDossierSection 输出，可空；两种模式都注入） */
  dossierSection?: string | null;
  /** follow_up：关联报告正文（报告可能已被滚动清理，缺则仅靠训练数据；超 6000 字符自动瘦身，硬上限 16k） */
  reportMarkdown?: string | null;
  /** follow_up：关联训练 summary（第 1 轮压缩后附上，第 2 轮起降为 headline 摘要） */
  summary?: object | null;
  /**
   * follow_up：本轮之前已完成的回答轮数（0 = 首轮）。首轮带完整压缩 summary 供
   * 模型引用细节，第 2 轮起降为 headline 摘要——历史每轮全量重发，完整 JSON 的
   * token 成本随对话轮数线性放大（架构评审 E1）。序列化仍超 summary_json_max_chars
   * 时不论轮次都降 headline。
   */
  historyTurns?: number;
  /**
   * 更早对话的滚动摘要（编排层模型生成或 digest 兜底；已挤出窗口的部分）。
   * 注入为「更早对话的要点摘要」段（DATA:MODEL 块），不参与历史消息数组。
   */
  historySummary?: string | null;
  /** 系统段字符预算（缺省 CONTEXT_BUDGET.system_max_chars；编排层按剩余请求预算传入） */
  systemMaxChars?: number;
}

/** 报告段的 S4 包裹文本（降级时只截数据块内部，保证块始终闭合） */
function reportSectionText(markdown: string, lang: Lang, maxChars?: number): string {
  const label = t(lang, 'srv.report_body');
  const note = dataBlockNote(lang);
  const body = maxChars == null
    ? compactReportForPrompt(markdown, lang)
    : truncateTextBlock(
        compactReportForPrompt(markdown, lang),
        Math.max(0, maxChars - label.length - note.length - 60),
        t(lang, 'report.tail_truncated'),
      );
  return `${label}\n${note}\n${wrapDataBlock('MODEL', body)}`;
}

/** 训练 summary 段：超过 summary_json_max_chars 时降 headline（不论轮次） */
function summarySectionText(input: ChatSystemInput, lang: Lang): string | null {
  if (!input.summary) return null;
  const choose = () =>
    (input.historyTurns ?? 0) > 0
      ? headlineSummaryForPrompt(input.summary!, lang)
      : compactSummaryForPrompt(input.summary!, lang);
  let payload = choose();
  if (JSON.stringify(payload).length > CONTEXT_BUDGET.summary_json_max_chars) {
    payload = headlineSummaryForPrompt(input.summary, lang);
  }
  return `${t(lang, 'srv.training_data')}\n` + '```json\n' + JSON.stringify(payload) + '\n```';
}

/** 历史滚动摘要段（DATA:MODEL 块） */
function historySummarySection(input: ChatSystemInput, lang: Lang): PromptSection | null {
  if (!input.historySummary) return null;
  return {
    id: 'historySummary',
    text: `${t(lang, 'chat.summary.head')}\n${dataBlockNote(lang)}\n${wrapDataBlock('MODEL', input.historySummary)}`,
    priority: 1,
  };
}

export function buildChatSystemSection(input: ChatSystemInput, lang: Lang = 'zh'): string {
  const { mode, agentic, athlete, profile, skills, memories, now } = input;
  const sections: PromptSection[] = [];
  const omission = t(lang, 'report.omitted');

  if (mode === 'follow_up') {
    sections.push({ id: 'instr', text: buildChatInstruction('follow_up', lang), priority: 0 });
    // 当前时间：追问常涉及「今天感觉如何/接下来怎么练」，先锚定日期基准
    const nowSection = buildDateSection(now, lang);
    if (nowSection) sections.push({ id: 'date', text: nowSection, priority: 0 });
    // 用户背景（含教练模式与时间预算）：追问同样受业余口径约束（2026-10-17）
    const profileSection = buildProfileSection(profile, lang);
    if (profileSection) sections.push({ id: 'profile', text: profileSection, priority: 1 });
    // 报告正文：追问以报告内容为锚（超限瘦身为首末章；S4 数据块）
    if (input.reportMarkdown) {
      const full = reportSectionText(input.reportMarkdown, lang);
      sections.push({
        id: 'report',
        text: full,
        priority: 2,
        degrade: (n) => reportSectionText(input.reportMarkdown!, lang, n),
      });
    }
    // 追问只带报告会让 AI 无法回答报告未覆盖的细节，按 activity_uuid 附训练数据——
    // 首轮压缩全量，第 2 轮起降为 headline 摘要（历史每轮重发，完整 JSON 随轮数线性烧 token）
    const summaryText = summarySectionText(input, lang);
    if (summaryText) sections.push({ id: 'summary', text: summaryText, priority: 1 });
    if (input.dossierSection) sections.push({ id: 'dossier', text: input.dossierSection, priority: 5, optional: true });
    if (agentic) {
      sections.push({ id: 'agentic', text: buildAgenticSection(lang), priority: 0 });
      // 记忆段不参与「整段丢弃」：其中的 save_memory 规则是记忆链路的使用指引，
      // 丢掉会让「记忆绝迹」复发；预算超限时优先裁 skills（priority 2）而不是记忆
      sections.push({ id: 'memory', text: buildMemorySection(memories, lang), priority: 4 });
    }
    const digest = historySummarySection(input, lang);
    if (digest) sections.push(digest);
  } else {
    // chat / plan：无报告上下文的直接对话（plan 额外带计划查询/调整指令），取数全靠 agentic 工具调用
    sections.push({ id: 'role', text: lang === 'en' ? ROLE_EN : ROLE, priority: 0 });
    sections.push({ id: 'glossary', text: buildMetricGlossary(athlete, lang), priority: 0 });
    const nowSection = buildDateSection(now, lang);
    if (nowSection) sections.push({ id: 'date', text: nowSection, priority: 0 });
    if (skills) {
      sections.push({
        id: 'skills',
        text: skills,
        priority: 2,
        degrade: (n) => truncateSkillsSection(skills, n, lang),
      });
    }
    const profileSection = buildProfileSection(profile, lang, mode === 'plan' ? 'plan' : 'other');
    if (profileSection) sections.push({ id: 'profile', text: profileSection, priority: 1 });
    if (input.dossierSection) sections.push({ id: 'dossier', text: input.dossierSection, priority: 5, optional: true });
    sections.push({ id: 'instr', text: buildChatInstruction(mode, lang), priority: 0 });
    if (agentic) {
      sections.push({ id: 'agentic', text: buildAgenticSection(lang), priority: 0 });
      // 记忆段不参与「整段丢弃」：其中的 save_memory 规则是记忆链路的使用指引，
      // 丢掉会让「记忆绝迹」复发；预算超限时优先裁 skills（priority 2）而不是记忆
      sections.push({ id: 'memory', text: buildMemorySection(memories, lang), priority: 4 });
    }
    const digest = historySummarySection(input, lang);
    if (digest) sections.push(digest);
  }

  const budget = input.systemMaxChars ?? CONTEXT_BUDGET.system_max_chars;
  const result = assembleBudgetedSections(sections, budget, omission);
  if (result.dropped.length || result.trimmed.length) {
    console.log(
      `[AI] 对话系统段预算降级：${result.chars}/${budget} 字符，丢弃=[${result.dropped.join(',')}] 截断=[${result.trimmed.join(',')}]`,
    );
  }
  if (result.chars > budget) {
    // 记忆段（save_memory 规则）不整段丢弃、skills 已按整文件裁到最小后仍超限：
    // 记录明确信号，便于排查「单轮回答极大导致历史突破 12k 下限」的极端场景
    console.warn(
      `[AI] 对话系统段仍超预算：${result.chars}/${budget} 字符（必保段+记忆规则无法再压）`,
    );
  }
  return result.text;
}

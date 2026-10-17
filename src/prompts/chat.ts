/**
 * chat.ts — 对话系统段拼装（自 fit-reader Web 版 server.js buildChatSystemSection 平移为纯函数）。
 *
 * 每轮后台生成时按当前状态重新拼装（记忆/备注/profile 修改即时生效），历史消息只带
 * 正文；拼出的系统段以**首条 user 消息形式**注入（非 system role，与旧版口径一致）。
 * 数据（报告正文/训练 summary/记忆/背景/技能段/生效骑手参数）由编排层注入——本模块
 * 无 IO，node:test 可直接断言结构。
 *
 * - follow_up：快答指令 + 当前时间 + 关联报告正文（超限瘦身为首末章）+ 关联训练压缩数据
 *   （第 2 轮起降为 headline 摘要，E1）+ 训练档案段 + 工具指引 + 用户记忆段；
 * - chat：教练角色 + 指标口径 + 当前时间 + 专业知识库 + 用户背景 + 训练档案段 + 对话指令 + 工具指引 + 用户记忆段；
 * - plan：与 chat 同构，对话指令换成计划会话口径（先查计划/调整走 update_training_plan 过校验，v2 训练计划载体）。
 * 记忆段只在 agentic 模式注入——其中的 save_memory 指引依赖工具调用能力；
 * 训练档案段是本地确定性数据（非工具指引），各模式都注入。
 * 专业知识库段只注入 chat/plan 与四场景报告；follow_up 快答场景不注入。
 */

// 本模块进 node:test（L1 层），导入须用相对 .ts 路径（Node 原生跑 TS 不解析 tsconfig paths）
import { t, type Lang } from '../core/i18n.ts';
import type { AthleteParams } from '../core/settings.ts';
import {
  buildAgenticSection,
  buildChatInstruction,
  buildDateSection,
  buildMemorySection,
  buildMetricGlossary,
  buildProfileSection,
  compactReportForPrompt,
  compactSummaryForPrompt,
  headlineSummaryForPrompt,
  ROLE,
  ROLE_EN,
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
  /** 有效记忆清单（listMemories 输出，id DESC） */
  memories: PromptMemory[];
  /** 当前时刻（每轮重拼，AI 对「今天」的感知始终最新） */
  now: Date;
  /** 个人训练档案段（buildDossierSection 输出，可空；两种模式都注入） */
  dossierSection?: string | null;
  /** follow_up：关联报告正文（报告可能已被滚动清理，缺则仅靠训练数据；超 6000 字符自动瘦身） */
  reportMarkdown?: string | null;
  /** follow_up：关联训练 summary（第 1 轮压缩后附上，第 2 轮起降为 headline 摘要） */
  summary?: object | null;
  /**
   * follow_up：本轮之前已完成的回答轮数（0 = 首轮）。首轮带完整压缩 summary 供
   * 模型引用细节，第 2 轮起降为 headline 摘要——历史每轮全量重发，完整 JSON 的
   * token 成本随对话轮数线性放大（架构评审 E1）。
   */
  historyTurns?: number;
}

export function buildChatSystemSection(input: ChatSystemInput, lang: Lang = 'zh'): string {
  const { mode, agentic, athlete, profile, skills, memories, now } = input;
  if (mode === 'follow_up') {
    let s = buildChatInstruction('follow_up', lang);
    // 当前时间：追问常涉及「今天感觉如何/接下来怎么练」，先锚定日期基准
    const nowSection = buildDateSection(now, lang);
    if (nowSection) s += `\n\n${nowSection}`;
    // 用户背景（含教练模式与时间预算）：追问同样受业余口径约束（2026-10-17）
    const profileSection = buildProfileSection(profile, lang);
    if (profileSection) s += `\n\n${profileSection}`;
    // 报告正文：追问以报告内容为锚（超限瘦身为首末章，中间章仅保留标题）
    if (input.reportMarkdown)
      s += `\n\n${t(lang, 'srv.report_body')}\n${compactReportForPrompt(input.reportMarkdown, lang)}`;
    // 追问只带报告会让 AI 无法回答报告未覆盖的细节，按 file_name 附训练数据——
    // 首轮压缩全量，第 2 轮起降为 headline 摘要（历史每轮重发，完整 JSON 随轮数线性烧 token）
    if (input.summary) {
      const payload =
        (input.historyTurns ?? 0) > 0
          ? headlineSummaryForPrompt(input.summary, lang)
          : compactSummaryForPrompt(input.summary, lang);
      s +=
        `\n\n${t(lang, 'srv.training_data')}\n` + '```json\n' +
        JSON.stringify(payload) +
        '\n```';
    }
    if (input.dossierSection) s += `\n\n${input.dossierSection}`;
    if (agentic) {
      s += '\n\n' + buildAgenticSection(lang);
      s += '\n\n' + buildMemorySection(memories, lang);
    }
    return s;
  }
  // chat / plan：无报告上下文的直接对话（plan 额外带计划查询/调整指令），取数全靠 agentic 工具调用
  const parts = [
    lang === 'en' ? ROLE_EN : ROLE,
    buildMetricGlossary(athlete, lang),
    buildDateSection(now, lang),
    skills,
    buildProfileSection(profile, lang),
    input.dossierSection ?? null,
    buildChatInstruction(mode, lang),
  ].filter(Boolean) as string[];
  if (agentic) {
    parts.push(buildAgenticSection(lang));
    parts.push(buildMemorySection(memories, lang));
  }
  return parts.join('\n\n');
}

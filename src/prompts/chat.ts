/**
 * chat.ts — 对话系统段拼装（自 fit-reader Web 版 server.js buildChatSystemSection 平移为纯函数）。
 *
 * 每轮后台生成时按当前状态重新拼装（记忆/备注/profile 修改即时生效），历史消息只带
 * 正文；拼出的系统段以**首条 user 消息形式**注入（非 system role，与旧版口径一致）。
 * 数据（报告正文/训练 summary/记忆/背景/技能段/生效骑手参数）由编排层注入——本模块
 * 无 IO，node:test 可直接断言结构。
 *
 * - follow_up：快答指令 + 当前时间 + 关联报告正文 + 关联训练压缩数据 + 工具指引 + 用户记忆段；
 * - chat：教练角色 + 指标口径 + 当前时间 + 专业知识库 + 用户背景 + 对话指令 + 工具指引 + 用户记忆段。
 * 记忆段只在 agentic 模式注入——其中的 save_memory 指引依赖工具调用能力。
 * 专业知识库段只注入 chat 与四场景报告；follow_up 快答场景不注入。
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
  compactSummaryForPrompt,
  ROLE,
  ROLE_EN,
  type PromptMemory,
  type PromptProfile,
} from './prompts.ts';

/** 对话系统段输入（数据由编排层取好注入） */
export interface ChatSystemInput {
  mode: 'follow_up' | 'chat';
  /** agentic 开关（记忆段与工具指引仅开启时注入） */
  agentic: boolean;
  /** 生效骑手参数（指标口径段展示） */
  athlete: AthleteParams;
  /** 用户背景与训练目标（可空） */
  profile: PromptProfile | null;
  /** 专业知识库段（buildSkillsSection 输出；仅 chat 注入，follow_up 不注入） */
  skills: string | null;
  /** 有效记忆清单（listMemories 输出，id DESC） */
  memories: PromptMemory[];
  /** 当前时刻（每轮重拼，AI 对「今天」的感知始终最新） */
  now: Date;
  /** follow_up：关联报告正文（报告可能已被滚动清理，缺则仅靠训练数据） */
  reportMarkdown?: string | null;
  /** follow_up：关联训练 summary（压缩后附上，供引用报告未覆盖的细节） */
  summary?: object | null;
}

export function buildChatSystemSection(input: ChatSystemInput, lang: Lang = 'zh'): string {
  const { mode, agentic, athlete, profile, skills, memories, now } = input;
  if (mode === 'follow_up') {
    let s = buildChatInstruction('follow_up', lang);
    // 当前时间：追问常涉及「今天感觉如何/接下来怎么练」，先锚定日期基准
    const nowSection = buildDateSection(now, lang);
    if (nowSection) s += `\n\n${nowSection}`;
    // 报告正文：追问以报告内容为锚
    if (input.reportMarkdown) s += `\n\n${t(lang, 'srv.report_body')}\n${input.reportMarkdown}`;
    // 追问只带报告会让 AI 无法回答报告未覆盖的细节，按 file_name 附压缩后的训练数据
    if (input.summary) {
      s +=
        `\n\n${t(lang, 'srv.training_data')}\n` + '```json\n' +
        JSON.stringify(compactSummaryForPrompt(input.summary, lang)) +
        '\n```';
    }
    if (agentic) {
      s += '\n\n' + buildAgenticSection(lang);
      s += '\n\n' + buildMemorySection(memories, lang);
    }
    return s;
  }
  // chat：无报告上下文的直接对话，取数全靠 agentic 工具调用
  const parts = [
    lang === 'en' ? ROLE_EN : ROLE,
    buildMetricGlossary(athlete, lang),
    buildDateSection(now, lang),
    skills,
    buildProfileSection(profile, lang),
    buildChatInstruction('chat', lang),
  ].filter(Boolean) as string[];
  if (agentic) {
    parts.push(buildAgenticSection(lang));
    parts.push(buildMemorySection(memories, lang));
  }
  return parts.join('\n\n');
}

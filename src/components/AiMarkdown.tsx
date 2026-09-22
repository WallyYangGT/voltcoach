/**
 * AiMarkdown — AI 报告/回答的 Markdown 渲染（暗色样式）。
 *
 * 样式口径跟随 Web 版报告排版：标题用品牌色 volt、表格细线、代码块面板底色。
 * 会话详情页与训练详情页共用，避免两处样式漂移。
 */
import React from 'react';
import Markdown from 'react-native-markdown-display';
import { palette } from '@/theme';

const mdStyles = {
  body: { color: palette.text, fontSize: 14, lineHeight: 22 },
  heading1: { color: palette.volt, fontSize: 19, fontWeight: '700' as const, marginTop: 14, marginBottom: 6 },
  heading2: { color: palette.volt, fontSize: 17, fontWeight: '700' as const, marginTop: 12, marginBottom: 5 },
  heading3: { color: palette.text, fontSize: 15, fontWeight: '700' as const, marginTop: 10, marginBottom: 4 },
  strong: { color: palette.text, fontWeight: '700' as const },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  code_inline: { color: palette.cyan, backgroundColor: palette.panel2, fontSize: 13 },
  fence: { color: palette.cyan, backgroundColor: palette.panel2, fontSize: 12, padding: 10, borderRadius: 8 },
  table: { borderWidth: 1, borderColor: palette.line, borderRadius: 6, marginVertical: 8 },
  thead: { backgroundColor: palette.panel2 },
  th: { color: palette.text, padding: 6, borderWidth: 0.5, borderColor: palette.line },
  td: { color: palette.text, padding: 6, borderWidth: 0.5, borderColor: palette.line },
  blockquote: { backgroundColor: palette.panel, borderLeftWidth: 3, borderLeftColor: palette.volt, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 6 },
  hr: { backgroundColor: palette.line, marginVertical: 10 },
  link: { color: palette.cyan },
};

export function AiMarkdown({ markdown }: { markdown: string }) {
  return <Markdown style={mdStyles}>{markdown}</Markdown>;
}

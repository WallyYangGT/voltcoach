/**
 * embed-skills.mjs — 把 src/prompts/skills/*.md 内嵌为 src/prompts/skills.ts 的字符串常量。
 *
 * 旧版（fit-reader Web 版 src/skills.js）在每次 AI 请求时实时扫描 skills/ 目录；App 无法
 * 在运行时读仓库目录，改为构建期内嵌：本脚本读 src/prompts/skills/（源文件入库），
 * 生成 src/prompts/skills.ts（SKILL_FILES 常量 + 与旧版同口径的纯函数拼装）。
 * 技能内容变更时重跑 `node scripts/embed-skills.mjs` 重新生成（产物入库）。
 *
 * ⚠️ 本脚本内嵌的代码模板必须与 src/prompts/skills.ts 的现役形态保持一致（E1 起
 * buildSkillsSection 带 maxChars 整篇省略 + truncateSkillsSection 兜底 + i18n 省略文案）。
 * 2026-10-18 曾因模板停在 E1 前形态、skills.ts 手工扩展后未回写生成器，裸跑本脚本会
 * 清掉预算代码并打断 prompts.ts 的 import——test/skills.test.mjs 的 parity 测试守卫
 * 「md ↔ 产物」同步，模板回写靠本注释与评审提醒。
 *
 * 口径与旧 loadSkills 一致：按文件名排序；`_` 前缀跳过；`.en.md` 归英文；
 * 其余归中文；标题取首个 `# ` 行并从正文剥离，缺失用文件名兜底。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'src', 'prompts', 'skills');
const outFile = path.join(root, 'src', 'prompts', 'skills.ts');

const names = fs
  .readdirSync(srcDir)
  .filter((n) => n.endsWith('.md') && !n.startsWith('_'))
  .sort();

const entry = (name, content) => `{ name: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} }`;

const zh = [];
const en = [];
for (const name of names) {
  // 换行归一化：源文件可能是 CRLF（工作区检出差异），生成物统一 LF 保证可复现
  const content = fs.readFileSync(path.join(srcDir, name), 'utf8').replace(/\r\n/g, '\n').trim();
  if (!content) continue;
  if (name.endsWith('.en.md')) en.push(entry(name, content));
  else zh.push(entry(name, content));
}

const out = `/**
 * skills.ts — 训练科学知识库（内嵌自 src/prompts/skills/，生成文件勿手改）。
 *
 * 由 scripts/embed-skills.mjs 生成：旧版 loadSkills 每次请求实时扫描 skills/ 目录，
 * App 改为构建期内嵌（口径一致：按文件名排序、_ 前缀跳过、.en.md 归英文）。
 * 技能内容变更时重跑 \`node scripts/embed-skills.mjs\` 重新生成。
 */

// E1 预算截断的省略说明文案走 i18n（core/i18n 不依赖本模块，无环）
import { t } from '../core/i18n.ts';

export type Lang = 'zh' | 'en';

/** 单个技能文件（文件名保留原命名，title 兜底用） */
export interface SkillFile {
  name: string;
  content: string;
}

export const SKILL_FILES: Record<Lang, SkillFile[]> = {
  zh: [
    ${zh.join(',\n    ')}
  ],
  en: [
    ${en.join(',\n    ')}
  ],
};

/** 从 Markdown 内容提取标题：首个 \`# \` 一级标题行，缺失返回 null（口径同旧版） */
export function extractSkillTitle(content: string): string | null {
  const m = /^#\\s+(.+)$/m.exec(content);
  return m ? m[1].trim() : null;
}

/** 去掉内容中首个 \`# \` 一级标题行（标题已用作小节标题，正文不再重复） */
export function stripSkillTitleLine(content: string): string {
  return content.replace(/^#\\s+.+\\n?/m, '').trim();
}

/** 「专业知识库」段标题与引入句（zh 与历史逐字一致，自 fit-reader Web 版 src/skills.js 平移） */
const SECTION_TEXT: Record<Lang, { head: string; intro: string }> = {
  zh: {
    head: \`## 专业知识库\`,
    intro: \`以下是本系统收录的训练科学参考资料，解读数据与撰写报告时以其口径、阈值与标准为准\` +
      \`（与「指标口径与骑手参数」段冲突时以指标口径段为准——后者反映当前骑手的实际参数）。\`,
  },
  en: {
    head: \`## Knowledge Base\`,
    intro: \`The reference material below is this system's training-science library; when interpreting data and writing reports, follow its definitions, thresholds and standards\` +
      \` (where it conflicts with the "Metrics & Athlete Parameters" section, the latter wins — it reflects the athlete's actual current parameters).\`,
  },
};

/**
 * 把技能拼成「专业知识库」提示词段；无技能时返回 null（调用方 filter(Boolean)）。
 * 全文注入：每个技能保留原 Markdown 正文，标题统一降为三级。
 * maxChars（E1 预算，CONTEXT_BUDGET.skills_max_chars）：超预算时按**整文件**装入、
 * 装不下的尾部技能整篇省略（绝不切半个文件——半篇技能比缺一篇更误导），段尾列名交代。
 * 前面的技能编号小（核心口径）优先保留。files 缺省用内嵌技能；测试可注入自定义数组
 * （口径同旧版 buildSkillsSection）。
 */
export function buildSkillsSection(lang: Lang = 'zh', files: SkillFile[] = SKILL_FILES[lang] ?? [], maxChars?: number): string | null {
  const skills: { title: string; content: string }[] = [];
  // 按文件名排序（口径同旧版 loadSkills 的 readdir 后 sort，数字前缀控制注入顺序）
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of sorted) {
    const content = f.content.trim();
    if (!content) continue;
    const title = extractSkillTitle(content);
    skills.push({
      title: title ?? f.name.replace(/\\.(?:en\\.)?md$/, ''),
      content: title ? stripSkillTitleLine(content) : content,
    });
  }
  if (!skills.length) return null;

  const T = SECTION_TEXT[lang] ?? SECTION_TEXT.zh;
  // E1 预算：整文件贪心装入，装不下的尾部整篇省略（列名交代，不切半篇）
  const omittedNames: string[] = [];
  let kept = skills;
  if (maxChars != null) {
    const overhead = (T.head.length + T.intro.length + 4) * 2; // 标题/引入/空行的保守开销
    kept = [];
    let used = overhead;
    for (const s of skills) {
      const cost = s.content.length + s.title.length + 8;
      if (kept.length && used + cost > maxChars) {
        omittedNames.push(s.title);
        continue;
      }
      kept.push(s);
      used += cost;
    }
  }
  if (!kept.length) return null;
  const body = kept.map((s) => \`### \${s.title}\\n\\n\${s.content}\`).join('\\n\\n');
  const omission = omittedNames.length
    ? '\\n\\n' + t(lang, 'skill.omitted', { names: omittedNames.join(lang === 'en' ? ', ' : '、') })
    : '';
  return \`\${T.head}\\n\\n\${T.intro}\\n\\n\${body}\${omission}\`;
}

/**
 * E1 预算兜底：把已拼好的「专业知识库」段按**整技能边界**截到 maxChars 内。
 * 装配器（assembleBudgetedSections）只能看到拼好的字符串；若直接按字符截会切出
 * 半篇技能——比缺一篇更误导。这里按 \`\\n### \` 分块，装不下的整篇省略并列名，
 * 保证任何情况下不会出现半篇技能正文。段头/引入句始终保留。
 */
export function truncateSkillsSection(
  section: string,
  maxChars: number,
  lang: Lang = 'zh',
): string {
  if (maxChars <= 0) return '';
  if (section.length <= maxChars) return section;
  const first = section.indexOf('\\n### ');
  if (first < 0) return section.slice(0, maxChars);
  const preamble = section.slice(0, first); // 段头 + 引入（不含分隔换行）
  const blocks = section
    .slice(first + 1)
    .split(/\\n### /)
    .map((b, i) => (i === 0 ? b : '### ' + b));
  const sep = lang === 'en' ? ', ' : '、';
  const titleOf = (b: string) => b.split('\\n')[0].replace(/^###\\s*/, '');
  const noteFor = (omitted: string[]) =>
    omitted.length ? '\\n\\n' + t(lang, 'skill.omitted', { names: omitted.join(sep) }) : '';

  // 贪心只收「渲染后（含省略说明）仍 ≤ maxChars」的前缀；n=10 规模下 O(n²) 可忽略
  let keptCount = 0;
  let rendered = '';
  for (let i = 0; i < blocks.length; i++) {
    const candidate = blocks.slice(0, i + 1);
    const text =
      preamble +
      '\\n\\n' +
      candidate.join('\\n\\n') +
      noteFor(blocks.slice(i + 1).map(titleOf));
    if (text.length <= maxChars) {
      keptCount = i + 1;
      rendered = text;
    }
  }
  if (keptCount > 0) return rendered;
  // 连一篇技能都放不下：返回最小省略说明（只列技能名）；仍超则硬截说明本身
  const minNote = t(lang, 'skill.omitted', { names: blocks.map(titleOf).join(sep) });
  return minNote.length <= maxChars ? minNote : minNote.slice(0, maxChars);
}
`;

fs.writeFileSync(outFile, out, 'utf8');
console.log(`已生成 ${path.relative(root, outFile)}：zh ${zh.length} 篇 / en ${en.length} 篇`);

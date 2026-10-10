/**
 * embed-skills.mjs — 把 src/prompts/skills/*.md 内嵌为 src/prompts/skills.ts 的字符串常量。
 *
 * 旧版（fit-reader Web 版 src/skills.js）在每次 AI 请求时实时扫描 skills/ 目录；App 无法
 * 在运行时读仓库目录，改为构建期内嵌：本脚本读 src/prompts/skills/（源文件入库），
 * 生成 src/prompts/skills.ts（SKILL_FILES 常量 + 与旧版同口径的纯函数拼装）。
 * 技能内容变更时重跑 `node scripts/embed-skills.mjs` 重新生成（产物入库）。
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
  const content = fs.readFileSync(path.join(srcDir, name), 'utf8').trim();
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

/** 「专业知识库」段标题与引入句（zh 与历史逐字一致，自 reference/src/skills.js 平移） */
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
 * files 缺省用内嵌技能；测试可注入自定义数组（口径同旧版 buildSkillsSection）。
 */
export function buildSkillsSection(lang: Lang = 'zh', files: SkillFile[] = SKILL_FILES[lang] ?? []): string | null {
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
  const body = skills.map((s) => \`### \${s.title}\\n\\n\${s.content}\`).join('\\n\\n');
  const T = SECTION_TEXT[lang] ?? SECTION_TEXT.zh;
  return \`\${T.head}\\n\\n\${T.intro}\\n\\n\${body}\`;
}
`;

fs.writeFileSync(outFile, out, 'utf8');
console.log(`已生成 ${path.relative(root, outFile)}：zh ${zh.length} 篇 / en ${en.length} 篇`);

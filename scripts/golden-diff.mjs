/**
 * golden-diff.mjs — 黄金 diff：真实 MAGENE 文件经 src/core 管线产出的 summary
 * 与 Docker 版基准（reference/output/*.summary.json）逐字段比对。
 *
 * 这是 M1 验收口径（MIGRATION_PLAN §8.5）：防"重写走样"的核心手段。
 * 排除字段：summary.athlete_context 的 ctl/atl/tsb/form_state/form_note——
 * 这五项是旧版入库后从训练库注入的当日 form（依赖库内历史数据），App 版由
 * 导入服务在入库阶段同样注入，不属于解析管线口径。
 *
 * 运行：npm run golden（素材 docs/sample-fit-files/ 真实数据，gitignored，本机必有）
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile } from '../src/core/analyze.ts';

const FIT_DIR = 'docs/sample-fit-files';
const GOLDEN_DIR = 'reference/output';
/** 库注入字段（非解析管线产物），比对前从两侧剔除 */
const DB_INJECTED = new Set(['ctl', 'atl', 'tsb', 'form_state', 'form_note']);

/** 递归深度比对，返回差异列表（路径 + 两侧值） */
function deepDiff(a, b, base = '') {
  const diffs = [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push({ path: base, a: `length=${a.length}`, b: `length=${b.length}` });
      return diffs;
    }
    for (let i = 0; i < a.length; i++) diffs.push(...deepDiff(a[i], b[i], `${base}[${i}]`));
    return diffs;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (base === 'athlete_context' && DB_INJECTED.has(k)) continue;
      diffs.push(...deepDiff(a[k], b[k], base ? `${base}.${k}` : k));
    }
    return diffs;
  }
  if (a !== b) diffs.push({ path: base, a, b });
  return diffs;
}

const fmt = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

/** 素材与黄金基准都是 gitignored 的本机真实数据（AGENTS.md：严禁入库），CI 上天然缺失。
 *  本机（提交门槛）缺失仍硬失败——防素材被误删后门禁静默失效；仅 CI=true 时降级为
 *  警告放行（GitHub Actions 自动注入 CI=true，见 .github/workflows/release.yml）。 */
const fixturesMissing =
  !fs.existsSync(FIT_DIR) ||
  !fs.existsSync(GOLDEN_DIR) ||
  fs.readdirSync(FIT_DIR).filter((f) => f.toLowerCase().endsWith('.fit')).length === 0;

if (fixturesMissing) {
  if (process.env.CI === 'true') {
    console.warn('⚠ 真实测试素材不在库中（gitignored）——CI 环境跳过黄金 diff 门禁（本机提交前必跑）');
    process.exit(0);
  }
  if (!fs.existsSync(FIT_DIR)) console.error(`✗ 素材目录不存在：${FIT_DIR}（真实测试素材缺失，见 AGENTS.md）`);
  else if (!fs.existsSync(GOLDEN_DIR)) console.error(`✗ 黄金基准目录不存在：${GOLDEN_DIR}（见 AGENTS.md「黄金 diff」）`);
  else console.error(`✗ ${FIT_DIR} 中没有 .fit 文件（真实测试素材缺失，见 AGENTS.md）`);
  process.exit(1);
}

const fits = fs
  .readdirSync(FIT_DIR)
  .filter((f) => f.toLowerCase().endsWith('.fit'))
  .sort();

let failed = 0;
for (const name of fits) {
  const goldenPath = path.join(GOLDEN_DIR, `${path.basename(name, '.fit')}.summary.json`);
  if (!fs.existsSync(goldenPath)) {
    console.log(`— ${name}: 无黄金基准，跳过`);
    continue;
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIT_DIR, name)));
  const t0 = Date.now();
  const { summary } = await analyzeFile({ bytes, fileName: name });
  const ms = Date.now() - t0;

  const diffs = deepDiff(summary, golden);
  if (!diffs.length) {
    console.log(`✓ ${name}: 逐字段一致（${ms}ms，date ${summary.activity.date}）`);
  } else {
    failed++;
    console.log(`✗ ${name}: ${diffs.length} 处差异（${ms}ms）`);
    for (const d of diffs.slice(0, 20)) {
      console.log(`    ${d.path}: 新端=${fmt(d.a)} vs 黄金=${fmt(d.b)}`);
    }
    if (diffs.length > 20) console.log(`    …另有 ${diffs.length - 20} 处`);
  }
}

if (failed) {
  console.error(`\n黄金 diff 未通过：${failed}/${fits.length} 个文件不一致`);
  process.exit(1);
}
console.log(`\n黄金 diff 通过：${fits.length} 个真实文件与 Docker 版 summary 逐字段一致`);

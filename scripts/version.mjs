/**
 * version.mjs — 版本单源管理（零依赖，仅 Node 内置库）
 *
 * 版本单一来源是 package.json 的 version；app.json 的 expo.version 是它的镜像。
 * 本脚本两个子命令：
 *
 *   node scripts/version.mjs bump [patch|minor|major]   双写两文件并打印新版本（默认 patch）
 *   node scripts/version.mjs check [--base <git-ref>]   校验：两文件一致、semver 合法；
 *                                                       给 --base 时再断言当前版本 > 基线版本
 *                                                       （CI 对 PR 的硬闸：忘提版号必红）
 *
 * 版本格式：严格 x.y.z 三段数字（拒前导零）。发版 tag 必须与该值一致
 * （stamp-release-version.mjs 断言）；要发预发布版本时先 bump 出稳定版本再打 tag。
 * 配套：bump 会同步 package-lock.json 的两处 version，避免无关 lock 噪音。
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const PKG_FILE = 'package.json';
const APP_FILE = 'app.json';
const LOCK_FILE = 'package-lock.json';
// 拒前导零（semver 口径：01.2.3 非法，防 parseSemver 静默归一改写）
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const readVersion = (file, jsonPath) => {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  let v;
  if (jsonPath === 'version') v = json.version;
  else v = json.expo?.version;
  return v;
};

/** x.y.z → [major, minor, patch]；格式不对返回 null */
const parseSemver = (v) => {
  if (typeof v !== 'string' || !SEMVER.test(v)) return null;
  return v.split('.').map(Number);
};

/** 三段版本比较：a>b 返回 1，a<b 返回 -1，相等 0（入参须已过 parseSemver） */
const compareSemver = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
};

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const cmd = process.argv[2];

if (cmd === 'bump') {
  const level = process.argv[3] ?? 'patch';
  if (!['patch', 'minor', 'major'].includes(level)) {
    fail(`未知级别 "${level}"——用法: node scripts/version.mjs bump [patch|minor|major]`);
  }
  const cur = parseSemver(readVersion(PKG_FILE, 'version'));
  if (!cur) fail(`${PKG_FILE} 的 version 不是 x.y.z 三段数字（现在读到的见上），请手工修正后再 bump`);
  if (level === 'major') {
    cur[0] += 1;
    cur[1] = 0;
    cur[2] = 0;
  } else if (level === 'minor') {
    cur[1] += 1;
    cur[2] = 0;
  } else {
    cur[2] += 1;
  }
  const next = cur.join('.');
  for (const [file, jsonPath] of [
    [PKG_FILE, 'version'],
    [APP_FILE, 'expo.version'],
  ]) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (jsonPath === 'version') json.version = next;
    else json.expo.version = next;
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  // package-lock.json 同步两处 version（存在才写）：不刷依赖、只改版本号，
  // 防止后续任何人 npm install 产生与提版号无关的 lock diff
  if (fs.existsSync(LOCK_FILE)) {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    lock.version = next;
    if (lock.packages && lock.packages['']) lock.packages[''].version = next;
    fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  }
  console.log(`✓ 版本已提升：${level} → ${next}（package.json + app.json 双写，package-lock 同步）`);
  console.log('  记得把 package.json / app.json / package-lock.json 都 git add 进提交（PR 的最后一个 commit）。');
} else if (cmd === 'check') {
  const baseIdx = process.argv.indexOf('--base');
  if (baseIdx > -1 && !process.argv[baseIdx + 1]) {
    // 显式给了 --base 却没给值：宁可红也不能静默跳过「领先基线」断言（fail-open）
    fail('--base 需要一个 git 引用（如 origin/main）——空值会使版本硬闸失效');
  }
  const baseRef = baseIdx > -1 ? process.argv[baseIdx + 1] : undefined;
  const pkg = parseSemver(readVersion(PKG_FILE, 'version'));
  const app = parseSemver(readVersion(APP_FILE, 'expo.version'));
  if (!pkg) fail(`${PKG_FILE} 的 version 缺失或不是 x.y.z 三段数字——运行 node scripts/version.mjs bump 修正`);
  if (!app) fail(`${APP_FILE} 的 expo.version 缺失或不是 x.y.z 三段数字——与 ${PKG_FILE} 同值即可，通常由 bump 双写维护`);
  if (compareSemver(pkg, app) !== 0) {
    fail(
      `版本漂移：${PKG_FILE}=${pkg.join('.')} 与 ${APP_FILE}=${app.join('.')} 不一致` +
        `——修复：把两处改成同值（node scripts/version.mjs bump 会双写）`,
    );
  }
  if (baseRef) {
    let baseRaw;
    try {
      baseRaw = execSync(`git show ${baseRef}:${PKG_FILE}`, { encoding: 'utf8' });
    } catch {
      fail(`基线引用 ${baseRef} 读不到 ${PKG_FILE}——确认分支已 fetch（CI 里 checkout 用 fetch-depth: 0）`);
    }
    const base = parseSemver(JSON.parse(baseRaw).version);
    if (!base) fail(`基线 ${baseRef} 的 version 不是 x.y.z——基线侧先修正`);
    if (compareSemver(pkg, base) <= 0) {
      fail(
        `版本未提升：当前 ${pkg.join('.')} ≤ 基线 ${baseRef} 的 ${base.join('.')}——` +
          `合并前最后一步请运行 node scripts/version.mjs bump 并把 package.json + ${APP_FILE} 并入提交`,
      );
    }
  }
  console.log(`✓ 版本校验通过：${pkg.join('.')}${baseRef ? `（> 基线 ${baseRef}）` : ''}`);
} else {
  console.error('用法: node scripts/version.mjs <bump [patch|minor|major] | check [--base <git-ref>]>');
  process.exit(1);
}

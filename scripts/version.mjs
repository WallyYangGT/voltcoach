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
 * 版本格式：严格 x.y.z 三段数字（发版期 prerelease 走 tag 侧，不进本文件）。
 * 配套：发版流水线在 stamp-release-version.mjs 里断言 tag == 当前版本，防 tag 漂移。
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const PKG_FILE = 'package.json';
const APP_FILE = 'app.json';
const SEMVER = /^\d+\.\d+\.\d+$/;

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
  console.log(`✓ 版本已提升：${level} → ${next}（${PKG_FILE} + ${APP_FILE} 双写）`);
  console.log('  记得 git add 这两个文件并入提交（PR 的最后一个 commit）。');
} else if (cmd === 'check') {
  const baseIdx = process.argv.indexOf('--base');
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

/**
 * stamp-release-version.mjs — 发版版本戳（CI 用，本地开发不运行）
 *
 * 用法：node scripts/stamp-release-version.mjs <versionName> <versionCode>
 *   例：node scripts/stamp-release-version.mjs 0.2.0 42
 *
 * 写入 app.json 的 expo.version（versionName，发布页展示）与
 * expo.android.versionCode（prebuild 注入 Gradle）——versionCode 用 GitHub
 * run number 单调递增，保证侧载覆盖安装不被系统以「版本不升反降」拒绝。
 * 必须在 `npx expo prebuild` 之前执行，改动才会进生成的原生工程。
 */
import fs from 'node:fs';

const [versionName, versionCode] = process.argv.slice(2);
// versionName 白名单：versionName 会进 APK 的 versionName 与产物文件名（CI 侧已把
// tag 中的 `/` 净化为 `-`），这里拦住引号/斜杠等会破坏 app.json 或文件名的输入
if (!versionName || !/^[0-9A-Za-z._-]+$/.test(versionName) || !/^\d+$/.test(versionCode ?? '')) {
  console.error('用法: node scripts/stamp-release-version.mjs <versionName> <versionCode>');
  console.error('  versionName 仅允许字母数字与 . _ -（如 0.2.0）；versionCode 为正整数');
  process.exit(1);
}

const file = 'app.json';
// tag == 版本断言：versionName 来自 tag（v1.2.3 → 1.2.3），必须等于该 commit 的
// package.json version（版本单一来源）——防「忘了提版号就打 tag」的发版漂移
const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
if (versionName !== pkgVersion) {
  console.error(`✗ tag 版本 ${versionName} ≠ package.json version ${pkgVersion}`);
  console.error('  修复：把 tag 打在版本号一致的提交上（PR 合并前最后一步 node scripts/version.mjs bump）');
  process.exit(1);
}
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
json.expo.version = versionName;
json.expo.android = { ...json.expo.android, versionCode: Number(versionCode) };
fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
console.log(`✓ app.json 版本戳：version=${versionName} versionCode=${versionCode}`);

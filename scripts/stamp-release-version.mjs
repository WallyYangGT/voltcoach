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
if (!versionName || !/^\d+$/.test(versionCode ?? '')) {
  console.error('用法: node scripts/stamp-release-version.mjs <versionName> <versionCode>');
  process.exit(1);
}

const file = 'app.json';
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
json.expo.version = versionName;
json.expo.android = { ...json.expo.android, versionCode: Number(versionCode) };
fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
console.log(`✓ app.json 版本戳：version=${versionName} versionCode=${versionCode}`);

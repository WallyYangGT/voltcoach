/**
 * check-release-bundle.mjs — 发版包体检：确认 APK 里的 JS bundle 指向真实端点
 *
 * 为什么需要它：`EXPO_PUBLIC_*` 是**打包期内联**的，而改环境变量**不会失效**
 * RN/Metro 的 bundle 缓存——先用联调变量构建、再用生产变量构建时，Gradle 可能
 * 复用上次的 bundle，"生产包"里就带着 `http://10.0.2.2:8791` 发出去了。
 * 2026-09-22 真机上真实发生过一次（App 连模拟器专用地址卡到超时），故立此门槛。
 *
 * 用法：node scripts/check-release-bundle.mjs [APK 路径或 index.android.bundle 路径]
 *   默认 android/app/build/outputs/apk/release/app-release.apk
 * 退出码：0 = 通过；1 = bundle 含模拟器地址或缺真实端点（**不要分发该包**）
 */

import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

/** 禁忌特征：模拟器/本机/LAN 的地址形态——分发包里不该出现任何一条。
 *  注意 ①：不能用 `localhost` / `http://localhost` 作禁忌词——RN 自身 bundle 里就有
 *  （实测干净生产包含 `http://localhost` 一次），只有 `127.0.0.1` 才干净。
 *  注意 ②：私网段用「前缀」匹配；`:8791` 是 mock 默认端口兜底。 */
const FORBIDDEN = [
  '10.0.2.2', // 模拟器回宿主（最典型，即使不以 URL 形式出现也要拦）
  ':8791', // mock-onelap 默认端口（换域名/换 IP 也拦得住）
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://10.',
  'https://10.',
  'http://192.168.',
  'https://192.168.',
  'http://172.',
  'https://172.',
];
/** cleartext http:// 主机白名单：默认拒绝，凡是包内出现的 http 主机都必须在表内。
 *  （实测干净生产包的 cleartext 主机恰好只有这三个，均为 RN 自带；新增条目时请先
 *  确认是依赖自带而非联调地址——这正是把判据从"列举已知 IP"升级为"默认拒绝"的价值） */
const CLEARTEXT_HOST_WHITELIST = ['localhost', 'hostname', 'fb.me'];
/** 生产端点特征（必须出现，证明用的是真实常量而非空配置） */
const REQUIRED = ['onelap.cn'];
const BUNDLE_ENTRY = 'assets/index.android.bundle';

/** 联调变量仍在环境里时，期望包内出现的就是它（用于确认"我构建的是我想要的包"） */
const devBase = process.env.EXPO_PUBLIC_ONELAP_BASE ?? null;

const target = process.argv[2] ?? path.resolve('android/app/build/outputs/apk/release/app-release.apk');
if (!fs.existsSync(target)) {
  console.error(`找不到产物：${target}\n先构建（cd android && ./gradlew assembleRelease）或传入 APK 路径。`);
  process.exit(1);
}

let bundle;
if (target.endsWith('.bundle')) {
  bundle = new Uint8Array(fs.readFileSync(target));
} else {
  const apk = new Uint8Array(fs.readFileSync(target));
  // filter：只解 bundle，避免把几十 MB 图标资源全量解压进内存
  const out = unzipSync(apk, { filter: (f) => f.name === BUNDLE_ENTRY });
  bundle = out[BUNDLE_ENTRY];
  if (!bundle) {
    console.error(`APK 里没有 ${BUNDLE_ENTRY}（assets 未打包？）: ${target}`);
    process.exit(1);
  }
}

const text = Buffer.from(bundle).toString('latin1'); // 二进制安全的关键词检索
console.log(`体检对象: ${target}`);
console.log(`bundle 大小: ${(bundle.length / 1024 / 1024).toFixed(2)} MB`);

const offenders = FORBIDDEN.filter((needle) => text.includes(needle));
const missing = REQUIRED.filter((needle) => !text.includes(needle));
// cleartext 主机全量清点（默认拒绝：白名单外一律算嫌疑，域名/公网联调地址也逃不掉）。
// 主机名限定为「字母数字点横线」——宽松字符类会匹配到 bundle 里的二进制巧合片段。
const cleartextHosts = [...new Set([...text.matchAll(/http:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => m[1]))];
const badHosts = cleartextHosts.filter((h) => !CLEARTEXT_HOST_WHITELIST.includes(h));
if (cleartextHosts.length) console.log(`cleartext http 主机: ${cleartextHosts.join('、')}`);

if (offenders.length) {
  console.error(`✗ bundle 含模拟器/局域网地址：${offenders.join('、')} —— 此包不可分发！`);
  console.error('  通常是「先联调构建、再生产构建」时复用了旧 bundle。修法：');
  console.error('    rm -rf android/app/build/generated/assets/react/release \\');
  console.error('           android/app/build/intermediates/assets/release/mergeReleaseAssets/index.android.bundle \\');
  console.error('           "$TEMP/metro-cache"');
  console.error('    cd android && ./gradlew assembleRelease');
  process.exit(1);
}
if (badHosts.length) {
  console.error(`✗ bundle 含白名单外的 cleartext http 主机：${badHosts.join('、')} —— 此包不可分发！`);
  console.error(`  分发包只允许这些 cleartext 主机（RN 自带）：${CLEARTEXT_HOST_WHITELIST.join('、')}`);
  console.error('  若确为依赖自带的新条目，请确认后加进 CLEARTEXT_HOST_WHITELIST；否则按上一条清缓存重建。');
  process.exit(1);
}
if (missing.length) {
  console.error(`✗ bundle 缺生产端点特征：${missing.join('、')}（构建异常或配置为空）`);
  process.exit(1);
}

if (devBase) {
  // 联调构建：确认包内确实指向预期的联调地址（App 数据页也会显示联调横幅）
  console.warn(`⚠ 联调变量 EXPO_PUBLIC_ONELAP_BASE=${devBase} 生效中——这是联调构建，不可用于发版`);
  if (!text.includes(devBase)) {
    console.error(`✗ 但 bundle 里找不到 ${devBase}：构建可能复用了旧 bundle，请清缓存重建`);
    process.exit(1);
  }
  console.log('✓ 联调构建自洽（含预期的联调地址，且无模拟器地址残留）');
} else {
  console.log('✓ 通过：bundle 不含模拟器地址，且含真实顽鹿端点');
}

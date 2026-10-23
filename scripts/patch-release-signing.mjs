/**
 * patch-release-signing.mjs — prebuild 后为 release 构建注入补丁（M5 签名 + 2026-10-14 arm64-only）
 *
 * 为什么是补丁脚本：android/ 是 prebuild 生成物（gitignore 不入库），直接改
 * build.gradle 不可持续；本脚本在每次 prebuild 后跑一次，把补丁块注入生成文件。
 *
 * 行为：
 *   - beta 构建变体：注入 buildTypes.beta（initWith(release) + 包名后缀 `.beta` +
 *     debug 签名）——本地测试包与正式版**并存共存**（独立包名互不冲突、数据独立
 *     沙箱），桌面名「VoltCoach β」（src/beta/res 覆盖 app_name，脚本一并写出）。
 *     用途：单机用户在正常使用正式版的同时侧载测试预发版（2026-10-14 拍板，
 *     取代「折腾 versionCode / 签名冲突」的旧思路）。构建：assembleBeta（无 flavor 时的任务名）。
 *   - arm64-only：release/beta 一律只打 arm64-v8a——现代安卓手机均为 arm64，四套
 *     ABI 的通用包 ≈52MB vs 单 ABI ≈24MB（2026-10-16 体积优化批后，开启 R8 与 .so 压缩）。debug 构建不受影响（模拟器 x86_64
 *     冒烟可用）。需要通用包时设 VOLTCOACH_UNIVERSAL_APK=1 再构建。CI 的
 *     release.yml 另有 -PreactNativeArchitectures=arm64-v8a 同口径（双保险）。
 *   - 签名：VOLTCOACH_KEYSTORE_FILE 等四个环境变量存在 → 注入 release signingConfig
 *     并把 buildTypes.release 切到它；缺省（本地构建）原样不动，仍是 debug 签名。
 *     beta 恒用 debug 签名（独立包名，签名不与正式版冲突，无需正式证书）。
 *   - beta versionCode（2026-10-23）：prebuild 模板把 versionCode 重置为 1，旧 beta
 *     （stamp 临时值等）覆盖安装会被 Android 判「降级」拒装——按 package.json 版本
 *     推导 beta 专属 versionCode（major*100000 + minor*1000 + patch，如 0.4.2 → 4002），
 *     经 applicationVariants 的 versionCodeOverride **只作用于 beta**（release 的
 *     run-number 口径由 CI 的 stamp-release-version.mjs 管理，不受影响）。提版后需
 *     重新 prebuild + 本脚本才会更新该值；同版本重复构建 versionCode 相同（同版本
 *     覆盖安装合法）。
 *   - 幂等：已注入过（有标记注释）直接跳过，可安全重复执行。
 *
 * 用法：node scripts/patch-release-signing.mjs [build.gradle 路径]
 *   默认 android/app/build.gradle（须先 npx expo prebuild --platform android）
 * 退出码：0 = 注入或跳过；1 = 文件不存在/锚点缺失（prebuild 没跑或模板变了）
 */

import fs from 'node:fs';
import path from 'node:path';

const MARKER_BEGIN = '// ==== VoltCoach release build patches（scripts/patch-release-signing.mjs 注入，勿手改） ====';
// 旧版脚本只注入签名时的标记：命中同样视为已注入（老构建目录的幂等兼容）
const LEGACY_MARKER = '// ==== VoltCoach release signing（scripts/patch-release-signing.mjs 注入，勿手改） ====';
const MARKER_END = '// ==== VoltCoach release patches end ====';
/** 锚点：prebuild 模板 android{} 内 buildTypes 之后的第一个块（注入在其前，保证
 *  补丁块在 signingConfigs/buildTypes 求值之后覆盖 release 的配置） */
const ANCHOR = '    packagingOptions {';

const target = process.argv[2] ?? 'android/app/build.gradle';
if (!fs.existsSync(target)) {
  console.error(`✗ 找不到 ${target}——先跑 npx expo prebuild --platform android --no-install`);
  process.exit(1);
}

/** package.json 版本 → beta versionCode（major*100000 + minor*1000 + patch，0.4.2 → 4002；
 *  minor ≤ 99 且 patch ≤ 999 时随 semver 严格递增，跨 major 有充足余量）。解析失败
 *  直接抛错非 0 退出——静默回落 1 会复现「降级拒装」 */
function betaVersionCodeFromPackageVersion(packageJsonPath) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(pkg.version ?? ''));
  if (!m) throw new Error(`无法从 ${packageJsonPath} 解析版本号（${pkg.version}）`);
  return Number(m[1]) * 100_000 + Number(m[2]) * 1_000 + Number(m[3]);
}
// 从 target（android/app/build.gradle）反推仓库根的 package.json（脚本默认相对 cwd，
// 从仓库根执行即成立）
const betaVersionCode = betaVersionCodeFromPackageVersion(
  path.join(path.dirname(path.resolve(target)), '..', '..', 'package.json'),
);

const gradle = fs.readFileSync(target, 'utf8');
if (gradle.includes(MARKER_BEGIN) || gradle.includes(LEGACY_MARKER)) {
  // 幂等跳过前必须校验已烘焙的 beta versionCode：--no-clean prebuild 会保留旧补丁块
  //（含旧 versionCode 字面量），提版后只跑本脚本不重新 prebuild 会静默带旧值构建
  const baked = /output\.versionCodeOverride\s*=\s*(\d+)/.exec(gradle);
  if (gradle.includes(LEGACY_MARKER) && !baked) {
    console.error(`✗ ${target} 是旧版签名补丁块（无 beta versionCode）——请重新 npx expo prebuild 后重跑本脚本`);
    process.exit(1);
  }
  if (!baked || Number(baked[1]) !== betaVersionCode) {
    console.error(
      `✗ ${target} 已烘焙的 beta versionCode（${baked ? baked[1] : '缺失'}）≠ 当前版本推导值 ${betaVersionCode}` +
        `——提版后需重新 npx expo prebuild（默认 clean）再跑本脚本，或手工同步该值`,
    );
    process.exit(1);
  }
  console.log(`✓ ${target} 已含 release 补丁块且 beta versionCode=${baked[1]} 与当前版本一致（幂等跳过）`);
  process.exit(0);
}

const enabled = process.env.VOLTCOACH_KEYSTORE_FILE != null && process.env.VOLTCOACH_KEYSTORE_FILE !== '';

/** 环境变量缺失时块体仍注入但整体 no-op（if 判空），脚本行为与构建结果解耦——
 *  本地 prebuild 后也可以先注入，构建时没设环境变量就自动回退 debug 签名 */
const block = `${MARKER_BEGIN}
// 环境开关（Gradle 配置期读取）：UNIVERSAL=1 跳过 arm64 过滤打全 ABI 通用包
def vcUniversal = System.getenv('VOLTCOACH_UNIVERSAL_APK')
// ① beta 测试变体：initWith(release) 继承 minify/proguard/JS bundle（release 同款运行时），
//    包名后缀 .beta + debug 签名 → 与正式版并存；arm64-only 同 release（UNIVERSAL 逃生口共用）。
//    matchingFallbacks：第三方 AAR 只有 release/debug 变体，beta 解析时回退到 release。
buildTypes {
    beta {
        initWith(release)
        matchingFallbacks = ['release']
        applicationIdSuffix '.beta'
        signingConfig signingConfigs.debug
        if (vcUniversal == null || vcUniversal.isEmpty()) {
            ndk {
                abiFilters "arm64-v8a"
            }
        }
    }
}
// ② arm64-only（release）：VOLTCOACH_UNIVERSAL_APK=1 时跳过
buildTypes {
    release {
        if (vcUniversal == null || vcUniversal.isEmpty()) {
            ndk {
                abiFilters "arm64-v8a"
            }
        }
    }
}
// ③ 正式签名：VOLTCOACH_KEYSTORE_FILE 存在时才启用 release 专用签名；缺省保持 debug 签名。
def vcKeystoreFile = System.getenv('VOLTCOACH_KEYSTORE_FILE')
if (vcKeystoreFile != null && !vcKeystoreFile.isEmpty()) {
    signingConfigs {
        release {
            storeFile file(vcKeystoreFile)
            storePassword System.getenv('VOLTCOACH_KEYSTORE_PASSWORD')
            keyAlias System.getenv('VOLTCOACH_KEY_ALIAS')
            keyPassword System.getenv('VOLTCOACH_KEY_PASSWORD')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
// ④ beta versionCode（只作用于 beta 变体，release 的 run-number 口径归 CI stamp 脚本）：
//    prebuild 模板恒为 1，旧 beta 覆盖装会被判「降级」拒装——按 package.json 版本推导
//    （提版后重新 prebuild + 本脚本自然递增；同版本重复构建值相同，覆盖安装合法）。
applicationVariants.all { variant ->
    if (variant.name == 'beta') {
        variant.outputs.all { output ->
            output.versionCodeOverride = ${betaVersionCode}
        }
    }
}
${MARKER_END}
`;

if (!gradle.includes(ANCHOR)) {
  console.error(`✗ ${target} 里找不到锚点行「${ANCHOR.trim()}」——prebuild 模板变了，请核对插入位置`);
  process.exit(1);
}

// 函数形式替换：块体若将来含 `$` 字符（如 Gradle 的 ${...}），字符串模式的特殊
// 替换序列（$& $' 等）会静默改写注入内容
fs.writeFileSync(target, gradle.replace(ANCHOR, () => `${block}${ANCHOR}`));

// beta 变体的桌面名：buildType 专属 sourceSet（src/beta/res）覆盖 main 的 app_name——
// 同名资源跨 sourceSet 是「覆盖」不是「冲突」；prebuild --clean 会重置 src/，本脚本重写
const betaResDir = path.join(path.dirname(target), 'src', 'beta', 'res', 'values');
fs.mkdirSync(betaResDir, { recursive: true });
fs.writeFileSync(
  path.join(betaResDir, 'strings.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- beta 测试变体桌面名（scripts/patch-release-signing.mjs 写出，勿手改）：
     与正式版同屏并存时用「β」区分；包名后缀 .beta 由 build.gradle 补丁块注入 -->
<resources>
    <string name="app_name">VoltCoach β</string>
</resources>
`,
);
console.log(
  `✓ 已注入 release 补丁（arm64-only${process.env.VOLTCOACH_UNIVERSAL_APK ? '【已跳过：UNIVERSAL】' : ''}；签名 ${
    enabled ? `正式（VOLTCOACH_KEYSTORE_FILE=${process.env.VOLTCOACH_KEYSTORE_FILE}）` : '回退 debug'
  }；beta versionCode=${betaVersionCode}）`,
);

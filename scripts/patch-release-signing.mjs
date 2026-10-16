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
 *     取代「折腾 versionCode / 签名冲突」的旧思路）。构建：assembleBetaRelease。
 *   - arm64-only：release/beta 一律只打 arm64-v8a——现代安卓手机均为 arm64，四套
 *     ABI 的通用包 ≈52MB vs 单 ABI ≈24MB（2026-10-16 体积优化批后，开启 R8 与 .so 压缩）。debug 构建不受影响（模拟器 x86_64
 *     冒烟可用）。需要通用包时设 VOLTCOACH_UNIVERSAL_APK=1 再构建。CI 的
 *     release.yml 另有 -PreactNativeArchitectures=arm64-v8a 同口径（双保险）。
 *   - 签名：VOLTCOACH_KEYSTORE_FILE 等四个环境变量存在 → 注入 release signingConfig
 *     并把 buildTypes.release 切到它；缺省（本地构建）原样不动，仍是 debug 签名。
 *     beta 恒用 debug 签名（独立包名，签名不与正式版冲突，无需正式证书）。
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

const gradle = fs.readFileSync(target, 'utf8');
if (gradle.includes(MARKER_BEGIN) || gradle.includes(LEGACY_MARKER)) {
  console.log(`✓ ${target} 已含 release 补丁块（幂等跳过；旧签名标记请手工迁移到新块）`);
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
  }）`,
);

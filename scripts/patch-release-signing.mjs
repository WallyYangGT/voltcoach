/**
 * patch-release-signing.mjs — prebuild 后为 release 构建注入正式签名配置（M5）
 *
 * 为什么是补丁脚本：android/ 是 prebuild 生成物（gitignore 不入库），直接改
 * build.gradle 不可持续；本脚本在每次 prebuild 后跑一次，把签名块注入生成文件。
 * 签名参数只从环境变量读（密钥路径/口令不落盘、不入库），与 CI 的
 * ANDROID_KEYSTORE_* Secrets 配套（见 README「发版」）。
 *
 * 行为：
 *   - VOLTCOACH_KEYSTORE_FILE 等四个环境变量存在 → 注入 release signingConfig
 *     并把 buildTypes.release 切到它；缺省（本地构建）原样不动，仍是 debug 签名。
 *   - 幂等：已注入过（有标记注释）直接跳过，可安全重复执行。
 *
 * 用法：node scripts/patch-release-signing.mjs [build.gradle 路径]
 *   默认 android/app/build.gradle（须先 npx expo prebuild --platform android）
 * 退出码：0 = 注入或跳过；1 = 文件不存在/锚点缺失（prebuild 没跑或模板变了）
 */

import fs from 'node:fs';

const MARKER_BEGIN = '// ==== VoltCoach release signing（scripts/patch-release-signing.mjs 注入，勿手改） ====';
const MARKER_END = '// ==== VoltCoach release signing end ====';
/** 锚点：prebuild 模板 android{} 内 buildTypes 之后的第一个块（注入在其前，保证
 *  签名块在 signingConfigs/buildTypes 求值之后覆盖 release 的 signingConfig） */
const ANCHOR = '    packagingOptions {';

const target = process.argv[2] ?? 'android/app/build.gradle';
if (!fs.existsSync(target)) {
  console.error(`✗ 找不到 ${target}——先跑 npx expo prebuild --platform android --no-install`);
  process.exit(1);
}

const gradle = fs.readFileSync(target, 'utf8');
if (gradle.includes(MARKER_BEGIN)) {
  console.log(`✓ ${target} 已含 release 签名块（幂等跳过）`);
  process.exit(0);
}

const enabled = process.env.VOLTCOACH_KEYSTORE_FILE != null && process.env.VOLTCOACH_KEYSTORE_FILE !== '';
/** 环境变量缺失时块体仍注入但整体 no-op（if 判空），脚本行为与构建结果解耦——
 *  本地 prebuild 后也可以先注入，构建时没设环境变量就自动回退 debug 签名 */
const block = `${MARKER_BEGIN}
// VOLTCOACH_KEYSTORE_FILE 存在时才启用 release 专用签名；缺省保持 debug 签名（本地构建不受影响）。
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
console.log(
  enabled
    ? `✓ 已注入 release 签名配置（VOLTCOACH_KEYSTORE_FILE=${process.env.VOLTCOACH_KEYSTORE_FILE}）`
    : '✓ 已注入 release 签名配置（环境变量未设，构建时自动回退 debug 签名）',
);

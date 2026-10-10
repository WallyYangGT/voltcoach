# 备份包格式规范（.fitbackup）

> **文档地位**：本文描述 VoltCoach 备份/迁移包 `.fitbackup` 的对外格式规范，供第三方迁移工具实现互操作。实现权威在 `src/backup/`（清单校验 `manifest.ts`、打包解包 `archive.ts`、设备侧导入导出 `export.ts` / `import.ts` / `sqlite.ts`）；本文与实现不一致时以代码为准。

## 包结构

`.fitbackup` 本质是 **zip 容器**（STORE 存储，level 0——db 与 records 载荷本身已是密文/gzip，再 deflate 无收益只耗电）。固定三个部分：

```
manifest.json                       清单（见下节 schema）
fitness.db                          SQLite 整库（SQLCipher 密文或明文，见 db_key 语义）
records/<base>.records.csv.gz       逐活动逐秒数据（<base> = 训练文件名去扩展名）
```

解包端按**条目白名单**处理：只认上述三类条目，其余静默跳过；records 条目名过 basename 安全校验，防构造包的路径穿越。

## manifest.json schema

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | `"fitbackup"` | 格式标识常量——防止把任意 zip 当备份包导入 |
| `schema_version` | number（整数 ≥1） | 建库 schema 版本，导入端驱动迁移链（见「版本闸门」） |
| `app_version` | string | 导出方 App 版本（旧 Web 版 `--export` 填其 package.json version） |
| `exported_at` | string | ISO 8601 导出时间 |
| `device` | string | 导出设备描述，如 `android/Pixel_8`、`docker-web` |
| `db_key` | string \| null | 包内 db 的 SQLCipher key，语义见下节 |
| `counts.activities` | number ≥0 | 包内活动行数（导入后核对） |
| `counts.records` | number ≥0 | 包内 records 条目数 |

校验规则：字段缺失或类型不对 → 拒绝导入（错误码 `bad_manifest`）；**多余字段忽略**（向前兼容：新版 App 导出的包带新字段时，旧 App 只要 schema_version 允许仍可导入）。

## db_key 语义

- **string**：包内 `fitness.db` 是 SQLCipher 密文库，`PRAGMA key = '<db_key>'` 可直接打开。无口令导出时随包写入本机随机 key——防随手翻文件，不防拿到完整包的人（备份包与密钥同行等于明文，敏感等级等同明文导出）。
- **null**：两种情形——包内是**明文库**（旧 Web 版 `--export`、无 SQLCipher 的导出），或包内用**用户口令派生密钥**加密（导入时需用户重输口令）。manifest 层不区分这两种，由导入流程实际开库判定：明文直接开、口令库触发 `passphrase_required` 交互重试。

## schema 版本闸门

- 包内 `schema_version` **高于**本机 App → 拒绝导入（错误码 `unsupported_version`，提示升级 App）。
- 低于或等于 → 允许，导入后由开库流程跑迁移链补齐。

## 导入错误码

导入流程以**稳定错误码**上报（UI 侧映射双语词条，第三方工具可按 code 分支处理）：

| code | 含义 |
|---|---|
| `invalid_zip` | 不是合法 zip |
| `missing_manifest` | 缺 manifest.json |
| `bad_manifest` | manifest 字段缺失/类型不对/format 不符 |
| `unsupported_version` | schema 版本高于本机 |
| `missing_db` | 缺 fitness.db |
| `wrong_key` | db_key 开库失败 |
| `passphrase_required` | 需要用户输入口令（db_key=null 且非明文） |
| `safety_backup_failed` | 导入前的本机安全快照失败（中止导入，不动现有数据） |
| `no_sqlcipher` | 本机构建无 SQLCipher，无法导入密文库 |

## 互操作注意

- 导入流程是「先安全快照本机现有库 → 再解包落库」，任何一步失败都不破坏现有数据。
- records 的 CSV 列与 App 逐秒落盘格式一致（gzip 压缩），列定义以 `src/core/records.ts` 为准。
- 删除类操作不产生快照回滚（快照只保证「导入成功」与「误删可恢复」两个场景），第三方工具同步该语义时注意：**导入成功后滚动快照，删除后不滚**。

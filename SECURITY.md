# 安全策略（Security Policy）

## 报告漏洞

**请勿通过公开 Issue 报告安全漏洞。** 请发送邮件至 **wallys_studio@163.com**（或通过 GitHub 私信联系维护者），描述问题、复现方式与影响评估。会在尽快确认收到并评估处理。

## 范围说明

VoltCoach 是**纯本地**应用，处理个人运动健康数据，值得关注的攻击面：

- **FIT 文件解析**（`src/core/analyze.ts`）：FIT 文件视为不可信输入，容错解析；解析库漏洞或越界读写影响最大，欢迎 fuzz 结论。
- **备份包导入**（`src/backup/`）：`.fitbackup` 为不可信输入，已有 manifest 校验、条目白名单与路径穿越防御（格式见 [docs/BACKUP_FORMAT.md](./docs/BACKUP_FORMAT.md)）；构造包绕过防御的路径请报告。
- **BYOK AI 请求**（`src/ai/`）：请求只发往用户自配端点，凭据存 `expo-secure-store`；若发现凭据外泄路径（日志/备份包/异常携带）属高危。
- **云同步**（`src/sync/`，顽鹿 / 迹驰 iGPSPORT / Wahoo）：凭据与 OAuth 令牌只存本机（`expo-secure-store`）、不随备份包迁移；顽鹿与迹驰为社区逆向接口，接口本身不构成漏洞；Wahoo 走官方 OAuth2 + PKCE，授权回调经自定义 URL scheme（`voltcoach://`）深链进入 App——伪造回调来源、劫持回调换取授权码的路径请报告。

## 不属安全问题的

- 顽鹿/迹驰接口失效或变更（非官方接口，随时可能失效，退回手动导入）；
- 用户主动把备份包/密钥发给他人的数据暴露（密钥随包同行等同明文，属文档明示的已知边界）。

# ⏰ Actions 定时面板（panel）

类青龙面板的**前端**：上传 Python / JS / Shell 脚本、勾选预设定时、维护依赖与环境变量，
保存时通过 GitHub API 把脚本 + `config.json` + 重新生成的 workflow 一次性原子提交到**业务仓库**。

> 🔒 本仓库只承载面板页面，**不含任何脚本、配置与凭据**。业务仓库（scripts / config / workflow）独立私有。

## 使用

1. 打开 https://thanatos518.github.io/panel/ （Owner 会自动填，**仓库名填业务仓库名**，如 `tasks`）
2. 首次使用生成 fine-grained PAT（只授权**业务仓库**）：`Contents` / `Workflows` / `Secrets` 三项 Read and write
3. 连接读取配置 → 添加脚本 → 设定时/依赖/环境变量 → 保存

详细功能见业务仓库的 README。

## 与业务仓库的同步约定（改这两处必须两仓同步）

面板内嵌的 workflow 生成器（`app.js` 的 `generateWorkflow()`）与业务仓库的 `dispatcher.py` 之间有两个约定耦合点：

1. **`INPUT_SCRIPT`** 环境变量名 —— 「▶ 运行一次」按 id 单跑的入口
2. **`logs/` 与 `scripts/wb_refresh_tokens.json`** 回写路径 —— 运行日志持久化 + keepalive

改动任一侧时，另一侧必须同步更新。

## 安全说明

- PAT 仅保存在你浏览器本机的 localStorage，不进任何仓库、不上传任何服务器
- 本页面无后端、无统计、无外发请求（仅 `api.github.com` 与 CDN 加密库）
- ⚠️ 请认准本地址，仿冒页面可能窃取输入的 PAT

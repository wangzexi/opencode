# zexi/dev Fork — 与上游的差异说明

本文档记录了相对于 `anomalyco/opencode` 的每一处有意改动，以便每次 rebase 后能快速明确目标、发现回归。

---

## 如何 rebase

`sync-upstream.yml` 工作流每周五自动运行，将 `zexi/dev` rebase 到上游并开 PR。

手动整理到新分支的方法：

```sh
git fetch upstream
git checkout -b zexi/dev-clean upstream/dev
git merge --squash zexi/dev
# 解决冲突，然后按功能分组提交（参考下方提交说明）
```

---

## Fork 提交列表（相对于 upstream/dev）

### 1 · 自定义发布工作流 — `dfa2df240`

**涉及文件：** `.github/workflows/zexi-electron.yml`、`.github/workflows/sync-upstream.yml`

每次推送到 `zexi/dev` 时，自动构建并发布签名的 macOS（arm64 + 公证）和 Windows（x64 + Azure 可信签名）Electron 安装包。发布标签格式为 `zexi-electron-<时间戳>-<sha>`，只保留最近 3 个版本。

同步工作流会禁用上游所有其他工作流，只保留这两个。

**Rebase 风险：** 低 — 只涉及 `.github/`，仅当上游重命名自己的工作流文件时才会冲突。

---

### 2 · 桌面本地服务器配置 + 已开启项目同步 — `bd776bfa3`

**涉及文件：** `packages/app/src/components/dialog-select-server.tsx`、`server-row.tsx`、`status-popover*.tsx`、`packages/desktop/src/main/{index,ipc,server,sidecar,constants}.ts`、`packages/desktop/src/preload/`、`packages/opencode/src/config/{server,projects}.ts`、`packages/opencode/src/server/shared/opened-projects{,.sql}.ts`、`handlers/global.ts`、DB 迁移文件、SDK 生成文件、i18n 文件

**功能说明：**

**a) 本地服务器配置 UI**
在应用内新增 UI，允许用户配置 Electron 内嵌服务器的主机名、端口、用户名和密码。配置持久化到 Electron store 的 `localServerConfig` 字段下。新增 IPC 通道：`get-local-server-config`、`set-local-server-config`。

**b) 已开启项目同步**
将已开启项目的状态统一到 `OpenedProjectsContext`（Solid.js），由服务端 SQLite 表（`OpenedProjectTable`）持久化。所有窗口/标签页订阅 `project.opened.updated` SSE 事件，无需轮询即可实时同步。服务端在 `/global` 下提供列表、打开、关闭、重排序接口。

**Rebase 风险：** 高 — 涉及大量 app 层文件。最常见冲突点：`status-popover.tsx`、`dialog-select-server.tsx`、`handlers/global.ts` 以及 SDK 生成文件。

---

### 3 · 将 Web UI 内嵌到 sidecar 并提供服务 — `54660edfa`

**涉及文件：** `packages/core/src/flag/flag.ts`、`packages/desktop/electron-builder.config.ts`、`electron.vite.config.ts`、`prebuild.ts`、`packages/opencode/src/config/server.ts`、`packages/opencode/src/server/shared/{public-ui,ui}.ts`

**功能说明：**
构建时通过生成模块（`opencode-web-ui.gen.ts`）将 Web SPA 打包进 sidecar 二进制。sidecar 直接提供服务，优先级如下：

1. 内嵌 bundle（`opencode-web-ui.gen.ts`）— 生产环境
2. 本地目录（`OPENCODE_DEV_UI_DIR`）— 开发模式，Electron dev 时自动指向 `packages/app/dist`
3. 代理到 `https://app.opencode.ai`（可用 `OPENCODE_DEV_UI_URL` 覆盖）— 兜底

`isPublicUIPath()` 匹配的静态资源（HTML shell、JS/CSS bundle、图标、favicon）无需认证即可访问，让远程浏览器在输入密码前就能加载页面骨架。

**开发模式前提：** 需先构建 `packages/app`：
```sh
cd packages/app && bun run build
```

**Rebase 风险：** 中 — `ui.ts` 在上游重构 `serveUIEffect` 时会冲突；`flag.ts` 在上游同位置新增 flag 时会冲突。

---

### 4 · SPA 任意子路径免认证访问 + 401 显示认证提示页 — `7bac50fd8`

**涉及文件：** `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`、`server.ts`、`packages/app/src/pages/error.tsx`、`session.tsx`、`packages/app/src/i18n/{en,zh,zht}.ts`、`packages/opencode/test/server/httpapi-ui.test.ts`

**功能说明：**

**a) SPA catch-all 免认证加载**
`/*` 路由无条件响应，浏览器可在任意子路径下引导加载 SPA shell，无需服务端 session cookie。`/global/*` 和 instance 路由仍受完整保护。

**b) Bearer 认证方案**
`WWW-Authenticate` 响应头改为 `Bearer realm="Secure Area"`（原为 `Basic`），避免浏览器在 401 时弹出原生凭证对话框，同时保持服务端正常读取桌面端发来的 `Authorization: Basic` 头。

**c) 认证提示错误页**
401 时 SPA 展示本地化的"需要身份验证"页面，附带手动"返回首页"按钮，彻底消除了之前因 app 自动从 `/` 导航到最近打开项目而引发的无限重定向循环。

**d) /global/health 探针**
允许未认证的健康检查，让 SPA 在用户输入密码前就能发现服务器。若凭证已提供但有误，仍返回 401。

**Rebase 风险：** `authorization.ts` 低（小而独立）；`error.tsx` 中（上游若改动错误页结构会冲突）。

---

### 5 · 限制 diff 大小，防止大文件导致 SQLite/V8 崩溃 — `c37061538`

**涉及文件：** `packages/opencode/src/tool/apply_patch.ts`、`packages/opencode/src/tool/edit.ts`

存储前截断 patch/diff 字符串，防止超大 diff（如删除 50MB+ 二进制文件时产生的 ~380MB diff 字符串）触发 V8 内存上限，导致 sidecar 进程 SIGTRAP 崩溃。

对应上游 issue：https://github.com/anomalyco/opencode/issues/27657

**Rebase 风险：** 低 — 改动独立，不影响其他模块。

---

## 行为不变量

每次 rebase 后，发布前请验证以下场景：

| # | 场景 | 预期结果 |
|---|------|----------|
| 1 | 远程浏览器访问 `http://<host>:4096/`（无凭证） | 200，加载 UI shell，不弹出认证对话框 |
| 2 | 远程浏览器访问 `/favicon-96x96-v3.png` | 200，不需要认证 |
| 3 | SPA 无凭证访问 `/global/config` | 401，`WWW-Authenticate: Bearer …`（不是 `Basic`） |
| 4 | 无凭证访问 `http://<host>:4096/<project>/session/<id>` | 加载 SPA shell，显示认证提示页，不出现无限重定向 |
| 5 | 桌面应用左下角显示服务器图标及当前服务器地址 | 可见、可点击 |
| 6 | 点击服务器图标打开配置对话框 | 桌面模式下显示本地服务器配置面板 |
| 7 | 设置本地服务器凭证后重启，凭证保持 | 配置在重启后仍存在 |
| 8 | 在一个浏览器标签页中打开项目，其他标签页同步更新 | `project.opened.updated` 事件触发同步 |
| 9 | 开发模式下，远程浏览器看到 fork 版 UI（左下角有服务器图标） | 不是上游 `app.opencode.ai` 的版本 |

快速自动化检查（在本地 4096 端口服务运行时执行）：

```sh
# 根路径 → 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/
# Favicon → 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/favicon-96x96-v3.png
# API → 401 Bearer（不是 Basic）
curl -sI http://127.0.0.1:4096/global/config | grep -i www-authenticate
```

预期输出：`200`、`200`、`www-authenticate: Bearer realm="Secure Area"`。

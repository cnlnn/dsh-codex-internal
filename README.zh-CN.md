# DSH Codex 订阅模型提供方

[English](README.md) | 简体中文

这是一个用于 DeepSeek Harness 的轻量本地插件。它通过 OpenAI 官方 `@openai/codex-sdk` 注册真正的 `Codex` 模型提供方，让 DSH 的普通模型选择器直接使用当前 ChatGPT/Codex 订阅账号。

模型列表不是写死的。插件会读取当前 Codex 登录账号的可见模型目录，并为每个模型提供其实际支持的推理强度。

插件不自行实现 OAuth，不读取或解析 Codex 凭据文件，也不接受 API Key。ChatGPT 订阅登录和令牌刷新完全由官方 Codex CLI 负责。启动 Codex 子进程时使用环境变量白名单，避免无关 API Key、代理凭据等敏感变量被继承。

## 安全设计

- 每次模型调用均以 Codex `read-only` 沙箱运行，使用 `approvalPolicy: never`，默认禁用网络。
- DSH 的历史消息、系统指令和工具 Schema 会被投影为一个无状态 Codex 回合。
- Codex 的结构化结果会映射回 DSH 的文本、推理摘要、工具调用和用量事件。
- 插件明确要求 Codex 不使用自身的 Shell、文件系统、Web、MCP 或编辑工具；需要执行工具时，只向 DSH 返回工具调用，由 DSH 原有工具循环处理。
- SDK 强制使用 `forced_login_method = "chatgpt"`，不会静默切换到 API Key 计费。
- 运行时只依赖 OpenAI 官方 Codex 包，具体版本由 `package-lock.json` 锁定。

## 系统要求

- Linux、macOS 或原生 Windows
- x64 或 arm64
- Node.js 22.19 或更高版本
- 已安装 DeepSeek Harness Web Profile
- 运行 DSH 的同一系统用户已登录 Codex

官方 Codex npm 包会根据操作系统和 CPU 架构安装对应的原生可执行文件。

## 安装

首先确认 Codex 使用 ChatGPT 订阅登录：

```sh
codex login status
```

正常结果应包含：

```text
Logged in using ChatGPT
```

将本仓库安装到现有 DSH Web Profile。

macOS/Linux：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-internal
dsh --profile web --dump-config
dsh web
```

Windows PowerShell，路径建议使用正斜杠，避免包地址解析歧义：

```powershell
dsh plugin --profile web add "link:C:/absolute/path/to/dsh-codex-internal"
dsh --profile web --dump-config
dsh web
```

如果平时通过 `npx` 启动 DSH，请使用同一个固定版本的 DSH 包执行插件安装和 Web Profile 启动命令。

## 使用

重启 DSH 后，在普通模型选择器中选择 `Codex` 提供方，再选择当前 Codex 账号可用的模型和推理强度。普通对话会直接走 Codex，不需要 `/codex` 命令，也不会经过 GLM 或其他模型转发。

在 `设置 → Models → Codex → 模型目录` 中可以：

- 使用 `获取可用模型` 刷新当前账号的模型目录。
- 使用 `添加模型` 手工填写任意 Model ID。
- 保存额外模型，或恢复使用 Codex 实时模型目录。

手工填写的 Model ID 是否能够调用，最终仍由当前 ChatGPT/Codex 账号和官方服务决定。

## 卸载

```sh
dsh plugin --profile web remove @local/dsh-codex-internal
```

卸载会从 DSH Web Profile 中移除依赖和 bundle，但不会删除：

- 本地 Git 源码仓库
- Codex 的 ChatGPT 登录状态
- Codex 自身的历史数据

卸载后需要重启 DSH。已经打开的旧页面可能仍保留已加载的 JavaScript，刷新或关闭旧标签页即可；新启动页面不会再加载插件前端资源。

可以使用以下命令确认组合配置中已不存在插件：

```sh
dsh --profile web --dump-config
```

输出中不应再出现 `@local/dsh-codex-internal` 或 `codex-subscription-provider`。

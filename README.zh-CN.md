# DSH Codex Adapter

[English](README.md) | 简体中文

通过原生 DSH provider adapter，把官方 Codex ChatGPT 登录接入 DeepSeek Harness。插件将 ChatGPT 认证交给官方 Codex app-server 保管；DSH 中的第三方模型继续使用各自的原生 provider，不经过本插件。

这是社区集成项目，并非 OpenAI 或 DeepSeek 官方插件。

## 产品特性

- `设置 → 插件 → 插件配置 → Codex` 中的图形化 ChatGPT 登录
- 只显示登录状态和套餐，不暴露账号身份
- 支持 device code 验证链接、自动轮询登录状态和取消登录
- 退出登录前明确提示会影响同系统 Codex CLI
- DSH 标准模型选择器中的原生 `Codex` 订阅提供方
- 从当前 Codex 账号实时获取模型目录
- 按模型展示可用推理强度
- 显示当前 Codex 账号的滚动额度、剩余比例和重置时间
- 实时增量输出文本与推理摘要，支持中止当前生成
- 使用 `item/reasoning/summaryTextDelta` 原生推理摘要通知，并合并为单个 DSH reasoning block；没有原生通知时才回退到结构化 `reasoning`
- 对实时目录 `inputModalities` 包含 `"image"` 的模型支持 DSH image block；通过 DSH attachment service 读取规范化字节，并以 app-server data URL 发送
- 在 `设置 → 插件 → 插件配置 → Codex` 中设置工作目录、网络访问、自定义 Model ID、推理强度、上下文窗口和单次请求输出默认值
- 普通对话直接使用 Codex，无需斜杠命令或中间模型转发
- 原生接入 DSH 的文本、推理摘要、工具调用、结束状态和用量事件
- 保留结构化 `tool_calls` 契约，由 DSH 负责多回合工具循环；app-server `dynamicTools` 需要另一套 callback 和 turn 生命周期，因此不跨 DSH 分步循环启用
- 每个回合最多执行一次结构化响应或工具参数内部修复；传输、超时和 CLI 中断保留 DSH 原有重试语义
- 自动压缩使用保守的适配器预算；超大历史会在隔离线程中按顺序完整送入分段、分层摘要流程，摘要质量取决于模型
- 支持 Linux、macOS 和原生 Windows，覆盖 x64 与 arm64

## 接入方式

插件使用 OpenAI 官方 `@openai/codex` app-server。ChatGPT 登录和刷新均由官方运行时负责；插件不读取或复制认证文件，不处理 API Key，也不返回账号身份。DSH 第三方模型仍由各自配置的原生 provider 处理。

新的 HTTP API 位于 `/plugins/@local/dsh-codex-adapter/api`。升级期间仍会注册旧的 `/plugins/@local/dsh-codex-oauth/api/*` 兼容别名，让已经打开的旧版设置页面完成当前请求，不会瞬时失效。

插件可以与 CC Switch 共存。插件启动 app-server 进程时会显式选择内置 `openai` 提供方、`chatgpt` 登录方式并关闭请求压缩，因此 CC Switch 的全局提供方和压缩设置不会改写 DSH 请求。DSH 的工作目录、网络访问、模型和推理强度仍由插件配置控制；其他 Codex 命令继续使用各自的全局设置。

每个活动中的 DSH 会话会在内存中复用一个 Codex 线程，并要求完整请求历史保持追加形式。首个回合之后，插件只发送新增的历史消息，让 Codex 能够复用提示缓存。缺少会话 ID、并发调用（返回 `SESSION_BUSY`）、失败后的重试、历史编辑或分叉，以及模型、推理强度或运行参数变化，都会启动隔离线程或进入明确的失败路径。`session-title` 和 `compaction` 辅助调用不会进入主线程池；`compaction` 会先使主会话 lineage 失效。插件不会持久化线程状态。Codex 返回结构化文本、推理摘要和 DSH 工具调用，工具执行继续使用 DSH 原有工具循环。

当 Codex 没有公布容量时，适配器向 DSH 报告保守的 256,000 token 上下文预算。当完整 compaction prompt 超过 app-server/runtime 的 900,000 字符安全预算，插件会在消息和 block 边界分段，并为超大文本与 tool-result 保留有序切片；所有输入分段都会完整、按顺序送入隔离线程，中间摘要只在隔离线程中处理，摘要质量取决于模型，最终仅向 DSH 暴露一份摘要，同时合并全部中间用量。

默认运行参数：

| 项目 | 默认值 |
| --- | --- |
| Codex 登录方式 | `chatgpt` |
| Codex 沙箱 | `read-only` |
| 审批策略 | `never` |
| Codex 网络访问 | 关闭 |
| 子进程环境变量 | 白名单 |

## 兼容性

| 平台 | 架构 |
| --- | --- |
| Linux | x64、arm64 |
| macOS | Intel x64、Apple silicon |
| Windows | x64、arm64 |

运行环境包括 Node.js 22.19+ 和 DeepSeek Harness Web Profile；图形化登录使用运行 DSH 的同一系统账号。

## 安装

图形化登录是主要配置方式。CLI 状态命令仅用于可选诊断：

```sh
codex login status
```

macOS/Linux：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-adapter
dsh --profile web --dump-config
dsh web
```

Windows PowerShell：

```powershell
dsh plugin --profile web add "link:C:/absolute/path/to/dsh-codex-adapter"
dsh --profile web --dump-config
dsh web
```

未全局安装 DSH 时，可以用固定版本的 `npx @deepseek-ai/dsh` 执行相同命令。

## 使用

1. 打开 `设置 → 插件 → 插件配置 → Codex`。
2. 选择“登录 ChatGPT”，完成界面显示的 device code 或浏览器登录流程。
3. 登录状态变为已登录后，在 DSH 标准模型选择器中刷新或选择 `Codex`。
4. 发送普通消息。DSH 第三方 provider 继续使用各自的原生配置。

该卡片还支持选择工作目录、控制网络访问、刷新实时目录、添加自定义 Model ID 和声明输入模态。自定义模型还可以设置可选推理强度、默认推理强度、上下文窗口和单次请求输出默认值。`maxTokens` 只是适配器的单次请求默认值，不是 Codex app-server 或模型的硬上限。

图形编辑器固定在 `设置 → 插件 → 插件配置 → Codex`。DSH 0.1.1-rc.2 的 Models UI 没有第三方 settings namespace 的 editor，可能只显示 `settings.yaml` 提示；本适配器不调用 `registerConfigurableProviders`，不需要手动编辑 `settings.yaml`。

## 卸载

```sh
dsh plugin --profile web remove @local/dsh-codex-adapter
```

卸载后 Adapter 和 Codex 订阅提供方会从 DSH Web Profile 中移除。本地源码仓库、Codex 登录和 Codex 自有历史保持独立。选择“退出登录”会退出同一 app-server 账号，因此也会影响同系统账号下运行的 Codex CLI。

## 开发

```sh
npm ci
npm test
```

CI 使用 Node.js 22.19，覆盖 Ubuntu、macOS 和 Windows。

# DSH Codex 订阅模型提供方

[English](README.md) | 简体中文

把 ChatGPT/Codex 订阅接入 DeepSeek Harness，作为原生模型提供方使用。`Codex` 会直接出现在 DSH 标准模型选择器中，模型目录和推理强度来自当前登录账号。

这是社区集成项目，并非 OpenAI 或 DeepSeek 官方插件。

## 产品特性

- DSH 标准模型选择器中的原生 `Codex` 提供方
- 从当前 Codex 账号实时获取模型目录
- 按模型展示可用推理强度
- 显示当前 Codex 账号的滚动额度、剩余比例和重置时间
- 实时增量输出文本与推理摘要，支持中止当前生成
- 在 `设置 → 插件 → 插件配置 → Codex` 中设置工作目录、网络访问、自定义 Model ID、推理强度、上下文窗口和最大输出
- 普通对话直接使用 Codex，无需斜杠命令或中间模型转发
- 原生接入 DSH 的文本、推理摘要、工具调用、结束状态和用量事件
- 自动压缩使用保守的适配器预算；超大历史会在隔离线程中按顺序完整送入分段、分层摘要流程，摘要质量取决于模型
- 支持 Linux、macOS 和原生 Windows，覆盖 x64 与 arm64

## 接入方式

插件使用 OpenAI 官方 `@openai/codex-sdk` 和 `@openai/codex`。ChatGPT 登录、令牌刷新、模型目录和额度读取均由官方 Codex 运行时负责，插件本身不实现 OAuth，也不接收 API Key。

每个活动中的 DSH 会话会在内存中复用一个 Codex 线程，并要求完整请求历史保持追加形式。首个回合之后，插件只发送新增的历史消息，让 Codex 能够复用提示缓存。缺少会话 ID、并发调用（返回 `SESSION_BUSY`）、失败后的重试、历史编辑或分叉，以及模型、推理强度或运行参数变化，都会启动隔离线程或进入明确的失败路径。`session-title` 和 `compaction` 辅助调用不会进入主线程池；`compaction` 会先使主会话 lineage 失效。插件不会持久化线程状态。Codex 返回结构化文本、推理摘要和 DSH 工具调用，工具执行继续使用 DSH 原有工具循环。

当 Codex 没有公布容量时，适配器向 DSH 报告保守的 256,000 token 上下文预算。当完整 compaction prompt 超过 900,000 字符的 SDK 安全预算，插件会在消息和 block 边界分段，并为超大文本与 tool-result 保留有序切片；所有输入分段都会完整、按顺序送入隔离线程，中间摘要只在隔离线程中处理，摘要质量取决于模型，最终仅向 DSH 暴露一份摘要，同时合并全部中间用量。

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

运行环境包括 Node.js 22.19+、DeepSeek Harness Web Profile，以及同一系统账号下的 Codex 登录。

## 安装

查看当前 Codex 登录状态：

```sh
codex login status
```

macOS/Linux：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-internal
dsh --profile web --dump-config
dsh web
```

Windows PowerShell：

```powershell
dsh plugin --profile web add "link:C:/absolute/path/to/dsh-codex-internal"
dsh --profile web --dump-config
dsh web
```

未全局安装 DSH 时，可以用固定版本的 `npx @deepseek-ai/dsh` 执行相同命令。

## 使用

1. 打开 DSH 标准模型选择器。
2. 选择 `Codex`、模型和推理强度。
3. 发送普通消息。

`设置 → 插件 → 插件配置 → Codex` 支持选择工作目录、控制网络访问、刷新实时目录和添加自定义 Model ID。自定义模型还可以设置可选推理强度、默认推理强度、上下文窗口和最大输出；自定义 ID 会按填写内容直接交给当前 Codex 账号处理。全部 Codex 设置都在图形界面中完成，不需要编辑 `settings.yaml`。

## 卸载

```sh
dsh plugin --profile web remove @local/dsh-codex-internal
```

卸载后 Codex 提供方会从 DSH Web Profile 中移除。本地源码仓库、Codex 登录和 Codex 自有历史保持独立。

## 开发

```sh
npm ci
npm test
```

CI 使用 Node.js 22.19，覆盖 Ubuntu、macOS 和 Windows。

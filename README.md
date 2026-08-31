# DSH Codex Subscription Provider

English | [简体中文](README.zh-CN.md)

Bring a ChatGPT-backed Codex subscription into DeepSeek Harness as a native model provider. Codex appears in the standard DSH model selector with the signed-in account's live model catalog and model-specific reasoning efforts.

This is a community integration and is not an official OpenAI or DeepSeek plugin.

## Highlights

- Native `Codex` provider in the DSH model selector
- Live model discovery from the signed-in Codex account
- Model-specific reasoning effort options
- Current Codex rolling limits, remaining percentages, and reset times
- Incremental text and reasoning-summary streaming with cancellation
- Working directory, network access, custom Model IDs, reasoning efforts, context windows, and output limits in `Settings → Plugins → Plugin Configuration → Codex`
- Direct DSH conversation flow with no slash command and no intermediary model
- DSH-native text, reasoning, tool-call, finish, and usage events
- One bounded internal repair for malformed structured responses or tool-call arguments; transient Codex transport, timeout, and CLI failures retain DSH retry semantics
- Automatic DSH compaction uses a conservative adapter budget; oversized histories are sent as complete, ordered input segments through isolated, hierarchical passes, while summary quality depends on the model
- Linux, macOS, and native Windows support on x64 and arm64

## Integration

The provider uses the official `@openai/codex-sdk` and `@openai/codex` packages. ChatGPT authentication, token refresh, model discovery, and quota lookup remain inside the official Codex runtime; the plugin neither implements OAuth nor accepts an API key.

Each active DSH session reuses one in-memory Codex thread while its complete request history remains append-only. The adapter sends only newly appended history after the first turn, so Codex can reuse its prompt cache. A missing session id, concurrent call (`SESSION_BUSY`), retry after failure, history edit/fork, or model, reasoning, and runtime option change starts an isolated thread or explicit failure path. Auxiliary `session-title` and `compaction` calls bypass the main pool; compaction invalidates the main session lineage first. Thread state is not persisted by the plugin. Codex returns structured text, reasoning summaries, and DSH tool calls, while tool execution stays in the existing DSH tool loop.

The adapter reports a conservative 256,000-token context budget to DSH when Codex does not publish capacity. When a complete compaction prompt exceeds the 900,000-character safe SDK budget, the input is segmented at message and block boundaries and every segment is sent in order through isolated intermediate passes, including ordered slices for oversized text and tool results. The model determines summary quality; only the final summary is exposed to DSH, and all intermediate usage is combined into one usage event.

Runtime defaults:

| Setting | Value |
| --- | --- |
| Codex login method | `chatgpt` |
| Codex sandbox | `read-only` |
| Approval policy | `never` |
| Codex network access | Disabled |
| Child-process environment | Allowlisted |

## Compatibility

| Platform | Architectures |
| --- | --- |
| Linux | x64, arm64 |
| macOS | Intel x64, Apple silicon |
| Windows | x64, arm64 |

Requirements: Node.js 22.19+, a DeepSeek Harness Web profile, and a Codex login owned by the same system account that runs DSH.

## Install

Check the active Codex login:

```sh
codex login status
```

macOS/Linux:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-internal
dsh --profile web --dump-config
dsh web
```

Windows PowerShell:

```powershell
dsh plugin --profile web add "link:C:/absolute/path/to/dsh-codex-internal"
dsh --profile web --dump-config
dsh web
```

The same commands work with a pinned `npx @deepseek-ai/dsh` launcher when DSH is not installed globally.

## Use

1. Open the standard DSH model selector.
2. Select `Codex`, a model, and its reasoning effort.
3. Send a regular message.

The Codex card under `Settings → Plugins → Plugin Configuration → Codex` offers a directory picker, network access control, live catalog refresh, and custom Model ID entries. Custom models can also declare reasoning efforts, a default effort, a context window, and an output limit. Custom IDs are passed to the signed-in Codex account as entered. All Codex settings are available in the UI; editing `settings.yaml` is not required.

## Remove

```sh
dsh plugin --profile web remove @local/dsh-codex-internal
```

Removal detaches the provider from the DSH Web profile. The source checkout, Codex login, and Codex-owned history remain separate.

## Development

```sh
npm ci
npm test
```

The CI matrix runs on Ubuntu, macOS, and Windows with Node.js 22.19.

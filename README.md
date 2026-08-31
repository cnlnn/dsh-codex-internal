# DSH Codex OAuth Bridge

English | [简体中文](README.zh-CN.md)

Connect the official Codex ChatGPT login to DeepSeek Harness through a graphical OAuth Bridge. The plugin keeps ChatGPT authentication inside the official Codex app server, while DSH's third-party models continue to use DSH's native providers.

This is a community integration and is not an official OpenAI or DeepSeek plugin.

## Highlights

- Graphical ChatGPT login in `Settings → Plugins → Plugin Configuration → Codex`
- Login status and plan type without exposing account identity
- Device-code login with a verification link, automatic status polling, and cancellation
- Logout confirmation that explains its shared Codex CLI effect
- Native `Codex` subscription provider in the DSH model selector
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

The bridge uses the official `@openai/codex` app server. ChatGPT authentication and refresh remain inside that runtime; the plugin does not read or copy its credential store, handle API keys, or return account identity. DSH third-party models remain on their configured native providers and are not routed through this bridge.

The plugin can coexist with CC Switch. Its app-server process explicitly selects the built-in `openai` provider, `chatgpt` login, and disabled request compression, so CC Switch global provider and compression settings do not reroute DSH calls. DSH working directory, network access, model, and reasoning effort remain controlled by the plugin; other Codex commands keep their own global settings.

Each active DSH session reuses one in-memory Codex thread while its complete request history remains append-only. The adapter sends only newly appended history after the first turn, so Codex can reuse its prompt cache. A missing session id, concurrent call (`SESSION_BUSY`), retry after failure, history edit/fork, or model, reasoning, and runtime option change starts an isolated thread or explicit failure path. Auxiliary `session-title` and `compaction` calls bypass the main pool; compaction invalidates the main session lineage first. Thread state is not persisted by the plugin. Codex returns structured text, reasoning summaries, and DSH tool calls, while tool execution stays in the existing DSH tool loop.

The adapter reports a conservative 256,000-token context budget to DSH when Codex does not publish capacity. When a complete compaction prompt exceeds the 900,000-character app-server/runtime safe budget, the input is segmented at message and block boundaries and every segment is sent in order through isolated intermediate passes, including ordered slices for oversized text and tool results. The model determines summary quality; only the final summary is exposed to DSH, and all intermediate usage is combined into one usage event.

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

Requirements: Node.js 22.19+ and a DeepSeek Harness Web profile. The graphical login uses the same system account as the DSH process.

## Install

The graphical login is the normal setup path. The CLI status command is optional diagnostics only:

```sh
codex login status
```

macOS/Linux:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-oauth
dsh --profile web --dump-config
dsh web
```

Windows PowerShell:

```powershell
dsh plugin --profile web add "link:C:/absolute/path/to/dsh-codex-oauth"
dsh --profile web --dump-config
dsh web
```

The same commands work with a pinned `npx @deepseek-ai/dsh` launcher when DSH is not installed globally.

## Use

1. Open `Settings → Plugins → Plugin Configuration → Codex`.
2. Select `Sign in to ChatGPT` and complete the displayed device-code or browser flow.
3. After the status changes to signed in, refresh or select `Codex` in the standard DSH model selector.
4. Send a regular message. DSH third-party providers continue to work through their own native configuration.

The Codex card also offers a directory picker, network access control, live catalog refresh, and custom Model ID entries. Custom models can declare reasoning efforts, a default effort, a context window, and an output limit. All bridge and Codex settings are available in the UI; editing `settings.yaml` is not required.

## Remove

```sh
dsh plugin --profile web remove @local/dsh-codex-oauth
```

Removal detaches the bridge and subscription provider from the DSH Web profile. The source checkout, Codex login, and Codex-owned history remain separate. Choosing `退出登录` signs out the shared Codex app-server account and therefore also affects Codex CLI running under the same system account.

## Development

```sh
npm ci
npm test
```

The CI matrix runs on Ubuntu, macOS, and Windows with Node.js 22.19.

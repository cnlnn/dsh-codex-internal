# DSH Codex Subscription Provider

English | [简体中文](README.zh-CN.md)

Bring a ChatGPT-backed Codex subscription into DeepSeek Harness as a native model provider. Codex appears in the standard DSH model selector with the signed-in account's live model catalog and model-specific reasoning efforts.

This is a community integration and is not an official OpenAI or DeepSeek plugin.

## Highlights

- Native `Codex` provider in the DSH model selector
- Live model discovery from the signed-in Codex account
- Model-specific reasoning effort options
- Custom Model ID support in `Settings → Models → Codex`
- Direct DSH conversation flow with no slash command and no intermediary model
- DSH-native text, reasoning, tool-call, finish, and usage events
- Linux, macOS, and native Windows support on x64 and arm64

## Integration

The provider uses the official `@openai/codex-sdk` and `@openai/codex` packages. ChatGPT authentication and token refresh remain inside the official Codex runtime; the plugin neither implements OAuth nor accepts an API key.

Each DSH request is projected into a stateless Codex turn. Codex returns structured text, reasoning summaries, and DSH tool calls, while tool execution stays in the existing DSH tool loop.

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

The Codex provider card under `Settings → Models` also offers live catalog refresh and custom Model ID entries. Custom IDs are passed to the signed-in Codex account as entered.

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

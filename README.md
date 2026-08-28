# DSH Codex Subscription Provider

English | [简体中文](README.zh-CN.md)

Small, local DeepSeek Harness bundle that registers a `Codex` model provider backed by the official `@openai/codex-sdk` package. The DSH model selector reads the visible model catalog from the signed-in Codex account and exposes each model's supported reasoning efforts.

The bundle does not implement OAuth, read Codex credential files, or accept an API key. The official Codex CLI bundled by the SDK owns ChatGPT subscription authentication and token refresh. The child process receives an environment allowlist so unrelated API keys and proxy credentials are not inherited.

## Security model

- Every model call runs Codex in `read-only`, with `approvalPolicy: never`; network is disabled by default.
- DSH history, system instructions, and tool schemas are projected into a stateless Codex turn. Structured Codex output is mapped back to DSH text, reasoning, tool calls, and usage.
- The adapter tells Codex not to use its own internal tools. DSH tool requests are returned to the ordinary DSH tool loop instead.
- The SDK forces `forced_login_method = "chatgpt"`; it cannot silently switch this bridge to API-key billing.
- Results are exposed through DSH's ordinary text, reasoning, tool-call, finish, and token-usage stream.
- Only official OpenAI packages are runtime dependencies. Versions are exact in `package-lock.json` after installation.

## Install

The provider supports Linux, macOS, and native Windows on x64 and arm64. It requires Node.js 22.19 or newer, a DeepSeek Harness Web profile, and a Codex login on the same user account that runs DSH. The official Codex package supplies the matching native binary for each platform.

Confirm the official Codex login uses the ChatGPT subscription:

```sh
codex login status
```

Install this checkout into the existing Web profile:

macOS/Linux:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-internal
dsh --profile web --dump-config
dsh web
```

Windows PowerShell (forward slashes avoid package-specifier ambiguity):

```powershell
dsh plugin --profile web add "link:C:/absolute/path/to/dsh-codex-internal"
dsh --profile web --dump-config
dsh web
```

If DSH is normally launched with `npx`, use the same pinned DSH package to run the plugin command and Web profile.

## Use

Restart DSH, open the normal model selector, choose the `Codex` provider, then select any model currently advertised by Codex and its reasoning effort. Ordinary messages use that route directly; no `/codex` command and no GLM delegation are involved.

The Models settings page includes a Codex model-catalog editor. `获取可用模型` reads the current account catalog, and `添加模型` accepts an arbitrary model id. Saved custom rows are added to the live Codex catalog; whether an arbitrary id can run is still decided by the signed-in Codex account.

## Remove

```sh
dsh plugin --profile web remove @local/dsh-codex-internal
```

Removal withdraws the dependency and bundle from the DSH Web profile. It does not delete this source checkout, Codex login state, or Codex thread history. Restart DSH after removal; a browser tab that was already open should also be refreshed or closed.

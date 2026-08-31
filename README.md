# DSH Codex Adapter

English | [简体中文](README.zh-CN.md)

Connect the official Codex ChatGPT login to DeepSeek Harness through a native DSH provider adapter. The plugin keeps ChatGPT authentication inside the official Codex app server, while DSH's third-party models continue to use DSH's native providers.

This is a community integration and is not an official OpenAI or DeepSeek plugin.

## Highlights

- Graphical ChatGPT login in `Settings → Plugins → Plugin Configuration → Codex`
- Login status and plan type without exposing account identity
- Device-code login with a verification link, automatic status polling, and cancellation
- Plugin-scoped login and logout; the system Codex CLI account is unaffected
- Native `Codex` subscription provider in the DSH model selector
- Live model discovery from the signed-in Codex account
- Model-specific reasoning effort options
- Current Codex rolling limits, remaining percentages, and reset times
- Incremental text and reasoning-summary streaming with cancellation
- Native Codex reasoning-summary notifications (`item/reasoning/summaryTextDelta`) mapped to one DSH reasoning block, with structured `reasoning` retained only as a fallback
- Native DSH image blocks, including image-aware compaction, for models whose live catalog includes `"image"` in `inputModalities`; durable image refs are read through the DSH attachment service and sent as app-server data URLs
- Network access, custom Model IDs, reasoning efforts, context windows, and per-request output defaults in `Settings → Plugins → Plugin Configuration → Codex`
- Direct DSH conversation flow with no slash command and no intermediary model
- DSH-native text, reasoning, tool-call, finish, and usage events
- Structured `tool_calls` remain the adapter contract because DSH owns the multi-step tool loop; app-server `dynamicTools` would require a separate callback and turn lifecycle
- One bounded internal repair for malformed structured responses or tool-call arguments; transient Codex transport, timeout, and CLI failures retain DSH retry semantics
- Automatic DSH compaction uses a conservative adapter budget; oversized histories are sent as complete, ordered input segments through isolated, hierarchical passes. Every historical image is preflighted from its durable ref, supplied as a native image in its first relevant pass, and retained in the final text summary through adapter-owned attachment references; unavailable or over-budget images fail closed
- Linux, macOS, and native Windows support on x64 and arm64

## Integration

The adapter uses the official `@openai/codex` app server in a plugin-owned, dedicated `CODEX_HOME` under `${DSH_HOME}/codex-adapter` (or `~/.dsh/codex-adapter`). ChatGPT authentication and refresh remain inside that isolated runtime; the plugin does not read, copy, or link the system Codex credential store, handle API keys, or return account identity. DSH third-party models remain on their configured native providers and are not routed through this adapter.

The canonical HTTP API is under `/plugins/@local/dsh-codex-adapter/api`. The old `/plugins/@local/dsh-codex-oauth/api/*` paths remain registered as compatibility aliases so an already-open pre-0.7 settings page can finish its current request during an upgrade.

The plugin can coexist with CC Switch. Its app-server process uses the dedicated home, a controlled workspace, the built-in `openai` provider, `chatgpt` login, and disabled request compression. Global/project MCP servers, plugins, hooks, model instructions, and project files are not loaded into the DSH runtime; DSH supplies conversation history and tool schemas through its structured prompt and executes tools in its own loop. Other Codex commands keep their own global settings.

Each active DSH session reuses one in-memory Codex thread while its complete request history remains append-only. The adapter sends only newly appended history after the first turn, so Codex can reuse its prompt cache. A missing session id, concurrent call (`SESSION_BUSY`), retry after failure, history edit/fork, or model, reasoning, and runtime option change starts an isolated thread or explicit failure path. Auxiliary `session-title` and `compaction` calls bypass the main pool; compaction invalidates the main session lineage first. The plugin does not maintain a separate thread-state file; minimal replay metadata is carried by DSH assistant provenance. Codex returns structured text, reasoning summaries, and DSH tool calls, while tool execution stays in the existing DSH tool loop.

The adapter reports a conservative 256,000-token context budget to DSH when Codex does not publish capacity. When a complete compaction input exceeds the 900,000-character app-server/runtime safe budget, the input is segmented at message and block boundaries and every segment is sent in order through isolated intermediate passes, including ordered slices for oversized text, tool results, and native image payloads. Durable image refs are read and verified before any summary call; each image is sent natively in its first relevant intermediate group, then its visual summary and source reference remain text-only in later hierarchy and final passes. Compaction auxiliary threads use `ephemeral: true`, so intermediate and final compaction threads do not write Codex rollout history. Raw request and image bytes are not persisted by this plugin; the official Codex app-server/runtime may still process or retain them under its own policy. The model determines visual-summary quality, while the adapter appends deterministic attachment IDs and source locations to the final text summary. Only the final summary is exposed to DSH, and all intermediate usage is combined into one usage event.

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

Requirements: Node.js 22.19+ and a DeepSeek Harness Web profile. The graphical login is stored in the plugin's independent Codex home; after upgrading to this isolated runtime, sign in again from the WebUI.

## Install

The graphical login is the only sign-in path for this plugin. The system
`codex login status` command reports the system Codex home, not this plugin's
independent account.

### GitHub Release (recommended)

The release asset is a platform-neutral npm tarball; it is not published to npm. `pnpm`, through `dsh plugin`, resolves the pinned runtime dependencies and the matching official Codex native optional package for the host OS and architecture. The `v0.8.0` asset is:

`local-dsh-codex-adapter-0.8.0.tgz`

macOS/Linux:

```sh
dsh plugin --profile web add --save-exact \
  "https://github.com/cnlnn/dsh-codex-adapter/releases/download/v0.8.0/local-dsh-codex-adapter-0.8.0.tgz"
dsh --profile web --dump-config
# Restart the DSH Web profile after the bundle changes.
dsh web --no-open
```

Windows PowerShell:

```powershell
dsh plugin --profile web add --save-exact `
  "https://github.com/cnlnn/dsh-codex-adapter/releases/download/v0.8.0/local-dsh-codex-adapter-0.8.0.tgz"
dsh --profile web --dump-config
dsh web --no-open
```

For an audited install, download `SHA256SUMS` from the same release and verify the tarball before installing it from a local `file:` URL:

```sh
curl -fLO https://github.com/cnlnn/dsh-codex-adapter/releases/download/v0.8.0/local-dsh-codex-adapter-0.8.0.tgz
curl -fLO https://github.com/cnlnn/dsh-codex-adapter/releases/download/v0.8.0/SHA256SUMS
```

Linux checksum verification:

```sh
sha256sum -c SHA256SUMS
```

macOS checksum verification:

```sh
shasum -a 256 --check SHA256SUMS
```

After verification, install the local tarball:

```sh
dsh plugin --profile web add --save-exact \
  "file:$PWD/local-dsh-codex-adapter-0.8.0.tgz"
```

The release workflow uploads exactly two assets: the package tarball and `SHA256SUMS`. To update, run `dsh plugin --profile web add --save-exact` with the new release URL, then restart the profile. No `settings.yaml` edit is required; configuration remains in `Settings → Plugins → Plugin Configuration → Codex`.

### From a source checkout

macOS/Linux:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-codex-adapter
dsh --profile web --dump-config
dsh web
```

Windows PowerShell:

```powershell
dsh plugin --profile web add "link:C:/absolute/path/to/dsh-codex-adapter"
dsh --profile web --dump-config
dsh web
```

The same commands work with a pinned `npx @deepseek-ai/dsh` launcher when DSH is not installed globally.

## Use

1. Open `Settings → Plugins → Plugin Configuration → Codex`.
2. Select `Sign in to ChatGPT` and complete the displayed device-code or browser flow. The first sign-in after this isolated-runtime upgrade is required in the WebUI.
3. After the status changes to signed in, refresh or select `Codex` in the standard DSH model selector.
4. Send a regular message. DSH third-party providers continue to work through their own native configuration.

The Codex card also offers network access control, live catalog refresh, custom Model ID entries, and image input modality declarations. Custom models can declare reasoning efforts, a default effort, a context window, and a per-request output default. `maxTokens` is an adapter request default, not a hard Codex app-server/model limit. The plugin uses its controlled workspace rather than exposing a project working-directory setting.

The graphical editor is intentionally located in `Settings → Plugins → Plugin Configuration → Codex`. DSH 0.1.1-rc.2's Models UI does not provide an editor for this third-party settings namespace and may show a `settings.yaml` hint; this adapter does not call `registerConfigurableProviders`, and no manual `settings.yaml` edit is required.

## Remove

```sh
dsh plugin --profile web remove @local/dsh-codex-adapter
```

Removal detaches the adapter and subscription provider from the DSH Web profile. The source checkout, plugin-scoped Codex login, and Codex-owned history remain separate; uninstall does not silently delete the plugin home. Choosing `退出登录` signs out only the plugin's independent app-server account and does not affect Codex CLI running under the same system account.

## Development

```sh
npm ci
npm test
```

The CI matrix runs on Ubuntu, macOS, and Windows with Node.js 22.19.

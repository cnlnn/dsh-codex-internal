import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Codex } from '@openai/codex-sdk'

export const name = 'llm-codex-subscription'
export const inject = ['llm']
export const CODEX_PROVIDER = 'codex'
export const CODEX_SETTINGS_NAMESPACE = settingsNamespace('llm-codex-subscription')

export const DEFAULT_MODELS = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'Strong model for everyday coding; scheduled for retirement.',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4-Mini',
    description: 'Small, fast model for simpler coding tasks; scheduled for retirement.',
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3-Codex-Spark',
    description: 'Ultra-fast coding model.',
  },
]

const REASONING_CAPABILITIES = new Map([
  ['gpt-5.6-sol', { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' }],
  ['gpt-5.6-terra', { efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' }],
  ['gpt-5.6-luna', { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }],
  ['gpt-5.5', { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  ['gpt-5.4', { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  ['gpt-5.4-mini', { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  ['gpt-5.3-codex-spark', { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }],
])

// The account catalog can briefly advertise this API model even though the
// ChatGPT-authenticated Codex endpoint rejects it categorically.
const UNSUPPORTED_CHATGPT_MODELS = new Set(['gpt-5.2'])

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config = z.object({
  workingDirectory: z.string().default(homedir()),
  allowNetworkAccess: z.boolean().default(false),
  models: z.array(catalogModel).default([]),
})

const SAFE_ENV_KEYS = new Set([
  'CODEX_CA_CERTIFICATE',
  'CODEX_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SSL_CERT_FILE',
  'TERM',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
])

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reasoning', 'text', 'tool_calls'],
  properties: {
    reasoning: {
      type: 'string',
      description: 'A concise reasoning summary suitable for display, or an empty string.',
    },
    text: {
      type: 'string',
      description: 'The assistant response text. Use an empty string when only tools are requested.',
    },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'arguments_json'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          arguments_json: {
            type: 'string',
            description: 'A JSON-encoded object matching the selected DSH tool schema.',
          },
        },
      },
    },
  },
}

/** Return only values required by the official Codex CLI process. */
export function sanitizedEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => SAFE_ENV_KEYS.has(key) && value !== undefined),
  )
}

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: ['text'],
  }
}

function reasoningInfo(capability) {
  return {
    efforts: capability.efforts.map(effort => ({
      id: ReasoningEffortId(effort),
      name: effort,
    })),
    defaultEffort: ReasoningEffortId(capability.defaultEffort),
  }
}

function resolveCatalog(models) {
  const seen = new Set()
  return (models ?? []).map((model) => {
    const id = model.id.trim()
    if (id.length === 0) throw new Error('Codex model ids must be non-empty.')
    if (seen.has(id)) throw new Error(`Codex model id "${id}" is duplicated.`)
    seen.add(id)
    return {
      ...model,
      id,
      ...(model.name === undefined || model.name.trim().length === 0
        ? {}
        : { name: model.name.trim() }),
    }
  })
}

function resolveConfig(config = {}) {
  return {
    workingDirectory: config.workingDirectory ?? homedir(),
    allowNetworkAccess: config.allowNetworkAccess ?? false,
    models: resolveCatalog(config.models),
  }
}

function resolvedModelInfo(provider, model, capability) {
  return {
    ...modelInfo(provider, model),
    ...(model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } }),
    ...(model.maxTokens === undefined ? {} : { defaultMaxTokens: model.maxTokens }),
    ...(capability === undefined ? {} : { reasoning: reasoningInfo(capability) }),
  }
}

function serializeBlock(block) {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: block.toolCallId,
        isError: block.isError ?? false,
        content: block.content.map(serializeBlock),
      }
    case 'image':
      throw new LlmError('Codex subscription models in DSH currently accept text only.', 'UNSUPPORTED_CONTENT')
    default:
      throw new LlmError(`Unsupported DSH content block: ${String(block.type)}`, 'UNSUPPORTED_CONTENT')
  }
}

/** Build one stateless model turn from DSH's authoritative assembled request. */
export function buildCodexPrompt(options) {
  const payload = {
    system: options.system ?? '',
    messages: options.messages.map(message => ({
      role: message.role,
      content: message.content.map(serializeBlock),
    })),
    tools: options.tools ?? [],
    generation: {
      max_tokens: options.maxTokens ?? null,
    },
  }

  return [
    'Act as the model backend for one DeepSeek Harness step.',
    'Do not use your own shell, filesystem, web, MCP, or editing tools during this turn.',
    'Use only the supplied payload. Treat payload.system as the authoritative system instruction',
    'and payload.messages as the complete ordered conversation.',
    'When a supplied DSH tool is needed, return it in tool_calls instead of executing it yourself.',
    'Never invent a tool result. arguments_json must encode one JSON object matching that tool schema.',
    'Return concise visible text and only a brief reasoning summary, not private chain-of-thought.',
    '',
    JSON.stringify(payload),
  ].join('\n')
}

function parseStructuredResponse(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new LlmError('Codex returned invalid structured model output.', 'PROTOCOL', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || typeof value.reasoning !== 'string' || typeof value.text !== 'string'
    || !Array.isArray(value.tool_calls)) {
    throw new LlmError('Codex returned an invalid structured model response.', 'PROTOCOL')
  }
  return value
}

export function mapUsage(usage) {
  if (usage === null) return undefined
  const cacheRead = usage.cached_input_tokens ?? 0
  const cacheWrite = usage.cache_write_input_tokens ?? 0
  return {
    inputTokens: Math.max(0, usage.input_tokens - cacheRead - cacheWrite),
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(usage.reasoning_output_tokens > 0 ? { reasoningTokens: usage.reasoning_output_tokens } : {}),
  }
}

function classifySdkError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/aborted|abort/i.test(message)) return new LlmError(message, 'ABORTED', { cause: error })
  if (/401|403|authentication|login/i.test(message)) return new LlmError(message, 'AUTH', { cause: error })
  if (/429|rate.?limit/i.test(message)) return new LlmError(message, 'RATE_LIMIT', { cause: error })
  return new LlmError(message, 'CODEX_SDK', { cause: error })
}

/** Read the full visible catalog exposed to the signed-in Codex account. */
export function discoverCodexCatalog(signal, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new LlmError('Codex model discovery was aborted.', 'ABORTED'))
      return
    }

    const child = spawnProcess('codex', [
      'app-server',
      '--stdio',
      '-c',
      'forced_login_method="chatgpt"',
    ], {
      env: sanitizedEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let buffer = ''
    let stderr = ''

    const finish = (error, models) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      child.kill('SIGTERM')
      if (error === undefined) resolve(models)
      else reject(error)
    }
    const abort = () => finish(new LlmError('Codex model discovery was aborted.', 'ABORTED'))
    const fail = (message, cause) => finish(new LlmError(message, 'CODEX_DISCOVERY', { cause }))
    const write = value => child.stdin.write(`${JSON.stringify(value)}\n`)
    const timer = setTimeout(() => fail('Codex model discovery timed out.'), 30_000)

    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => fail(`Unable to start Codex model discovery: ${error.message}`, error))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })
    child.on('exit', (code) => {
      if (!settled) fail(`Codex model discovery exited with code ${String(code)}.${stderr.length > 0 ? ` ${stderr.trim()}` : ''}`)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length === 0) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1 && message.result !== undefined) {
          write({ id: 2, method: 'model/list', params: { includeHidden: false, limit: 100 } })
          continue
        }
        if (message.id !== 2) continue
        if (message.error !== undefined) {
          fail(`Codex rejected model discovery: ${message.error.message ?? 'unknown error'}`)
          return
        }
        const rows = Array.isArray(message.result?.data) ? message.result.data : []
        const models = rows
          .filter(row => row !== null && typeof row === 'object' && row.hidden !== true)
          .map(row => ({
            id: String(row.model ?? row.id),
            name: typeof row.displayName === 'string' ? row.displayName : String(row.model ?? row.id),
            ...(typeof row.description === 'string' ? { description: row.description } : {}),
            efforts: Array.isArray(row.supportedReasoningEfforts)
              ? row.supportedReasoningEfforts
                .map(item => item?.reasoningEffort)
                .filter(effort => typeof effort === 'string')
              : [],
            ...(typeof row.defaultReasoningEffort === 'string'
              ? { defaultEffort: row.defaultReasoningEffort }
              : {}),
          }))
          .filter(model => model.id.length > 0
            && model.id !== 'undefined'
            && !UNSUPPORTED_CHATGPT_MODELS.has(model.id))
        finish(undefined, models)
        return
      }
    })

    write({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'dsh-codex-model-discovery', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })
  })
}

/** Return discovery candidates in DSH's public model-list shape. */
export async function discoverCodexModels(signal, spawnProcess = spawn) {
  const catalog = await discoverCodexCatalog(signal, spawnProcess)
  return catalog.map(model => ({ id: model.id, name: model.name }))
}

/** DSH provider adapter backed only by the official Codex SDK and ChatGPT login. */
export class CodexSubscriptionAdapter extends LlmAdapter {
  constructor(config = {}, createClient = () => new Codex({
    env: sanitizedEnvironment(),
    config: { forced_login_method: 'chatgpt' },
  }), discoverCatalog = discoverCodexCatalog) {
    super()
    this.resolveOptions = typeof config === 'function' ? config : () => config
    this.createClient = createClient
    this.discoverCatalog = discoverCatalog
    this.client = undefined
    this.liveCatalog = undefined
    this.catalogAt = 0
    this.catalogPromise = undefined
  }

  options() {
    return resolveConfig(this.resolveOptions())
  }

  async catalog() {
    if (this.liveCatalog !== undefined && Date.now() - this.catalogAt < 300_000) {
      return this.liveCatalog
    }
    this.catalogPromise ??= this.discoverCatalog()
      .then((models) => {
        this.liveCatalog = models
        this.catalogAt = Date.now()
        for (const model of models) {
          if (model.efforts.length > 0 && model.defaultEffort !== undefined) {
            REASONING_CAPABILITIES.set(model.id, {
              efforts: model.efforts,
              defaultEffort: model.defaultEffort,
            })
          }
        }
        return models
      })
      .finally(() => {
        this.catalogPromise = undefined
      })
    return this.catalogPromise
  }

  getClient() {
    this.client ??= this.createClient()
    return this.client
  }

  providerInfo(provider) {
    return { id: provider, name: 'Codex' }
  }

  async listModels(provider) {
    const configured = this.options().models
    let live = []
    try {
      live = await this.catalog()
    } catch {
      if (configured.length === 0) live = DEFAULT_MODELS
    }
    const byId = new Map(live.map(model => [model.id, model]))
    for (const model of configured) {
      if (!byId.has(model.id)) byId.set(model.id, model)
    }
    return [...byId.values()].map(model => modelInfo(provider, model))
  }

  async resolveModel(provider, modelId) {
    let live = this.liveCatalog ?? []
    try {
      live = await this.catalog()
    } catch {
      // Static capabilities and configured metadata are the offline fallback.
    }
    const model = live.find(candidate => candidate.id === modelId)
      ?? this.options().models.find(candidate => candidate.id === modelId)
      ?? { id: modelId, name: modelId }
    return resolvedModelInfo(provider, model, REASONING_CAPABILITIES.get(modelId))
  }

  async * stream(options) {
    if (options.temperature !== undefined) {
      throw new LlmError('Codex subscription adapter does not support temperature.', 'UNSUPPORTED_OPTION')
    }
    if (options.stop !== undefined && options.stop.length > 0) {
      throw new LlmError('Codex subscription adapter does not support stop sequences.', 'UNSUPPORTED_OPTION')
    }

    const config = this.options()
    const thread = this.getClient().startThread({
      model: options.model,
      workingDirectory: config.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: config.allowNetworkAccess,
      modelReasoningEffort: options.reasoningEffort,
      threadSource: 'dsh-llm-adapter',
    })

    let turn
    try {
      turn = await thread.run(buildCodexPrompt(options), {
        outputSchema: RESPONSE_SCHEMA,
        signal: options.signal,
      })
    } catch (error) {
      throw classifySdkError(error)
    }

    const response = parseStructuredResponse(turn.finalResponse)
    let index = 0

    if (response.reasoning.length > 0) {
      const block = { type: 'reasoning', text: response.reasoning }
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: response.reasoning }
      yield { type: 'block-end', index, block }
      index += 1
    }

    if (response.text.length > 0) {
      const block = { type: 'text', text: response.text }
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: response.text }
      yield { type: 'block-end', index, block }
      index += 1
    }

    for (const call of response.tool_calls) {
      if (call === null || typeof call !== 'object' || Array.isArray(call)
        || typeof call.name !== 'string' || call.name.length === 0
        || typeof call.arguments_json !== 'string') {
        throw new LlmError('Codex returned an invalid DSH tool call.', 'PROTOCOL')
      }
      let parsedArguments
      try {
        parsedArguments = JSON.parse(call.arguments_json)
      } catch (error) {
        throw new LlmError('Codex returned invalid JSON for a DSH tool call.', 'PROTOCOL', { cause: error })
      }
      if (parsedArguments === null || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
        throw new LlmError('Codex returned non-object arguments for a DSH tool call.', 'PROTOCOL')
      }
      const id = CallId(typeof call.id === 'string' && call.id.length > 0
        ? call.id
        : `codex-${randomUUID()}`)
      const argumentsText = JSON.stringify(parsedArguments)
      const block = { type: 'tool-call', id, name: call.name, arguments: argumentsText }
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index,
        id,
        name: call.name,
        argumentsDelta: argumentsText,
      }
      yield { type: 'block-end', index, block }
      index += 1
    }

    const usage = mapUsage(turn.usage)
    if (usage !== undefined) yield { type: 'usage', usage }
    yield {
      type: 'finish',
      reason: response.tool_calls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
    }
  }
}

export function apply(ctx, config) {
  let current = () => config
  const adapter = new CodexSubscriptionAdapter(() => current())
  ctx.llm.registerConfigurableProviders([
    {
      provider: CODEX_PROVIDER,
      displayName: 'Codex',
      settingsNs: CODEX_SETTINGS_NAMESPACE,
      settingsPath: [],
    },
  ])
  ctx.llm.registerModelDiscovery(
    CODEX_SETTINGS_NAMESPACE,
    (_request, signal) => discoverCodexModels(signal),
  )
  ctx.llm.registerAdapter([CODEX_PROVIDER], adapter)
  installSettingsSection(ctx, CODEX_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
  })
}

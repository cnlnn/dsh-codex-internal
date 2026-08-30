import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
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
export const inject = ['llm', 'webServer']
export const CODEX_PROVIDER = 'codex'
export const CODEX_SETTINGS_NAMESPACE = settingsNamespace('llm-codex-subscription')
export const CODEX_CLI_PATH = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
const API_ROOT = '/plugins/@local/dsh-codex-internal/api'
export const CODEX_THREAD_POOL_MAX = 8
export const CODEX_THREAD_POOL_IDLE_MS = 30 * 60 * 1000

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
  efforts: z.array(z.string()),
  defaultEffort: z.string(),
})

export const Config = z.object({
  workingDirectory: z.string().default(homedir()),
  allowNetworkAccess: z.boolean().default(false),
  models: z.array(catalogModel).default([]),
})

const SAFE_ENV_KEYS = new Set([
  'APPDATA',
  'CODEX_CA_CERTIFICATE',
  'CODEX_HOME',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SHELL',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WINDIR',
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
    Object.entries(source).filter(([key, value]) => SAFE_ENV_KEYS.has(key.toUpperCase()) && value !== undefined),
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
    const efforts = [...new Set((model.efforts ?? []).map(effort => effort.trim()).filter(Boolean))]
    const defaultEffort = model.defaultEffort?.trim()
    if (defaultEffort !== undefined && defaultEffort.length > 0 && !efforts.includes(defaultEffort)) {
      efforts.push(defaultEffort)
    }
    return {
      ...model,
      id,
      ...(model.name === undefined || model.name.trim().length === 0
        ? {}
        : { name: model.name.trim() }),
      ...(efforts.length === 0 ? {} : { efforts }),
      ...(defaultEffort === undefined || defaultEffort.length === 0 ? {} : { defaultEffort }),
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

function modelCapability(model) {
  if (Array.isArray(model?.efforts) && model.efforts.length > 0) {
    return {
      efforts: model.efforts,
      defaultEffort: model.defaultEffort ?? model.efforts[0],
    }
  }
  return REASONING_CAPABILITIES.get(model?.id)
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

function codexPayload(options) {
  return {
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
}

/** Build one model turn from DSH's authoritative assembled request. */
export function buildCodexPrompt(options, { messageStart = 0, continuation = false } = {}) {
  const fullPayload = codexPayload(options)
  const isContinuation = continuation
    && Number.isInteger(messageStart)
    && messageStart >= 0
    && messageStart < fullPayload.messages.length
  const payload = isContinuation
    ? {
        messages: fullPayload.messages.slice(messageStart),
        generation: fullPayload.generation,
      }
    : fullPayload

  return [
    isContinuation
      ? 'Continue the model backend for the next DeepSeek Harness step in this Codex thread.'
      : 'Act as the model backend for one DeepSeek Harness step.',
    'Do not use your own shell, filesystem, web, MCP, or editing tools during this turn.',
    isContinuation
      ? 'The earlier Codex turns contain the authoritative DSH system instruction, tool schemas, and prior history.'
      : 'Use only the supplied payload. Treat payload.system as the authoritative system instruction',
    isContinuation
      ? 'Apply the appended payload.messages to that history. They are the only new DSH messages for this turn.'
      : 'and payload.messages as the complete ordered conversation.',
    'When a supplied DSH tool is needed, return it in tool_calls instead of executing it yourself.',
    'Never invent a tool result. arguments_json must encode one JSON object matching that tool schema.',
    'Return concise visible text and only a brief reasoning summary, not private chain-of-thought.',
    '',
    JSON.stringify(payload),
  ].join('\n')
}

function canonicalJson(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * Capture the complete request lineage used to decide whether a native Codex
 * thread may receive the next DSH request. Message IDs make rewrites visible
 * even when edited content happens to be identical.
 */
export function codexRequestLineage(options, threadOptions = {}) {
  const payload = codexPayload(options)
  const messages = payload.messages.map((message, index) => ({
    id: options.messages[index]?.id ?? null,
    ...message,
  }))
  return {
    contextKey: digest({
      generation: payload.generation,
      purpose: options.purpose ?? null,
      system: payload.system,
      thread: threadOptions,
      tools: payload.tools,
    }),
    messageKeys: messages.map(digest),
    messageContentKeys: payload.messages.map(digest),
    messageCount: messages.length,
  }
}

function lineageContinues(previous, next) {
  if (previous === undefined || next === undefined || previous.contextKey !== next.contextKey) return false
  const cursor = previous.assistantCursor
  if (previous.assistantFingerprint === undefined
    || !Number.isInteger(cursor)
    || next.messageKeys.length <= cursor + 1
    || !Array.isArray(next.messageContentKeys)
    || next.messageContentKeys[cursor] !== previous.assistantFingerprint) return false
  return previous.messageKeys.every((key, index) => key === next.messageKeys[index])
}

function hasSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0
}

function hasNativeThreadId(thread) {
  try {
    return typeof thread?.id === 'string' && thread.id.length > 0
  } catch {
    return false
  }
}

export function codexAssistantFingerprint(blocks) {
  return digest({ role: 'assistant', content: blocks })
}

/**
 * Keep one in-memory native Codex thread per DSH session lineage. A missing
 * session id, concurrent call, rewritten history, or changed thread options
 * always gets an isolated thread instead of guessing across sessions.
 */
export class CodexThreadPool {
  constructor({
    maxEntries = CODEX_THREAD_POOL_MAX,
    idleMs = CODEX_THREAD_POOL_IDLE_MS,
    now = Date.now,
  } = {}) {
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0
      ? maxEntries
      : CODEX_THREAD_POOL_MAX
    this.idleMs = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : CODEX_THREAD_POOL_IDLE_MS
    this.now = typeof now === 'function' ? now : Date.now
    this.entries = new Map()
    this.blocked = new Map()
  }

  size() {
    return this.entries.size
  }

  prune() {
    const now = this.now()
    for (const [sessionId, entry] of this.entries) {
      if (!entry.busy && now - entry.lastUsed >= this.idleMs) this.entries.delete(sessionId)
    }
  }

  evict() {
    while (this.entries.size > this.maxEntries) {
      let oldestId
      let oldestAt = Infinity
      for (const [sessionId, entry] of this.entries) {
        if (!entry.busy && entry.lastUsed < oldestAt) {
          oldestId = sessionId
          oldestAt = entry.lastUsed
        }
      }
      if (oldestId === undefined) return
      this.entries.delete(oldestId)
    }
  }

  blockSession(sessionId) {
    if (!hasSessionId(sessionId)) return
    this.blocked.set(sessionId, (this.blocked.get(sessionId) ?? 0) + 1)
  }

  unblockSession(sessionId) {
    if (!hasSessionId(sessionId)) return
    const count = this.blocked.get(sessionId) ?? 0
    if (count <= 1) this.blocked.delete(sessionId)
    else this.blocked.set(sessionId, count - 1)
  }

  invalidateSession(sessionId) {
    if (!hasSessionId(sessionId)) return
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    this.entries.delete(sessionId)
    entry.invalidated = true
    if (entry.busy && !entry.blocked) {
      entry.blocked = true
      this.blockSession(sessionId)
    }
  }

  acquireIsolated({ sessionId, lineage, threadOptions, createThread, blockSession = false }) {
    const thread = createThread()
    const entry = {
      blocked: blockSession && hasSessionId(sessionId),
      busy: true,
      invalidated: false,
      lastUsed: this.now(),
      lineage,
      pooled: false,
      sessionId: hasSessionId(sessionId) ? sessionId : undefined,
      thread,
      threadSignature: digest(threadOptions),
    }
    if (entry.blocked) this.blockSession(sessionId)
    return this.createLease(entry, false, 0, lineage)
  }

  createLease(entry, reused, messageStart, lineage) {
    let settled = false
    const settle = (success, blocks) => {
      if (settled) return
      settled = true
      entry.busy = false
      if (entry.blocked) {
        entry.blocked = false
        this.unblockSession(entry.sessionId)
      }
      if (!success || entry.invalidated || !entry.pooled || this.entries.get(entry.sessionId) !== entry) {
        if (!success && entry.pooled && this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId)
        return
      }
      if (!hasNativeThreadId(entry.thread) || !Array.isArray(blocks)) {
        entry.invalidated = true
        this.entries.delete(entry.sessionId)
        return
      }
      entry.lineage = {
        ...lineage,
        assistantCursor: lineage.messageCount,
        assistantFingerprint: codexAssistantFingerprint(blocks ?? []),
      }
      entry.lastUsed = this.now()
      this.evict()
    }
    return {
      get messageStart() {
        return messageStart
      },
      get reused() {
        return reused
      },
      thread: entry.thread,
      release: (blocks) => settle(true, blocks),
      invalidate: () => settle(false),
    }
  }

  acquire({ sessionId, lineage, threadOptions, createThread }) {
    this.prune()
    const reusableSession = hasSessionId(sessionId)
    if (reusableSession && this.blocked.has(sessionId)) {
      throw new LlmError(`Codex DSH session "${sessionId}" is busy.`, 'SESSION_BUSY')
    }
    const existing = reusableSession ? this.entries.get(sessionId) : undefined
    let entry
    let reused = false
    let messageStart = 0

    if (existing !== undefined && existing.busy) {
      throw new LlmError(`Codex DSH session "${sessionId}" is busy.`, 'SESSION_BUSY')
    }
    if (existing !== undefined) {
      const signature = digest(threadOptions)
      if (hasNativeThreadId(existing.thread)
        && signature === existing.threadSignature
        && lineageContinues(existing.lineage, lineage)) {
        entry = existing
        reused = true
        messageStart = existing.lineage.assistantCursor + 1
      } else {
        existing.invalidated = true
        this.entries.delete(sessionId)
      }
    }

    if (entry === undefined) {
      const thread = createThread()
      const pooled = reusableSession && (existing === undefined || !existing.busy)
      entry = {
        busy: true,
        lastUsed: this.now(),
        lineage,
        pooled,
        sessionId: reusableSession ? sessionId : undefined,
        thread,
        threadSignature: digest(threadOptions),
      }
      if (pooled) this.entries.set(sessionId, entry)
    } else {
      entry.busy = true
      entry.lastUsed = this.now()
    }
    return this.createLease(entry, reused, messageStart, lineage)
  }
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

/** Decode the usable prefix of one JSON string field from partial structured output. */
export function partialJsonString(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text)
  if (match === null) return { found: false, complete: false, value: '' }
  const start = match.index + match[0].length
  let escaped = false
  let end = text.length
  let complete = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') {
      end = index
      complete = true
      break
    }
  }

  let raw = text.slice(start, end)
  while (raw.length > 0) {
    try {
      return { found: true, complete, value: JSON.parse(`"${raw}"`) }
    } catch {
      raw = raw.slice(0, -1)
    }
  }
  return { found: true, complete, value: '' }
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
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/aborted|abort/i.test(message)) return new LlmError(message, 'ABORTED', { cause: error })
  if (/401|403|authentication|login/i.test(message)) return new LlmError(message, 'AUTH', { cause: error })
  if (/429|rate.?limit/i.test(message)) return new LlmError(message, 'RATE_LIMIT', { cause: error })
  return new LlmError(message, 'CODEX_SDK', { cause: error })
}

function codexAppServerRequest(method, params, {
  signal,
  spawnProcess = spawn,
  timeoutMs = 30_000,
  label = 'request',
  code = 'CODEX_APP_SERVER',
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new LlmError(`Codex ${label} was aborted.`, 'ABORTED'))
      return
    }

    const child = spawnProcess(process.execPath, [
      CODEX_CLI_PATH,
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
    const abort = () => finish(new LlmError(`Codex ${label} was aborted.`, 'ABORTED'))
    const fail = (message, cause) => finish(new LlmError(message, code, { cause }))
    const write = value => child.stdin.write(`${JSON.stringify(value)}\n`)
    const timer = setTimeout(() => fail(`Codex ${label} timed out.`), timeoutMs)

    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => fail(`Unable to start Codex ${label}: ${error.message}`, error))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })
    child.on('exit', (code) => {
      if (!settled) fail(`Codex ${label} exited with code ${String(code)}.${stderr.length > 0 ? ` ${stderr.trim()}` : ''}`)
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
          write({ id: 2, method, params })
          continue
        }
        if (message.id !== 2) continue
        if (message.error !== undefined) {
          fail(`Codex rejected ${label}: ${message.error.message ?? 'unknown error'}`)
          return
        }
        finish(undefined, message.result)
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

/** Read the full visible catalog exposed to the signed-in Codex account. */
export async function discoverCodexCatalog(signal, spawnProcess = spawn) {
  const result = await codexAppServerRequest('model/list', { includeHidden: false, limit: 100 }, {
    signal,
    spawnProcess,
    label: 'model discovery',
    code: 'CODEX_DISCOVERY',
  })
  const rows = Array.isArray(result?.data) ? result.data : []
  return rows
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
}

/** Return discovery candidates in DSH's public model-list shape. */
export async function discoverCodexModels(signal, spawnProcess = spawn) {
  const catalog = await discoverCodexCatalog(signal, spawnProcess)
  return catalog.map(model => ({ id: model.id, name: model.name }))
}

function quotaWindow(value) {
  if (value === null || typeof value !== 'object') return null
  const usedPercent = Number(value.usedPercent)
  if (!Number.isFinite(usedPercent)) return null
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowDurationMins: Number.isFinite(Number(value.windowDurationMins))
      ? Number(value.windowDurationMins)
      : null,
    resetsAt: Number.isFinite(Number(value.resetsAt)) ? Number(value.resetsAt) : null,
  }
}

function quotaBucket(value, fallbackId) {
  if (value === null || typeof value !== 'object') return null
  const id = typeof value.limitId === 'string' && value.limitId.length > 0
    ? value.limitId
    : fallbackId
  if (id.length === 0) return null
  const credits = value.credits !== null && typeof value.credits === 'object'
    ? {
        hasCredits: value.credits.hasCredits === true,
        unlimited: value.credits.unlimited === true,
        balance: typeof value.credits.balance === 'string' ? value.credits.balance : null,
      }
    : null
  return {
    id,
    name: typeof value.limitName === 'string' && value.limitName.length > 0
      ? value.limitName
      : id === 'codex' ? 'Codex' : id,
    planType: typeof value.planType === 'string' ? value.planType : null,
    primary: quotaWindow(value.primary),
    secondary: quotaWindow(value.secondary),
    credits,
    rateLimitReachedType: typeof value.rateLimitReachedType === 'string'
      ? value.rateLimitReachedType
      : null,
  }
}

/** Read account rate-limit windows without exposing account identity or auth data. */
export async function readCodexRateLimits(signal, spawnProcess = spawn) {
  const result = await codexAppServerRequest('account/rateLimits/read', undefined, {
    signal,
    spawnProcess,
    timeoutMs: 15_000,
    label: 'quota lookup',
    code: 'CODEX_QUOTA',
  })
  const rows = result?.rateLimitsByLimitId !== null
    && typeof result?.rateLimitsByLimitId === 'object'
    ? Object.entries(result.rateLimitsByLimitId)
    : []
  const buckets = rows
    .map(([id, value]) => quotaBucket(value, id))
    .filter(Boolean)
    .sort((left, right) => Number(right.id === 'codex') - Number(left.id === 'codex'))
  if (buckets.length === 0) {
    const fallback = quotaBucket(result?.rateLimits, 'codex')
    if (fallback !== null) buckets.push(fallback)
  }
  return {
    buckets,
    resetCredits: Number.isFinite(Number(result?.rateLimitResetCredits?.availableCount))
      ? Number(result.rateLimitResetCredits.availableCount)
      : null,
    fetchedAt: new Date().toISOString(),
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

function registerQuotaRoute(ctx) {
  return ctx.webServer.register({
    kind: 'exact',
    path: `${API_ROOT}/quota`,
    async handler(req, res) {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        json(res, 200, { ok: true, value: await readCodexRateLimits() })
      } catch (error) {
        json(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}

/** DSH provider adapter backed only by the official Codex SDK and ChatGPT login. */
export class CodexSubscriptionAdapter extends LlmAdapter {
  constructor(config = {}, createClient = () => new Codex({
    env: sanitizedEnvironment(),
    config: { forced_login_method: 'chatgpt' },
  }), discoverCatalog = discoverCodexCatalog, threadPool = new CodexThreadPool()) {
    super()
    this.resolveOptions = typeof config === 'function' ? config : () => config
    this.createClient = createClient
    this.discoverCatalog = discoverCatalog
    this.threadPool = threadPool
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
    return resolvedModelInfo(provider, model, modelCapability(model))
  }

  async * stream(options) {
    if (options.temperature !== undefined) {
      throw new LlmError('Codex subscription adapter does not support temperature.', 'UNSUPPORTED_OPTION')
    }
    if (options.stop !== undefined && options.stop.length > 0) {
      throw new LlmError('Codex subscription adapter does not support stop sequences.', 'UNSUPPORTED_OPTION')
    }

    const config = this.options()
    const threadOptions = {
      model: options.model,
      workingDirectory: config.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: config.allowNetworkAccess,
      modelReasoningEffort: options.reasoningEffort,
      threadSource: 'dsh-llm-adapter',
    }
    const lineage = codexRequestLineage(options, threadOptions)
    const isCompaction = options.purpose === 'compaction'
    const isAuxiliary = isCompaction || options.purpose === 'session-title'
    if (isCompaction) this.threadPool.invalidateSession(options.sessionId)
    const lease = isAuxiliary
      ? this.threadPool.acquireIsolated({
          sessionId: options.sessionId,
          lineage,
          threadOptions,
          blockSession: isCompaction,
          createThread: () => this.getClient().startThread(threadOptions),
        })
      : this.threadPool.acquire({
          sessionId: options.sessionId,
          lineage,
          threadOptions,
          createThread: () => this.getClient().startThread(threadOptions),
        })
    let turnCompleted = false
    let turnAccepted = false
    let assistantBlocks = []
    const assistantBlockMap = new Map()

    try {
      const streamed = await lease.thread.runStreamed(buildCodexPrompt(options, {
        messageStart: lease.messageStart,
        continuation: lease.reused,
      }), {
        outputSchema: RESPONSE_SCHEMA,
        signal: options.signal,
      })

      let finalResponse = ''
      let usage
      let reasoning = ''
      let visibleText = ''
      let reasoningStarted = false
      let textStarted = false
      let reasoningEnded = false
      let textEnded = false
      let reasoningIndex
      let textIndex
      let nextIndex = 0

      for await (const event of streamed.events) {
        if ((event.type === 'item.updated' || event.type === 'item.completed')
          && event.item?.type === 'agent_message') {
          finalResponse = event.item.text
          const reasoningField = partialJsonString(finalResponse, 'reasoning')
          const textField = partialJsonString(finalResponse, 'text')
          const nextReasoning = reasoningField.value
          const nextText = textField.value
          if (nextReasoning.length > reasoning.length) {
            if (!reasoningStarted) {
              reasoningStarted = true
              reasoningIndex = nextIndex
              nextIndex += 1
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
            }
            yield { type: 'reasoning-delta', index: reasoningIndex, text: nextReasoning.slice(reasoning.length) }
            reasoning = nextReasoning
          }
          if (reasoningStarted && !reasoningEnded && reasoningField.complete) {
            reasoningEnded = true
            const block = { type: 'reasoning', text: reasoning }
            assistantBlockMap.set(reasoningIndex, block)
            yield { type: 'block-end', index: reasoningIndex, block }
          }
          if (nextText.length > visibleText.length) {
            if (!textStarted) {
              textStarted = true
              textIndex = nextIndex
              nextIndex += 1
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            yield { type: 'text-delta', index: textIndex, text: nextText.slice(visibleText.length) }
            visibleText = nextText
          }
          if (textStarted && !textEnded && textField.complete) {
            textEnded = true
            const block = { type: 'text', text: visibleText }
            assistantBlockMap.set(textIndex, block)
            yield { type: 'block-end', index: textIndex, block }
          }
        } else if (event.type === 'turn.completed') {
          usage = event.usage
          turnCompleted = true
        } else if (event.type === 'turn.failed') {
          throw new Error(event.error?.message ?? 'Codex turn failed.')
        } else if (event.type === 'error') {
          throw new Error(event.message)
        }
      }

      const response = parseStructuredResponse(finalResponse)
      if (response.reasoning.length > reasoning.length) {
        if (!reasoningStarted) {
          reasoningStarted = true
          reasoningIndex = nextIndex
          nextIndex += 1
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        yield { type: 'reasoning-delta', index: reasoningIndex, text: response.reasoning.slice(reasoning.length) }
      }
      if (response.text.length > visibleText.length) {
        if (!textStarted) {
          textStarted = true
          textIndex = nextIndex
          nextIndex += 1
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        yield { type: 'text-delta', index: textIndex, text: response.text.slice(visibleText.length) }
      }
      if (reasoningStarted && !reasoningEnded) {
        const block = { type: 'reasoning', text: response.reasoning }
        assistantBlockMap.set(reasoningIndex, block)
        yield { type: 'block-end', index: reasoningIndex, block }
      }
      if (textStarted && !textEnded) {
        const block = { type: 'text', text: response.text }
        assistantBlockMap.set(textIndex, block)
        yield { type: 'block-end', index: textIndex, block }
      }

      let index = nextIndex

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
        assistantBlockMap.set(index, block)
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

      assistantBlocks = [...assistantBlockMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, block]) => block)
      const mappedUsage = mapUsage(usage ?? null)
      if (mappedUsage !== undefined) yield { type: 'usage', usage: mappedUsage }
      yield {
        type: 'finish',
        reason: response.tool_calls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
      }
      turnAccepted = true
    } catch (error) {
      throw classifySdkError(error)
    } finally {
      if (turnCompleted && turnAccepted && options.signal?.aborted !== true && hasNativeThreadId(lease.thread)) {
        lease.release(assistantBlocks)
      }
      else lease.invalidate()
    }
  }
}

export function apply(ctx, config) {
  let current = () => config
  const adapter = new CodexSubscriptionAdapter(() => current())
  registerQuotaRoute(ctx)
  ctx.llm.registerModelDiscovery(
    CODEX_SETTINGS_NAMESPACE,
    (_request, signal) => discoverCodexModels(signal),
  )
  ctx.llm.registerAdapter([CODEX_PROVIDER], adapter)
  installSettingsSection(ctx, CODEX_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange() {},
  })
}

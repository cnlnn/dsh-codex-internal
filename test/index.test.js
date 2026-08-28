import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  buildCodexPrompt,
  CODEX_CLI_PATH,
  CODEX_PROVIDER,
  CodexSubscriptionAdapter,
  discoverCodexCatalog,
  mapUsage,
  sanitizedEnvironment,
} from '../index.js'

test('account discovery drops hidden and ChatGPT-incompatible catalog rows', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  child.stdin = {
    write(line) {
      const request = JSON.parse(line)
      queueMicrotask(() => {
        if (request.id === 1) {
          child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
        } else {
          child.stdout.write(`${JSON.stringify({
            id: 2,
            result: {
              data: [
                { model: 'gpt-5.6-sol', displayName: 'Sol', hidden: false },
                { model: 'gpt-5.2', displayName: 'Unsupported', hidden: false },
                { model: 'gpt-reserve', displayName: 'Hidden', hidden: true },
              ],
            },
          })}\n`)
        }
      })
      return true
    },
  }

  const models = await discoverCodexCatalog(undefined, (command, args) => {
    assert.equal(command, process.execPath)
    assert.equal(args[0], CODEX_CLI_PATH)
    return child
  })
  assert.deepEqual(models.map(model => model.id), ['gpt-5.6-sol'])
})

test('sanitizedEnvironment excludes ambient credentials', () => {
  assert.deepEqual(sanitizedEnvironment({
    HOME: '/home/test',
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\test',
    SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'secret',
    DEEPSEEK_API_KEY: 'secret',
    HTTPS_PROXY: 'http://user:pass@example.test',
  }), {
    HOME: '/home/test',
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\test',
    SystemRoot: 'C:\\Windows',
  })
})

test('adapter advertises every visible Codex account model and its reasoning efforts', async () => {
  const catalog = [
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'low',
    },
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
    },
  ]
  const adapter = new CodexSubscriptionAdapter(
    {},
    () => assert.fail('client must stay lazy'),
    async () => catalog,
  )
  assert.deepEqual(adapter.providerInfo(CODEX_PROVIDER), { id: 'codex', name: 'Codex' })
  const models = await adapter.listModels(CODEX_PROVIDER)
  assert.deepEqual(models.map(model => model.id), [
    'gpt-5.6-sol',
    'gpt-5.5',
  ])
  assert.ok(models.every(model => model.description === undefined))
  const sol = await adapter.resolveModel(CODEX_PROVIDER, 'gpt-5.6-sol')
  assert.equal(sol.reasoning.defaultEffort, 'low')
  assert.deepEqual(sol.reasoning.efforts.map(effort => effort.id), [
    'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
  ])
})

test('adapter adds configured custom model ids without rejecting them', async () => {
  const adapter = new CodexSubscriptionAdapter(
    { models: [{ id: 'my-codex-model', name: 'My Codex Model' }] },
    () => assert.fail('client must stay lazy'),
    async () => [{ id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', efforts: [], defaultEffort: 'medium' }],
  )
  assert.deepEqual((await adapter.listModels(CODEX_PROVIDER)).map(model => model.id), [
    'gpt-5.6-luna',
    'my-codex-model',
  ])
  const custom = await adapter.resolveModel(CODEX_PROVIDER, 'my-codex-model')
  assert.equal(custom.name, 'My Codex Model')
})

test('buildCodexPrompt carries the DSH system, history, and tool schemas', () => {
  const prompt = buildCodexPrompt({
    system: 'system instruction',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'inspect' }],
    }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
  })
  assert.match(prompt, /system instruction/)
  assert.match(prompt, /"text":"inspect"/)
  assert.match(prompt, /"name":"read"/)
  assert.match(prompt, /Do not use your own shell/)
})

test('mapUsage produces disjoint DSH counters', () => {
  assert.deepEqual(mapUsage({
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 10,
    output_tokens: 30,
    reasoning_output_tokens: 5,
  }), {
    inputTokens: 70,
    outputTokens: 30,
    totalTokens: 130,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    reasoningTokens: 5,
  })
})

test('adapter streams text and forwards the selected Codex model', async () => {
  const calls = []
  const adapter = new CodexSubscriptionAdapter({ workingDirectory: '/home/user' }, () => ({
    startThread(options) {
      calls.push(options)
      return {
        async run(prompt, turnOptions) {
          calls.push({ prompt, turnOptions })
          return {
            finalResponse: JSON.stringify({ reasoning: 'brief', text: 'done', tool_calls: [] }),
            usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              cache_write_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 1,
            },
            items: [],
          }
        },
      }
    },
  }))
  const signal = new AbortController().signal
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    signal,
  })) chunks.push(chunk)

  assert.equal(calls[0].model, 'gpt-5.6-sol')
  assert.equal(calls[0].modelReasoningEffort, 'high')
  assert.equal(calls[0].sandboxMode, 'read-only')
  assert.equal(calls[0].networkAccessEnabled, false)
  assert.equal(calls[1].turnOptions.signal, signal)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'done'))
})

test('adapter converts structured Codex requests into DSH tool calls', async () => {
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        async run() {
          return {
            finalResponse: JSON.stringify({
              reasoning: '',
              text: '',
              tool_calls: [{ id: 'call-1', name: 'read', arguments_json: '{"path":"README.md"}' }],
            }),
            usage: null,
            items: [],
          }
        },
      }
    },
  }))
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codex',
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
  })) chunks.push(chunk)

  assert.ok(chunks.some(chunk => chunk.type === 'block-end'
    && chunk.block.type === 'tool-call'
    && chunk.block.arguments === '{"path":"README.md"}'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

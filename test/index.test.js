import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  buildCodexPrompt,
  CODEX_CLI_PATH,
  CODEX_PROVIDER,
  CodexSubscriptionAdapter,
  discoverCodexCatalog,
  mapUsage,
  partialJsonString,
  readCodexRateLimits,
  sanitizedEnvironment,
} from '../index.js'

function streamedEvents(parts, usage = null) {
  return (async function * () {
    for (const text of parts) {
      yield { type: 'item.updated', item: { type: 'agent_message', id: 'message-1', text } }
    }
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'message-1', text: parts.at(-1) } }
    yield { type: 'turn.completed', usage }
  })()
}

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

test('quota lookup exposes rate-limit windows without account identity', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  child.stdin = {
    write(line) {
      const request = JSON.parse(line)
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify(request.id === 1
          ? { id: 1, result: {} }
          : {
              id: 2,
              result: {
                rateLimits: null,
                rateLimitsByLimitId: {
                  codex: {
                    limitId: 'codex',
                    primary: { usedPercent: 36, windowDurationMins: 10_080, resetsAt: 1_788_452_814 },
                    secondary: null,
                    credits: { hasCredits: false, unlimited: false, balance: '0' },
                    planType: 'pro',
                  },
                },
                rateLimitResetCredits: { availableCount: 0, credits: [] },
                email: 'must-not-leak@example.test',
              },
            })}\n`)
      })
      return true
    },
  }

  const quota = await readCodexRateLimits(undefined, () => child)
  assert.equal(quota.buckets[0].name, 'Codex')
  assert.equal(quota.buckets[0].planType, 'pro')
  assert.equal(quota.buckets[0].primary.usedPercent, 36)
  assert.equal(quota.buckets[0].primary.windowDurationMins, 10_080)
  assert.equal(quota.resetCredits, 0)
  assert.equal(JSON.stringify(quota).includes('must-not-leak'), false)
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
    { models: [{
      id: 'my-codex-model',
      name: 'My Codex Model',
      contextWindow: 200_000,
      maxTokens: 20_000,
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    }] },
    () => assert.fail('client must stay lazy'),
    async () => [{ id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', efforts: [], defaultEffort: 'medium' }],
  )
  assert.deepEqual((await adapter.listModels(CODEX_PROVIDER)).map(model => model.id), [
    'gpt-5.6-luna',
    'my-codex-model',
  ])
  const custom = await adapter.resolveModel(CODEX_PROVIDER, 'my-codex-model')
  assert.equal(custom.name, 'My Codex Model')
  assert.equal(custom.context.contextWindow, 200_000)
  assert.equal(custom.defaultMaxTokens, 20_000)
  assert.deepEqual(custom.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(custom.reasoning.defaultEffort, 'high')
})

test('partialJsonString decodes streamed JSON string prefixes', () => {
  assert.deepEqual(partialJsonString('{"reasoning":"line\\npar', 'reasoning'), {
    found: true,
    complete: false,
    value: 'line\npar',
  })
  assert.deepEqual(partialJsonString('{"reasoning":"done","text":"ok"}', 'reasoning'), {
    found: true,
    complete: true,
    value: 'done',
  })
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
        async runStreamed(prompt, turnOptions) {
          calls.push({ prompt, turnOptions })
          const finalResponse = JSON.stringify({ reasoning: 'brief', text: 'done', tool_calls: [] })
          return {
            events: streamedEvents([
              '{"reasoning":"br',
              '{"reasoning":"brief","text":"do',
              finalResponse,
            ], {
              input_tokens: 10,
              cached_input_tokens: 2,
              cache_write_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 1,
            }),
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
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['do', 'ne'])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text), ['br', 'ief'])
  assert.ok(chunks.findIndex(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    < chunks.findIndex(chunk => chunk.type === 'block-start' && chunk.blockType === 'text'))
})

test('adapter converts structured Codex requests into DSH tool calls', async () => {
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        async runStreamed() {
          const finalResponse = JSON.stringify({
            reasoning: '',
            text: '',
            tool_calls: [{ id: 'call-1', name: 'read', arguments_json: '{"path":"README.md"}' }],
          })
          return {
            events: streamedEvents([finalResponse]),
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

test('client exposes Codex model controls in plugin configuration', async () => {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const server = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(client, /settings\.plugin\.item/)
  assert.match(client, /const inject = \["slots", "connection"\]/)
  assert.match(client, /工作目录/)
  assert.match(client, /允许 Codex 访问网络/)
  assert.match(client, /上下文窗口/)
  assert.match(client, /默认推理强度/)
  assert.match(client, /api\.llm\.discoverModels/)
  assert.match(client, /Codex 额度/)
  assert.match(client, /API_ROOT.*quota/s)
  const saveBody = client.slice(client.indexOf('const save = async'), client.indexOf('const reset = async'))
  assert.equal(saveBody.match(/\bconst models\b/g)?.length, 1)
  assert.match(saveBody, /const persistedModels/)
  assert.doesNotMatch(server, /registerConfigurableProviders/)
})

import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { Codex } from '@openai/codex-sdk'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  buildCodexPrompt,
  buildCompactionPrompt,
  CODEX_CLI_PATH,
  CODEX_ADAPTER_CONTEXT_WINDOW,
  CODEX_COMPACTION_MAX_CALLS,
  CODEX_COMPACTION_MAX_CALLS_PER_LEVEL,
  CODEX_SAFE_PROMPT_CHAR_BUDGET,
  CODEX_PROVIDER,
  CodexSubscriptionAdapter,
  CodexThreadPool,
  codexAssistantFingerprint,
  classifySdkError,
  discoverCodexCatalog,
  mapUsage,
  packCompactionFragments,
  prepareSegmentedCompaction,
  partialJsonString,
  readCodexRateLimits,
  sanitizedEnvironment,
  splitCompactionSource,
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

async function collectStream(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

async function collectIterable(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function textMessage(id, text, role = 'user') {
  return {
    id,
    role,
    content: [{ type: 'text', text }],
  }
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
  assert.equal(models[0].contextWindow, CODEX_ADAPTER_CONTEXT_WINDOW)
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

test('adapter merges explicit metadata over live rows and always exposes context capacity', async () => {
  const adapter = new CodexSubscriptionAdapter(
    { models: [{
      id: 'gpt-5.6-sol',
      name: 'Pinned Sol',
      contextWindow: 123_456,
      maxTokens: 7_000,
    }] },
    () => assert.fail('client must stay lazy'),
    async () => [{
      id: 'gpt-5.6-sol',
      name: 'Live Sol',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    }, {
      id: 'gpt-dynamic',
      name: 'Dynamic',
      efforts: ['medium'],
      defaultEffort: 'medium',
    }],
  )

  const sol = await adapter.resolveModel(CODEX_PROVIDER, 'gpt-5.6-sol')
  assert.equal(sol.name, 'Pinned Sol')
  assert.equal(sol.context.contextWindow, 123_456)
  assert.equal(sol.defaultMaxTokens, 7_000)
  assert.deepEqual(sol.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal((await adapter.resolveModel(CODEX_PROVIDER, 'gpt-dynamic')).context.contextWindow,
    CODEX_ADAPTER_CONTEXT_WINDOW)
  assert.equal((await adapter.resolveModel(CODEX_PROVIDER, 'unknown-model')).context.contextWindow,
    CODEX_ADAPTER_CONTEXT_WINDOW)
  assert.deepEqual((await adapter.listModels(CODEX_PROVIDER)).map(model => model.name), [
    'Pinned Sol',
    'Dynamic',
  ])
})

test('context overflow classification is conservative and keeps the original cause', () => {
  const sdkError = new Error('Input exceeds the maximum length of 1048576 characters')
  const classified = classifySdkError(sdkError)
  assert.equal(classified.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(classified.cause, sdkError)
  assert.match(classified.message, /1048576/)

  const appServerError = classifySdkError({ error: { code: 'ContextWindowExceeded', message: 'request rejected' } })
  assert.equal(appServerError.code, 'CONTEXT_WINDOW_EXCEEDED')
  const codeBearingError = new Error('request rejected')
  codeBearingError.code = 'ContextWindowExceeded'
  assert.equal(classifySdkError(codeBearingError).code, 'CONTEXT_WINDOW_EXCEEDED')
  const nestedCodeError = new Error('request rejected')
  nestedCodeError.data = { detail: { type: 'ContextWindowExceeded' } }
  assert.equal(classifySdkError(nestedCodeError).code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(classifySdkError({ status: 400, data: { code: 'invalid_request' }, message: 'invalid request' }).code,
    'CODEX_SDK')
  assert.equal(classifySdkError({ status: 400, message: 'invalid request' }).code, 'CODEX_SDK')
})

test('adapter prepareCall exposes the conservative DSH context contract', async () => {
  const adapter = new CodexSubscriptionAdapter({}, () => ({ startThread() {} }), async () => [])
  const prepared = await adapter.prepareCall(CODEX_PROVIDER, 'gpt-live-or-custom')
  assert.equal(prepared.model.context.contextWindow, CODEX_ADAPTER_CONTEXT_WINDOW)
})

test('DSH LlmRuntime.prepareCall preserves the Codex context contract', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const adapter = new CodexSubscriptionAdapter({}, () => ({ startThread() {} }), async () => [])
  runtime.registerAdapter([CODEX_PROVIDER], adapter)
  const prepared = await runtime.prepareCall({
    provider: CODEX_PROVIDER,
    model: 'gpt-runtime-boundary',
    system: '',
    messages: [],
  })
  assert.equal(prepared.context.contextWindow, CODEX_ADAPTER_CONTEXT_WINDOW)
})

test('prepared adapter calls keep the configuration snapshot across dispatch', async () => {
  let config = {
    workingDirectory: '/old-cwd',
    allowNetworkAccess: false,
    models: [{ id: 'gpt-snapshot', name: 'Old model', contextWindow: 111_111 }],
  }
  const starts = []
  const adapter = new CodexSubscriptionAdapter(() => config, () => ({
    startThread(options) {
      starts.push(options)
      return {
        id: `thread-${starts.length}`,
        async runStreamed() {
          return { events: streamedEvents([JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })]) }
        },
      }
    },
  }), async () => [])
  const prepared = await adapter.prepareCall(CODEX_PROVIDER, 'gpt-snapshot')
  config = {
    workingDirectory: '/new-cwd',
    allowNetworkAccess: true,
    models: [{ id: 'gpt-snapshot', name: 'New model', contextWindow: 222_222 }],
  }

  const request = {
    provider: CODEX_PROVIDER,
    model: 'gpt-snapshot',
    messages: [textMessage('request-1', 'hello')],
  }
  await collectIterable(prepared.stream(request))
  assert.equal(prepared.model.name, 'Old model')
  assert.equal(prepared.model.context.contextWindow, 111_111)
  assert.equal(starts[0].workingDirectory, '/old-cwd')
  assert.equal(starts[0].networkAccessEnabled, false)

  const next = await adapter.prepareCall(CODEX_PROVIDER, 'gpt-snapshot')
  assert.equal(next.model.name, 'New model')
  assert.equal(next.model.context.contextWindow, 222_222)
  await collectIterable(next.stream({ ...request, messages: [textMessage('request-2', 'again')] }))
  assert.equal(starts[1].workingDirectory, '/new-cwd')
  assert.equal(starts[1].networkAccessEnabled, true)
})

test('DSH prepared dispatch does not re-read plugin configuration', async () => {
  let config = {
    workingDirectory: '/runtime-old-cwd',
    allowNetworkAccess: false,
    models: [{ id: 'gpt-runtime-snapshot', name: 'Runtime old', contextWindow: 101_010 }],
  }
  const starts = []
  const adapter = new CodexSubscriptionAdapter(() => config, () => ({
    startThread(options) {
      starts.push(options)
      return {
        id: `runtime-thread-${starts.length}`,
        async runStreamed() {
          return { events: streamedEvents([JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })]) }
        },
      }
    },
  }), async () => [])
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  runtime.registerAdapter([CODEX_PROVIDER], adapter)
  const request = {
    provider: CODEX_PROVIDER,
    model: 'gpt-runtime-snapshot',
    messages: [textMessage('runtime-request', 'hello')],
  }
  const prepared = await runtime.prepareCall(request)
  config = {
    workingDirectory: '/runtime-new-cwd',
    allowNetworkAccess: true,
    models: [{ id: 'gpt-runtime-snapshot', name: 'Runtime new', contextWindow: 202_020 }],
  }
  await collectIterable(prepared.stream(request))
  assert.equal(prepared.context.contextWindow, 101_010)
  assert.equal(starts[0].workingDirectory, '/runtime-old-cwd')
  assert.equal(starts[0].networkAccessEnabled, false)

  const next = await runtime.prepareCall(request)
  await collectIterable(next.stream(request))
  assert.equal(next.context.contextWindow, 202_020)
  assert.equal(starts[1].workingDirectory, '/runtime-new-cwd')
  assert.equal(starts[1].networkAccessEnabled, true)
})

test('catalog and resolveModel propagate an abort signal without falling back', async () => {
  const controller = new AbortController()
  let received
  let started
  let release
  const discoveryStarted = new Promise(resolve => {
    started = resolve
  })
  const adapter = new CodexSubscriptionAdapter({}, () => assert.fail('client must stay lazy'), async (signal) => {
    received = signal
    started()
    return new Promise(resolve => {
      release = resolve
    })
  })
  const pending = adapter.resolveModel(CODEX_PROVIDER, 'gpt-abort', controller.signal)
  await discoveryStarted
  controller.abort()
  await assert.rejects(pending, error => error.code === 'ABORTED')
  assert.equal(received, undefined)
  release([])
  await adapter.catalog()
})

test('shared catalog discovery lets caller A continue when caller B aborts', async () => {
  let started
  let release
  let calls = 0
  const discoveryStarted = new Promise(resolve => {
    started = resolve
  })
  const adapter = new CodexSubscriptionAdapter({}, () => assert.fail('client must stay lazy'), async (signal) => {
    assert.equal(signal, undefined)
    calls += 1
    started()
    return new Promise(resolve => {
      release = resolve
    })
  })
  const a = adapter.resolveModel(CODEX_PROVIDER, 'gpt-shared', new AbortController().signal)
  await discoveryStarted
  const bController = new AbortController()
  const b = adapter.resolveModel(CODEX_PROVIDER, 'gpt-shared', bController.signal)
  bController.abort()
  await assert.rejects(b, error => error.code === 'ABORTED')
  assert.equal(getEventListeners(bController.signal, 'abort').length, 0)
  release([{ id: 'gpt-shared', name: 'Shared model' }])
  const resolved = await a
  assert.equal(resolved.name, 'Shared model')
  assert.equal(calls, 1)
})

test('shared catalog discovery lets caller B continue when caller A aborts', async () => {
  let started
  let release
  let calls = 0
  const discoveryStarted = new Promise(resolve => {
    started = resolve
  })
  const adapter = new CodexSubscriptionAdapter({}, () => assert.fail('client must stay lazy'), async (signal) => {
    assert.equal(signal, undefined)
    calls += 1
    started()
    return new Promise(resolve => {
      release = resolve
    })
  })
  const aController = new AbortController()
  const a = adapter.resolveModel(CODEX_PROVIDER, 'gpt-shared', aController.signal)
  await discoveryStarted
  const bController = new AbortController()
  const b = adapter.listModels(CODEX_PROVIDER, bController.signal)
  aController.abort()
  await assert.rejects(a, error => error.code === 'ABORTED')
  assert.equal(getEventListeners(aController.signal, 'abort').length, 0)
  release([{ id: 'gpt-shared', name: 'Shared model' }])
  const models = await b
  assert.equal(getEventListeners(bController.signal, 'abort').length, 0)
  assert.deepEqual(models.map(model => model.name), ['Shared model'])
  assert.equal(calls, 1)
})

test('catalog shares failures and refreshes after its cache TTL', async () => {
  let release
  let started
  let calls = 0
  const discoveryStarted = new Promise(resolve => {
    started = resolve
  })
  const failure = new Error('catalog unavailable')
  const adapter = new CodexSubscriptionAdapter({}, () => assert.fail('client must stay lazy'), async (signal) => {
    assert.equal(signal, undefined)
    calls += 1
    if (calls === 1) {
      started()
      return new Promise((resolve, reject) => {
        release = reject
      })
    }
    return [{ id: 'gpt-refreshed', name: 'Refreshed model' }]
  })
  const first = adapter.catalog()
  await discoveryStarted
  const second = adapter.catalog()
  release(failure)
  const results = await Promise.allSettled([first, second])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[0].reason, failure)
  assert.equal(results[1].reason, failure)
  const cached = await adapter.catalog()
  assert.equal(cached[0].id, 'gpt-refreshed')
  assert.equal(calls, 2)
  adapter.catalogAt -= 300_001
  const refreshed = await adapter.catalog()
  assert.equal(refreshed[0].id, 'gpt-refreshed')
  assert.equal(calls, 3)
})

test('real Codex SDK accepts a safe-size lazy input without login or process start', async () => {
  const codex = new Codex({ env: {}, config: { forced_login_method: 'chatgpt' } })
  const thread = codex.startThread({ model: 'gpt-5.6-sol' })
  assert.equal(thread.id, null)
  assert.equal('compact' in thread, false)
  const streamed = await thread.runStreamed('x'.repeat(CODEX_SAFE_PROMPT_CHAR_BUDGET - 1))
  assert.equal(typeof streamed.events[Symbol.asyncIterator], 'function')
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

test('compaction source preserves message, block, and tool-result order across slices', () => {
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    system: 'system-sentinel',
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
    messages: [
      textMessage('user-1', 'first-sentinel'),
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }],
      },
      {
        id: 'tool-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'tool-result-sentinel' }],
        }],
      },
      textMessage('instruction', 'final-compaction-instruction'),
    ],
  }
  const fragments = splitCompactionSource(options)
  assert.deepEqual(fragments.map(fragment => fragment.order), fragments.map((_, index) => index))
  assert.ok(fragments.find(fragment => fragment.text === 'first-sentinel'))
  assert.ok(fragments.find(fragment => fragment.text === 'tool-result-sentinel'))
  const toolCallFragments = fragments.filter(fragment => fragment.metadata?.toolCallId === 'call-1')
  assert.ok(toolCallFragments.length >= 2)
  assert.ok(toolCallFragments.every(fragment => fragment.metadata.pair === 'tool:call-1'))
  assert.ok(toolCallFragments.every(fragment => fragment.metadata.part === 1))
  assert.ok(toolCallFragments.some(fragment => fragment.metadata.pairType === 'tool-call'))
  assert.ok(toolCallFragments.some(fragment => fragment.metadata.pairType === 'tool-result'))
  assert.match(buildCompactionPrompt(options, fragments, 'intermediate'), /first-sentinel/)
  assert.match(buildCompactionPrompt(options, fragments, 'intermediate'), /tool-result-sentinel/)
})

test('compaction packing keeps every prompt below the supplied budget and every source character', () => {
  const source = 'BEGIN-SENTINEL-' + 'x'.repeat(6_000) + '-END-SENTINEL'
  const toolSource = 'TOOL-BEGIN-' + 'y'.repeat(4_000) + '-TOOL-END'
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    messages: [
      textMessage('user-1', source),
      {
        id: 'tool-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: toolSource }],
        }],
      },
      textMessage('instruction', 'summarize'),
    ],
  }
  const budget = 2_400
  const groups = packCompactionFragments(options, splitCompactionSource(options), 'intermediate', budget)
  assert.ok(groups.length > 1)
  assert.ok(groups.every(group => buildCompactionPrompt(options, group, 'intermediate').length <= budget))
  const textParts = groups.flatMap(group => group)
    .filter(fragment => fragment.id.startsWith('message:0:'))
    .sort((left, right) => (left.part ?? 1) - (right.part ?? 1))
    .map(fragment => fragment.text)
  assert.equal(textParts.join(''), source)
  const toolParts = groups.flatMap(group => group)
    .filter(fragment => fragment.metadata?.toolResultId === 'call-1' && fragment.metadata.blockType === 'text')
    .sort((left, right) => (left.part ?? 1) - (right.part ?? 1))
    .map(fragment => fragment.text)
  assert.equal(toolParts.join(''), toolSource)
})

test('compaction prompt just below the safe budget stays on one isolated call', async () => {
  const base = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
  }
  let low = 0
  let high = CODEX_SAFE_PROMPT_CHAR_BUDGET
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = { ...base, messages: [textMessage('user-1', 'x'.repeat(middle))] }
    if (buildCodexPrompt(candidate).length < CODEX_SAFE_PROMPT_CHAR_BUDGET) low = middle
    else high = middle - 1
  }
  const options = { ...base, messages: [textMessage('user-1', 'x'.repeat(low))] }
  assert.ok(buildCodexPrompt(options).length < CODEX_SAFE_PROMPT_CHAR_BUDGET)
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          return { events: streamedEvents([JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })]) }
        },
      }
    },
  }))
  await collectStream(adapter, options)
  assert.equal(starts, 1)
})

test('segmented compaction recursively summarizes and accumulates all usage', async () => {
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    system: 'system',
    messages: [textMessage('user-1', 'A'.repeat(5_000)), textMessage('instruction', 'keep facts')],
  }
  const calls = []
  let created = 0
  const result = await prepareSegmentedCompaction(
    options,
    new AbortController().signal,
    () => ({
      id: `isolated-${++created}`,
      async runStreamed(prompt) {
        calls.push(prompt)
        const text = prompt.includes('final pass') ? 'final-summary' : `intermediate-${calls.length}`
        return { events: streamedEvents([
          JSON.stringify({ reasoning: '', text, tool_calls: [] }),
        ], {
          input_tokens: 10,
          cached_input_tokens: 2,
          cache_write_input_tokens: 1,
          output_tokens: 3,
          reasoning_output_tokens: 4,
        }) }
      },
    }),
    { budget: 2_400 },
  )

  assert.ok(calls.length > 2)
  assert.ok(calls.every(prompt => prompt.length <= 2_400))
  assert.match(result.prompt, /final-summary|intermediate-/)
  assert.deepEqual(result.usage, {
    input_tokens: calls.length * 10,
    cached_input_tokens: calls.length * 2,
    cache_write_input_tokens: calls.length,
    output_tokens: calls.length * 3,
    reasoning_output_tokens: calls.length * 4,
  })
})

test('segmented compaction keeps completed intermediate usage when final call fails', async () => {
  const prompts = []
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          if (!prompt.includes('final pass')) {
            return {
              events: streamedEvents([
                JSON.stringify({ reasoning: '', text: `summary-${starts}`, tool_calls: [] }),
              ], {
                input_tokens: 11,
                cached_input_tokens: 3,
                cache_write_input_tokens: 1,
                output_tokens: 5,
                reasoning_output_tokens: 2,
              }),
            }
          }
          return {
            events: (async function * () {
              yield {
                type: 'item.completed',
                item: {
                  type: 'agent_message',
                  id: 'final-message',
                  text: JSON.stringify({ reasoning: '', text: 'partial final', tool_calls: [] }),
                },
              }
              yield {
                type: 'turn.completed',
                usage: {
                  input_tokens: 17,
                  cached_input_tokens: 4,
                  cache_write_input_tokens: 2,
                  output_tokens: 6,
                  reasoning_output_tokens: 3,
                },
              }
              yield { type: 'turn.failed', error: new Error('final compaction failed') }
            })(),
          }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    sessionId: 'session-compaction-final-failure',
    messages: [
      textMessage('history', 'h'.repeat(CODEX_SAFE_PROMPT_CHAR_BUDGET)),
      textMessage('instruction', 'summarize the history'),
    ],
  }

  let failure
  await assert.rejects(collectStream(adapter, options), error => {
    failure = error
    return /final compaction failed/.test(error.message)
  })
  const usage = failure.codexUsage
  const intermediateCalls = starts - 1
  assert.equal(prompts.length, starts)
  assert.deepEqual(usage, {
    input_tokens: intermediateCalls * 11 + 17,
    cached_input_tokens: intermediateCalls * 3 + 4,
    cache_write_input_tokens: intermediateCalls + 2,
    output_tokens: intermediateCalls * 5 + 6,
    reasoning_output_tokens: intermediateCalls * 2 + 3,
  })
  assert.equal(failure.code, 'CODEX_SDK')
})

test('segmented compaction emits completed intermediate usage before an abort', async () => {
  const controller = new AbortController()
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          if (prompt.includes('final pass')) {
            controller.abort()
            throw new Error('aborted by caller')
          }
          return {
            events: streamedEvents([
              JSON.stringify({ reasoning: '', text: 'intermediate summary', tool_calls: [] }),
            ], {
              input_tokens: 13,
              cached_input_tokens: 5,
              cache_write_input_tokens: 2,
              output_tokens: 7,
              reasoning_output_tokens: 1,
            }),
          }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    sessionId: 'session-compaction-abort-after-summary',
    signal: controller.signal,
    messages: [
      textMessage('history', 'h'.repeat(CODEX_SAFE_PROMPT_CHAR_BUDGET)),
      textMessage('instruction', 'summarize the history'),
    ],
  }

  let failure
  const chunks = []
  await assert.rejects((async () => {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  })(), error => {
    failure = error
    return error.code === 'ABORTED'
  })
  const usageChunks = chunks.filter(chunk => chunk.type === 'usage')
  assert.equal(starts > 1, true)
  assert.equal(usageChunks.length, 1)
  assert.deepEqual(usageChunks[0].usage, {
    inputTokens: (starts - 1) * 6,
    outputTokens: (starts - 1) * 7,
    totalTokens: (starts - 1) * 20,
    cacheReadTokens: (starts - 1) * 5,
    cacheWriteTokens: (starts - 1) * 2,
    reasoningTokens: starts - 1,
  })
  assert.deepEqual(failure.codexUsage, {
    input_tokens: (starts - 1) * 13,
    cached_input_tokens: (starts - 1) * 5,
    cache_write_input_tokens: (starts - 1) * 2,
    output_tokens: (starts - 1) * 7,
    reasoning_output_tokens: starts - 1,
  })
})

test('segmented compaction rejects a non-shrinking hierarchy and hard call limits', async () => {
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    messages: [textMessage('history', 'h'.repeat(7_000)), textMessage('instruction', 'summarize')],
  }
  let calls = 0
  await assert.rejects(prepareSegmentedCompaction(
    options,
    new AbortController().signal,
    () => ({
      id: `isolated-${++calls}`,
      async runStreamed() {
        return {
          events: streamedEvents([
            JSON.stringify({ reasoning: '', text: 'r'.repeat(10_000), tool_calls: [] }),
          ]),
        }
      },
    }),
    { budget: 2_000, maxCallsPerLevel: CODEX_COMPACTION_MAX_CALLS_PER_LEVEL, maxCalls: CODEX_COMPACTION_MAX_CALLS },
  ), error => error.code === 'CONTEXT_WINDOW_EXCEEDED')
  assert.ok(calls > 0)

  calls = 0
  await assert.rejects(prepareSegmentedCompaction(
    options,
    new AbortController().signal,
    () => ({
      id: `isolated-${++calls}`,
      async runStreamed() {
        return { events: streamedEvents([JSON.stringify({ reasoning: '', text: 'small', tool_calls: [] })]) }
      },
    }),
    { budget: 2_000, maxCallsPerLevel: 1, maxCalls: 2 },
  ), error => error.code === 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(calls, 0)
})

test('compaction requires the final user instruction independently of message source', async () => {
  const base = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
  }
  const createThread = () => {
    throw new Error('invalid compaction must not create a thread')
  }
  await assert.rejects(prepareSegmentedCompaction({
    ...base,
    messages: [textMessage('history', 'facts'), textMessage('last', 'not an assistant instruction', 'assistant')],
  }, new AbortController().signal, createThread), error => error.code === 'PROTOCOL')
  await assert.rejects(prepareSegmentedCompaction({
    ...base,
    messages: [textMessage('history', 'facts'), textMessage('last', '   ')],
  }, new AbortController().signal, createThread), error => error.code === 'PROTOCOL')

  const options = {
    ...base,
    messages: [textMessage('history', 'facts'), {
      ...textMessage('last', 'summarize these facts'),
      source: { kind: 'not-a-plugin' },
    }],
  }
  const result = await prepareSegmentedCompaction(
    options,
    new AbortController().signal,
    () => ({
      id: 'isolated-valid',
      async runStreamed(prompt) {
        return { events: streamedEvents([
          JSON.stringify({ reasoning: '', text: prompt.includes('final pass') ? 'final' : 'intermediate', tool_calls: [] }),
        ]) }
      },
    }),
    { budget: 2_000 },
  )
  assert.match(result.prompt, /summarize these facts/)
})

test('tool-call argument slices retain paired ids and reconstruct valid JSON', () => {
  const argumentsText = JSON.stringify({ path: 'a', payload: 'q'.repeat(6_000) })
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    messages: [
      {
        id: 'assistant-call',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: argumentsText }],
      },
      {
        id: 'tool-result',
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'result-' + 'r'.repeat(6_000) }],
        }],
      },
      textMessage('instruction', 'summarize'),
    ],
  }
  const fragments = splitCompactionSource(options, { includeFinalInstruction: false })
  const groups = packCompactionFragments(options, fragments, 'intermediate', 2_000)
  const toolFragments = groups.flatMap(group => group)
    .filter(fragment => fragment.metadata?.toolCallId === 'call-1')
  assert.ok(toolFragments.length > 4)
  assert.ok(toolFragments.every(fragment => fragment.metadata.pair === 'tool:call-1'))
  assert.ok(toolFragments.every(fragment => Number.isInteger(fragment.metadata.part)))
  assert.ok(toolFragments.every(fragment => fragment.metadata.part >= 1))
  const argumentParts = toolFragments
    .filter(fragment => fragment.metadata.pairType === 'tool-call' && fragment.metadata.field === 'arguments')
    .sort((left, right) => left.metadata.part - right.metadata.part)
  assert.equal(JSON.parse(argumentParts.map(fragment => fragment.text).join('')).payload.length, 6_000)
  const resultParts = toolFragments
    .filter(fragment => fragment.metadata.pairType === 'tool-result' && fragment.metadata.blockType === 'text')
    .sort((left, right) => left.metadata.part - right.metadata.part)
  assert.match(resultParts.map(fragment => fragment.text).join(''), /^result-/)
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

test('adapter reuses an append-only DSH session thread and sends only new messages', async () => {
  const starts = []
  const adapter = new CodexSubscriptionAdapter(
    { workingDirectory: '/home/user' },
    () => ({
      startThread(threadOptions) {
        const calls = []
        starts.push({ calls, threadOptions })
        return {
          id: `thread-${starts.length}`,
          async runStreamed(prompt) {
            calls.push(prompt)
            const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
            return { events: streamedEvents([finalResponse], {
              input_tokens: 100,
              cached_input_tokens: calls.length > 1 ? 80 : 0,
              cache_write_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 0,
            }) }
          },
        }
      },
    }),
  )
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-append',
    system: 'system',
    messages: [textMessage('user-1', 'hello')],
  }
  const second = {
    ...first,
    messages: [
      ...first.messages,
      textMessage('assistant-1', 'done', 'assistant'),
      textMessage('user-2', 'next'),
    ],
  }

  const firstChunks = await collectStream(adapter, first)
  const secondChunks = await collectStream(adapter, second)

  assert.equal(starts.length, 1)
  assert.equal(starts[0].calls.length, 2)
  assert.match(starts[0].calls[0], /"system":"system"/)
  assert.doesNotMatch(starts[0].calls[1], /"text":"hello"/)
  assert.match(starts[0].calls[1], /"text":"next"/)
  assert.equal(firstChunks.find(chunk => chunk.type === 'usage').usage.cacheReadTokens, undefined)
  assert.equal(secondChunks.find(chunk => chunk.type === 'usage').usage.cacheReadTokens, 80)
})

test('adapter reuses one thread for three text turns and advances the lineage cursor', async () => {
  const prompts = []
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      let calls = 0
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          calls += 1
          const finalResponse = JSON.stringify({
            reasoning: '',
            text: `round-${calls}`,
            tool_calls: [],
          })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-three-text',
    system: 'system',
    messages: [textMessage('user-1', 'one')],
  }
  const second = {
    ...first,
    messages: [
      ...first.messages,
      textMessage('assistant-1', 'round-1', 'assistant'),
      textMessage('user-2', 'two'),
    ],
  }
  const third = {
    ...second,
    messages: [
      ...second.messages,
      textMessage('assistant-2', 'round-2', 'assistant'),
      textMessage('user-3', 'three'),
    ],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, second)
  await collectStream(adapter, third)

  const payloads = prompts.map(prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)))
  assert.equal(starts, 1)
  assert.equal(prompts.length, 3)
  assert.deepEqual(payloads[0].messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'one' }],
  }])
  assert.deepEqual(payloads[1], {
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'two' }],
    }],
    generation: { max_tokens: null },
  })
  assert.deepEqual(payloads[2], {
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'three' }],
    }],
    generation: { max_tokens: null },
  })
})

test('adapter starts a new thread when a continuation has no new DSH message', async () => {
  const prompts = []
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-no-new-message',
    system: 'system',
    messages: [textMessage('user-1', 'one')],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, {
    ...first,
    messages: [
      ...first.messages,
      textMessage('assistant-1', 'done', 'assistant'),
    ],
  })

  assert.equal(starts, 2)
  const secondPayload = JSON.parse(prompts[1].slice(prompts[1].lastIndexOf('\n') + 1))
  assert.equal(secondPayload.system, 'system')
  assert.equal(secondPayload.messages.length, 2)
})

test('adapter requires the previous assistant blocks at the lineage cursor', async () => {
  const prompts = []
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-assistant-cursor',
    messages: [textMessage('user-1', 'hello')],
  }
  const mismatch = {
    ...first,
    messages: [
      ...first.messages,
      textMessage('assistant-1', 'not the previous output', 'assistant'),
      textMessage('user-2', 'next'),
    ],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, mismatch)

  assert.equal(starts, 2)
  assert.match(prompts[1], /"system":""/)
  assert.match(prompts[1], /not the previous output/)
})

test('adapter keeps sessions, history rewrites, and model changes isolated', async () => {
  const starts = []
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread(threadOptions) {
      starts.push(threadOptions)
      return {
        id: `thread-${starts.length}`,
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const request = (overrides = {}) => ({
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-a',
    system: 'system',
    messages: [textMessage('user-1', 'hello')],
    ...overrides,
  })

  await collectStream(adapter, request())
  await collectStream(adapter, request({ sessionId: 'session-b' }))
  await collectStream(adapter, request({ messages: [textMessage('user-edited', 'changed')] }))
  await collectStream(adapter, request({
    model: 'gpt-5.6-luna',
    messages: [textMessage('user-edited', 'changed'), textMessage('user-2', 'next')],
  }))
  await collectStream(adapter, request({
    reasoningEffort: 'high',
    messages: [textMessage('user-edited', 'changed'), textMessage('user-3', 'again')],
  }))

  assert.equal(starts.length, 5)
})

test('adapter does not reconnect to the old thread after switching models back', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread(threadOptions) {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
        threadOptions,
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-switch-back',
    messages: [textMessage('user-1', 'one')],
  }
  const firstContinuation = {
    ...first,
    messages: [
      ...first.messages,
      textMessage('assistant-1', 'ok', 'assistant'),
      textMessage('user-2', 'two'),
    ],
  }
  const switched = {
    ...firstContinuation,
    model: 'gpt-5.6-luna',
    messages: [...firstContinuation.messages, textMessage('user-3', 'three')],
  }
  const switchedContinuation = {
    ...switched,
    messages: [
      ...switched.messages,
      textMessage('assistant-2', 'ok', 'assistant'),
      textMessage('user-4', 'four'),
    ],
  }
  const switchedBack = {
    ...switchedContinuation,
    model: 'gpt-5.6-sol',
    messages: [...switchedContinuation.messages, textMessage('user-5', 'five')],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, firstContinuation)
  await collectStream(adapter, switched)
  await collectStream(adapter, switchedContinuation)
  await collectStream(adapter, switchedBack)

  assert.equal(starts, 3)
})

test('adapter does not guess a session when DSH omits sessionId', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    messages: [textMessage('user-1', 'one')],
  }

  await collectStream(adapter, options)
  await collectStream(adapter, {
    ...options,
    messages: [...options.messages, textMessage('user-2', 'two')],
  })
  assert.equal(starts, 2)
})

test('adapter starts a fresh thread when runtime options change', async () => {
  let config = { workingDirectory: '/tmp', allowNetworkAccess: false }
  let starts = 0
  const adapter = new CodexSubscriptionAdapter(() => config, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-config',
    messages: [textMessage('user-1', 'one')],
  }

  await collectStream(adapter, first)
  config = { workingDirectory: '/tmp', allowNetworkAccess: true }
  await collectStream(adapter, {
    ...first,
    messages: [...first.messages, textMessage('user-2', 'two')],
  })
  assert.equal(starts, 2)
})

test('adapter does not reuse a thread whose native id is unavailable', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-no-native-id',
    messages: [textMessage('user-1', 'one')],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, {
    ...first,
    messages: [...first.messages, textMessage('user-2', 'two')],
  })
  assert.equal(starts, 2)
})

test('adapter reuses a thread across a DSH tool result continuation', async () => {
  const prompts = []
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          const finalResponse = JSON.stringify({
            reasoning: '',
            text: '',
            tool_calls: [{ id: 'call-1', name: 'read', arguments_json: '{"path":"a"}' }],
          })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool',
    messages: [textMessage('user-1', 'read a')],
  }
  const second = {
    ...first,
    messages: [
      ...first.messages,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }],
      },
      {
        id: 'tool-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'file contents' }],
        }],
      },
    ],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, second)

  await collectStream(adapter, {
    ...second,
    messages: [
      ...first.messages,
      {
        ...second.messages[1],
        content: [{ type: 'tool-call', id: 'call-wrong', name: 'read', arguments: '{"path":"a"}' }],
      },
      second.messages[2],
    ],
  })

  assert.equal(starts, 2)
  assert.equal(prompts.length, 3)
  assert.match(prompts[1], /tool-result/)
  assert.match(prompts[2], /"system":""/)
})

test('adapter sends only each new tool result across three reused turns', async () => {
  const prompts = []
  let starts = 0
  const assistantToolCall = (id, path) => ({
    id,
    role: 'assistant',
    content: [{ type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ path }) }],
  })
  const toolResult = (id, callId, text) => ({
    id,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text }],
    }],
  })
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      let calls = 0
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          calls += 1
          const finalResponse = calls < 3
            ? JSON.stringify({
                reasoning: '',
                text: '',
                tool_calls: [{
                  id: `call-${calls}`,
                  name: 'read',
                  arguments_json: JSON.stringify({ path: calls === 1 ? 'a' : 'b' }),
                }],
              })
            : JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-three-tools',
    system: 'system',
    messages: [textMessage('user-1', 'read a')],
  }
  const second = {
    ...first,
    messages: [
      ...first.messages,
      assistantToolCall('call-1', 'a'),
      toolResult('tool-1', 'call-1', 'file a'),
    ],
  }
  const third = {
    ...second,
    messages: [
      ...second.messages,
      assistantToolCall('call-2', 'b'),
      toolResult('tool-2', 'call-2', 'file b'),
    ],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, second)
  await collectStream(adapter, third)

  const payloads = prompts.map(prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)))
  assert.equal(starts, 1)
  assert.equal(prompts.length, 3)
  assert.deepEqual(payloads[0].messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'read a' }],
  }])
  assert.deepEqual(payloads[1], {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        isError: false,
        content: [{ type: 'text', text: 'file a' }],
      }],
    }],
    generation: { max_tokens: null },
  })
  assert.deepEqual(payloads[2], {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-2',
        isError: false,
        content: [{ type: 'text', text: 'file b' }],
      }],
    }],
    generation: { max_tokens: null },
  })
})

test('adapter invalidates a failed thread before retrying the same request', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          if (starts === 1) throw new Error('thread failed')
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-retry',
    messages: [textMessage('user-1', 'retry')],
  }

  await assert.rejects(collectStream(adapter, options), /thread failed/)
  await collectStream(adapter, options)
  assert.equal(starts, 2)
})

test('adapter handles auxiliary purposes outside the main session pool', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-purpose',
    messages: [textMessage('user-1', 'one')],
  }
  const mainContinuation = {
    ...first,
    messages: [
      ...first.messages,
      textMessage('assistant-1', 'ok', 'assistant'),
      textMessage('user-2', 'two'),
    ],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, { ...first, purpose: 'session-title' })
  await collectStream(adapter, mainContinuation)
  await collectStream(adapter, { ...mainContinuation, purpose: 'compaction' })
  await collectStream(adapter, {
    ...mainContinuation,
    messages: [...mainContinuation.messages, textMessage('user-3', 'three')],
  })

  assert.equal(starts, 4)
})

test('adapter segments an oversized compaction request and emits one cumulative usage event', async () => {
  const prompts = []
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          const text = prompt.includes('final pass') ? 'final-summary' : `intermediate-${starts}`
          return {
            events: streamedEvents([JSON.stringify({ reasoning: '', text, tool_calls: [] })], {
              input_tokens: 10,
              cached_input_tokens: 2,
              cache_write_input_tokens: 1,
              output_tokens: 3,
              reasoning_output_tokens: 4,
            }),
          }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    sessionId: 'session-oversized-compaction',
    messages: [
      textMessage('user-1', 'oversized-' + 'z'.repeat(CODEX_SAFE_PROMPT_CHAR_BUDGET)),
      textMessage('instruction', 'summarize the preceding history'),
    ],
  }

  const chunks = await collectStream(adapter, options)
  assert.ok(starts > 2)
  assert.ok(prompts.every(prompt => prompt.length <= CODEX_SAFE_PROMPT_CHAR_BUDGET))
  assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: starts * 7,
    outputTokens: starts * 3,
    totalTokens: starts * 13,
    cacheReadTokens: starts * 2,
    cacheWriteTokens: starts,
    reasoningTokens: starts * 4,
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('segmented compaction aborts before any summary is exposed', async () => {
  const controller = new AbortController()
  controller.abort()
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          throw new Error('must not run after abort')
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    purpose: 'compaction',
    sessionId: 'session-aborted-compaction',
    signal: controller.signal,
    messages: [
      textMessage('user-1', 'oversized-' + 'x'.repeat(CODEX_SAFE_PROMPT_CHAR_BUDGET)),
      textMessage('instruction', 'summarize the preceding history'),
    ],
  }

  await assert.rejects(collectStream(adapter, options), error => error.code === 'ABORTED')
  assert.equal(starts, 1)
})

test('adapter handles a turn.failed event as a thread failure', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      const first = starts === 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          if (first) {
            return {
              events: (async function * () {
                yield { type: 'turn.failed', error: { message: 'turn failed' } }
              })(),
            }
          }
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-turn-failed',
    messages: [textMessage('user-1', 'retry')],
  }

  await assert.rejects(collectStream(adapter, options), /turn failed/)
  await collectStream(adapter, options)
  assert.equal(starts, 2)
})

test('adapter invalidates an in-flight thread when its consumer aborts', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          return {
            events: (async function * () {
              const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
              yield { type: 'item.updated', item: { type: 'agent_message', id: 'message-1', text: finalResponse } }
              await new Promise(resolve => setTimeout(resolve, 20))
              yield { type: 'turn.completed', usage: null }
            })(),
          }
        },
      }
    },
  }))
  const controller = new AbortController()
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-abort',
    signal: controller.signal,
    messages: [textMessage('user-1', 'abort')],
  }
  const iterator = adapter.stream(options)[Symbol.asyncIterator]()
  await iterator.next()
  controller.abort()
  await iterator.return()

  await collectStream(adapter, {
    ...options,
    signal: new AbortController().signal,
    messages: [...options.messages, textMessage('user-2', 'retry')],
  })
  assert.equal(starts, 2)
})

test('adapter invalidates a thread when aborted after finish is yielded', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-${starts}`,
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const controller = new AbortController()
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-finish-abort',
    signal: controller.signal,
    messages: [textMessage('user-1', 'finish')],
  }
  const iterator = adapter.stream(options)[Symbol.asyncIterator]()
  let item
  do {
    item = await iterator.next()
  } while (!item.done && item.value.type !== 'finish')
  controller.abort()
  await iterator.next()

  await collectStream(adapter, {
    ...options,
    signal: new AbortController().signal,
    messages: [...options.messages, textMessage('user-2', 'retry')],
  })
  assert.equal(starts, 2)
})

test('thread pool isolates concurrent calls and applies LRU expiry', () => {
  let now = 0
  let created = 0
  const pool = new CodexThreadPool({ maxEntries: 1, idleMs: 10, now: () => now })
  const threadOptions = { model: 'gpt-5.6-sol', sandboxMode: 'read-only' }
  const lineage = (messageCount, continuation = false) => ({
    contextKey: 'same',
    messageKeys: Array.from({ length: messageCount }, (_, index) => String(index)),
    messageContentKeys: Array.from({ length: messageCount }, (_, index) => index === 1 && continuation
      ? codexAssistantFingerprint([])
      : String(index)),
    messageCount,
  })
  const create = () => ({ id: `thread-${++created}` })

  const first = pool.acquire({
    sessionId: 'session-a',
    lineage: lineage(1),
    threadOptions,
    createThread: create,
  })
  assert.throws(() => pool.acquire({
    sessionId: 'session-a',
    lineage: lineage(2, true),
    threadOptions,
    createThread: create,
  }), error => error.code === 'SESSION_BUSY')
  first.release([])

  const reused = pool.acquire({
    sessionId: 'session-a',
    lineage: lineage(3, true),
    threadOptions,
    createThread: create,
  })
  assert.equal(reused.thread, first.thread)
  reused.release([])

  now = 10
  const expired = pool.acquire({
    sessionId: 'session-a',
    lineage: lineage(4, true),
    threadOptions,
    createThread: create,
  })
  assert.notEqual(expired.thread, first.thread)
  expired.release([])

  now = 11
  const other = pool.acquire({
    sessionId: 'session-b',
    lineage: lineage(1),
    threadOptions,
    createThread: create,
  })
  other.release([])
  assert.equal(pool.size(), 1)
  assert.equal(created, 3)
})

test('thread pool invalidation blocks late releases from restoring a session', () => {
  let created = 0
  const pool = new CodexThreadPool({ idleMs: 60_000 })
  const threadOptions = { model: 'gpt-5.6-sol', sandboxMode: 'read-only' }
  const initialLineage = {
    contextKey: 'same',
    messageKeys: ['user-1'],
    messageContentKeys: ['user-1'],
    messageCount: 1,
  }
  const create = () => ({ id: `thread-${++created}` })

  const main = pool.acquire({
    sessionId: 'session-compaction',
    lineage: initialLineage,
    threadOptions,
    createThread: create,
  })
  pool.invalidateSession('session-compaction')
  assert.throws(() => pool.acquire({
    sessionId: 'session-compaction',
    lineage: initialLineage,
    threadOptions,
    createThread: create,
  }), error => error.code === 'SESSION_BUSY')

  const compaction = pool.acquireIsolated({
    sessionId: 'session-compaction',
    lineage: initialLineage,
    threadOptions,
    blockSession: true,
    createThread: create,
  })
  main.release([])
  assert.throws(() => pool.acquire({
    sessionId: 'session-compaction',
    lineage: initialLineage,
    threadOptions,
    createThread: create,
  }), error => error.code === 'SESSION_BUSY')
  compaction.release([])

  const fresh = pool.acquire({
    sessionId: 'session-compaction',
    lineage: initialLineage,
    threadOptions,
    createThread: create,
  })
  assert.notEqual(fresh.thread, main.thread)
  fresh.invalidate()
  assert.equal(created, 3)
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

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  buildCodexPrompt,
  buildCompactionPrompt,
  CODEX_ADAPTER_CONTEXT_WINDOW,
  CODEX_COMPACTION_MAX_CALLS,
  CODEX_COMPACTION_MAX_CALLS_PER_LEVEL,
  CODEX_SAFE_PROMPT_CHAR_BUDGET,
  CODEX_PROVIDER,
  CodexAppServerClient,
  CodexAuthBridge,
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
  registerAuthRoutes,
  sanitizeCodexAccountStatus,
  sanitizedEnvironment,
  splitCompactionSource,
  apply,
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

class FakeAppServerRpc {
  constructor(onRequest = () => undefined) {
    this.onRequest = onRequest
    this.calls = []
    this.listeners = new Map()
    this.generation = 1
    this.diagnostics = { pid: 100, initialized: true }
    this.turns = 0
    this.closed = false
  }

  subscribe(method, callback) {
    let handlers = this.listeners.get(method)
    if (handlers === undefined) {
      handlers = new Set()
      this.listeners.set(method, handlers)
    }
    handlers.add(callback)
    return () => handlers.delete(callback)
  }

  emit(method, params) {
    for (const callback of this.listeners.get(method) ?? []) callback(params)
  }

  async request(method, params, options) {
    this.calls.push({ method, params, options })
    const custom = await this.onRequest(method, params, options)
    if (custom !== undefined) return custom
    if (method === 'thread/start' || method === 'thread/resume') {
      if (method === 'thread/resume') {
        this.generation += 1
        this.diagnostics = { pid: 100 + this.generation, initialized: true }
      }
      return { thread: { id: 'thread-1' } }
    }
    if (method === 'thread/unsubscribe') return {}
    if (method === 'turn/start') return { turn: { id: `turn-${++this.turns}` } }
    if (method === 'turn/interrupt') return { turn: { id: params.turnId, status: 'interrupted' } }
    const error = new Error(`Method not supported: ${method}`)
    error.code = -32601
    error.rpcError = { code: -32601, message: 'Method not supported' }
    throw error
  }

  crash(error = Object.assign(new Error('app-server exited'), { code: 'APP_SERVER_EXIT' })) {
    this.diagnostics = { pid: null, initialized: false }
    this.emit('crash', error)
  }

  close() {
    this.closed = true
    this.diagnostics = { ...this.diagnostics, pid: null, initialized: false, closed: true }
  }
}

async function collectStream(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

async function collectStreamFailure(adapter, options) {
  const chunks = []
  let error
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  } catch (caught) {
    error = caught
  }
  return { chunks, error }
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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(body = '') {
      this.body = body
    },
  }
}

test('account discovery drops hidden and ChatGPT-incompatible catalog rows', async () => {
  const requests = []
  const appServerClient = {
    async request(method, params, options) {
      requests.push({ method, params, options })
      return {
        data: [
          { model: 'gpt-5.6-sol', displayName: 'Sol', hidden: false },
          { model: 'gpt-5.2', displayName: 'Unsupported', hidden: false },
          { model: 'gpt-reserve', displayName: 'Hidden', hidden: true },
        ],
      }
    },
  }

  const models = await discoverCodexCatalog(undefined, appServerClient)
  assert.deepEqual(models.map(model => model.id), ['gpt-5.6-sol'])
  assert.equal(models[0].contextWindow, CODEX_ADAPTER_CONTEXT_WINDOW)
  assert.deepEqual(requests, [{
    method: 'model/list',
    params: { includeHidden: false, limit: 100 },
    options: { signal: undefined, timeoutMs: 30_000 },
  }])
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
  const requests = []
  const quota = await readCodexRateLimits(undefined, {
    async request(method, params, options) {
      requests.push({ method, params, options })
      return {
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
      }
    },
  })
  assert.equal(quota.buckets[0].name, 'Codex')
  assert.equal(quota.buckets[0].planType, 'pro')
  assert.equal(quota.buckets[0].primary.usedPercent, 36)
  assert.equal(quota.buckets[0].primary.windowDurationMins, 10_080)
  assert.equal(quota.resetCredits, 0)
  assert.equal(JSON.stringify(quota).includes('must-not-leak'), false)
  assert.deepEqual(requests, [{
    method: 'account/rateLimits/read',
    params: undefined,
    options: { signal: undefined, timeoutMs: 15_000 },
  }])
})

test('auth status exposes only ChatGPT sign-in state and plan', async () => {
  assert.deepEqual(sanitizeCodexAccountStatus({
    account: { type: 'chatgpt', email: 'hidden@example.test', planType: 'pro' },
  }), {
    signedIn: true,
    authMode: 'chatgpt',
    planType: 'pro',
  })
  assert.deepEqual(sanitizeCodexAccountStatus({
    account: { type: 'apiKey', email: 'hidden@example.test', planType: 'pro' },
  }), {
    signedIn: false,
    authMode: 'apiKey',
    planType: null,
  })

  const calls = []
  const bridge = new CodexAuthBridge(() => ({
    async request(method, params, options) {
      calls.push({ method, params, options })
      return { account: { type: 'chatgpt', email: 'must-not-return@example.test', planType: 'plus' } }
    },
  }))
  const status = await bridge.status()
  assert.deepEqual(status, { signedIn: true, authMode: 'chatgpt', planType: 'plus' })
  assert.equal(JSON.stringify(status).includes('must-not-return'), false)
  assert.deepEqual(calls, [{
    method: 'account/read',
    params: { refreshToken: false },
    options: { timeoutMs: 15_000 },
  }])
})

test('auth login prefers device code and falls back only for explicit unsupported errors', async () => {
  const calls = []
  const client = {
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'account/login/start' && params.type === 'chatgptDeviceCode') {
        throw Object.assign(new Error('login type is unsupported'), { code: 'UNSUPPORTED_LOGIN_TYPE' })
      }
      return {
        type: 'chatgpt',
        loginId: 'login-1',
        authUrl: 'https://auth.example.test/continue',
        email: 'must-not-return@example.test',
      }
    },
  }
  const bridge = new CodexAuthBridge(() => client)
  const result = await bridge.startLogin()
  assert.deepEqual(result, {
    type: 'chatgpt',
    loginId: 'login-1',
    authUrl: 'https://auth.example.test/continue',
  })
  assert.deepEqual(calls, [
    { method: 'account/login/start', params: { type: 'chatgptDeviceCode' } },
    { method: 'account/login/start', params: { type: 'chatgpt' } },
  ])
  assert.equal(JSON.stringify(result).includes('must-not-return'), false)
})

test('auth login is shared, cancel uses only the in-memory login id, and logout is account-wide', async () => {
  const gate = deferred()
  const calls = []
  const client = {
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'account/login/start') return gate.promise
      return {}
    },
  }
  const bridge = new CodexAuthBridge(() => client)
  const first = bridge.startLogin()
  const second = bridge.startLogin()
  await Promise.resolve()
  assert.equal(calls.filter(call => call.method === 'account/login/start').length, 1)
  gate.resolve({ type: 'chatgptDeviceCode', loginId: 'owned-login', verificationUrl: 'https://verify', userCode: 'ABCD-EFGH' })
  assert.deepEqual(await Promise.all([first, second]), [
    { type: 'chatgptDeviceCode', loginId: 'owned-login', verificationUrl: 'https://verify', userCode: 'ABCD-EFGH' },
    { type: 'chatgptDeviceCode', loginId: 'owned-login', verificationUrl: 'https://verify', userCode: 'ABCD-EFGH' },
  ])
  await bridge.cancelLogin('attacker-supplied-login')
  assert.deepEqual(calls.at(-1), { method: 'account/login/cancel', params: { loginId: 'owned-login' } })
  await bridge.logout()
  assert.deepEqual(calls.at(-1), { method: 'account/logout', params: undefined })
})

test('auth routes enforce methods and the browser-only POST header', async () => {
  const client = {
    async request(method, params) {
      if (method === 'account/read') return { account: null }
      if (method === 'account/login/start') return {
        type: params.type,
        loginId: 'route-login',
        verificationUrl: 'https://verify',
        userCode: 'ROUTE-CODE',
      }
      return {}
    },
  }
  const bridge = new CodexAuthBridge(() => client)
  const routes = []
  const dispose = registerAuthRoutes({ webServer: { register(route) { routes.push(route); return () => {} } } }, bridge)
  assert.equal(typeof dispose, 'function')

  const statusRoute = routes.find(route => route.path.endsWith('/auth/status'))
  const loginRoute = routes.find(route => route.path.endsWith('/auth/login'))
  const wrongMethod = fakeResponse()
  await statusRoute.handler({ method: 'POST', headers: {} }, wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers['cache-control'], 'no-store')

  const missingHeader = fakeResponse()
  await loginRoute.handler({ method: 'POST', headers: { 'content-type': 'application/json' } }, missingHeader)
  assert.equal(missingHeader.statusCode, 403)

  const accepted = fakeResponse()
  await loginRoute.handler({
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-dsh-codex-auth': '1' },
  }, accepted)
  assert.equal(accepted.statusCode, 200)
  assert.deepEqual(JSON.parse(accepted.body).value, {
    type: 'chatgptDeviceCode', loginId: 'route-login', verificationUrl: 'https://verify', userCode: 'ROUTE-CODE',
  })
})

test('auth route registration rolls back partial duplicates and combined disposal removes all routes', () => {
  const routes = new Map()
  let registrations = 0
  const ctx = {
    webServer: {
      register(route) {
        registrations += 1
        if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
        routes.set(route.path, route)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          routes.delete(route.path)
        }
      },
    },
  }
  const bridge = new CodexAuthBridge(() => ({ request: async () => ({}) }))
  const dispose = registerAuthRoutes(ctx, bridge)
  assert.equal(registrations, 4)
  assert.equal(routes.size, 4)
  dispose()
  assert.equal(routes.size, 0)

  routes.set('/plugins/@local/dsh-codex-internal/api/auth/cancel', {})
  assert.throws(() => registerAuthRoutes(ctx, bridge), /duplicate route/)
  assert.deepEqual([...routes.keys()], ['/plugins/@local/dsh-codex-internal/api/auth/cancel'])
})

test('apply registers quota and auth routes as disposable effects', () => {
  const routes = new Map()
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route: ${route.path}`)
        routes.set(route.path, route)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          routes.delete(route.path)
        }
      },
    },
    effect(execute) {
      const dispose = execute()
      effects.push(dispose)
      return dispose
    },
    inject() {},
    llm: {
      registerModelDiscovery() {},
      registerAdapter() {},
    },
  }

  apply(ctx, { models: [] })
  assert.deepEqual([...routes.keys()].sort(), [
    '/plugins/@local/dsh-codex-internal/api/auth/cancel',
    '/plugins/@local/dsh-codex-internal/api/auth/login',
    '/plugins/@local/dsh-codex-internal/api/auth/logout',
    '/plugins/@local/dsh-codex-internal/api/auth/status',
    '/plugins/@local/dsh-codex-internal/api/quota',
  ])
  for (const dispose of [...effects].reverse()) dispose?.()
  assert.equal(routes.size, 0)
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
  const clientContextError = Object.assign(
    new Error('Input exceeds the maximum length of 1048576 characters'),
    { status: 400 },
  )
  assert.equal(classifySdkError(clientContextError).code, 'CONTEXT_WINDOW_EXCEEDED')

  const appServerError = classifySdkError({ error: { code: 'ContextWindowExceeded', message: 'request rejected' } })
  assert.equal(appServerError.code, 'CONTEXT_WINDOW_EXCEEDED')
  const codeBearingError = new Error('request rejected')
  codeBearingError.code = 'ContextWindowExceeded'
  assert.equal(classifySdkError(codeBearingError).code, 'CONTEXT_WINDOW_EXCEEDED')
  codeBearingError.status = 400
  assert.equal(classifySdkError(codeBearingError).code, 'CONTEXT_WINDOW_EXCEEDED')
  const nestedCodeError = new Error('request rejected')
  nestedCodeError.data = { detail: { type: 'ContextWindowExceeded' } }
  assert.equal(classifySdkError(nestedCodeError).code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(classifySdkError({ status: 400, data: { code: 'invalid_request' }, message: 'invalid request' }).code,
    'CODEX_SDK')
  assert.equal(classifySdkError({ status: 400, message: 'invalid request' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 400, message: 'Bad Gateway' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 400, message: 'server error' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 400, message: 'request timed out' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 400, message: 'socket closed' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 401, message: 'server error' }).code, 'AUTH')
  assert.equal(classifySdkError({ status: 403, message: 'connection closed' }).code, 'AUTH')
  assert.equal(classifySdkError({ status: 404, message: 'service unavailable' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 422, message: 'request timed out' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 429, message: 'rate limit reached' }).code, 'RATE_LIMIT')
  assert.equal(classifySdkError({ status: 429 }).code, 'RATE_LIMIT')
  assert.equal(classifySdkError({ status: 408, message: 'request timed out' }).code, 'TIMEOUT')
  assert.equal(classifySdkError({ status: 409, message: 'server error' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError(new LlmError('request timed out', 'CODEX_SDK', { status: 400 })).code,
    'CODEX_SDK')
  assert.equal(classifySdkError(new LlmError('provider response', 'CODEX_SDK', { status: 429 })).code,
    'RATE_LIMIT')
  assert.equal(classifySdkError(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })).code,
    'TRANSPORT')
  const wrappedTransport = new LlmError('Codex app-server failed', 'CODEX_APP_SERVER', {
    cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
  })
  assert.equal(classifySdkError(wrappedTransport).code, 'TRANSPORT')
  assert.equal(classifySdkError(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })).code,
    'TIMEOUT')
  assert.equal(classifySdkError(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })).code,
    'TIMEOUT')
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifySdkError({ status, message: `HTTP ${status}` }).code, 'SERVER')
    assert.equal(classifySdkError({ statusCode: status, message: `HTTP ${status}` }).code, 'SERVER')
    assert.equal(classifySdkError(new Error(`HTTP status code ${status}`)).code, 'SERVER')
  }
  for (const message of [
    'Bad Gateway',
    'Bad_Gateway',
    'service unavailable',
    'service-unavailable',
    'internal server error',
    'server_error',
  ]) {
    assert.equal(classifySdkError(new Error(message)).code, 'SERVER')
  }
  for (const message of [
    'connection reset by peer',
    'connection_closed by peer',
    'socket closed',
  ]) {
    assert.equal(classifySdkError(new Error(message)).code, 'TRANSPORT')
  }
  assert.equal(classifySdkError(new Error('CLI premature exit')).code, 'SERVER')
  assert.equal(classifySdkError(new Error('Codex CLI process exited prematurely')).code, 'SERVER')
  assert.equal(classifySdkError(new Error('authentication request reset')).code, 'AUTH')
  assert.equal(classifySdkError({ code: 'PROTOCOL', message: 'malformed response' }).code, 'PROTOCOL')
  assert.equal(classifySdkError(new Error('invalid JSON response')).code, 'CODEX_SDK')
})

test('Codex request-body parser failures are retryable without widening PROTOCOL', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('./fixtures/codex-request-body-parse-failure-redacted.json', import.meta.url),
    'utf8',
  ))
  assert.equal(fixture.observed.turn, 14)
  assert.deepEqual([fixture.observed.finishSeq, fixture.observed.turnEndSeq], [6877, 6879])
  assert.equal(classifySdkError(fixture.failure).code, 'SERVER')

  const requestBodyError = new Error(
    'Failed to parse the request body as JSON: expected value at line 1 column 1',
  )
  assert.equal(classifySdkError(requestBodyError).code, 'SERVER')
  assert.equal(classifySdkError(new Error(
    'Failed to parse the request body as JSON: unexpected end of JSON input',
  )).code, 'SERVER')
  const codeBearingEnd = Object.assign(new Error('unexpected end of JSON input'), { code: 'CODEX_SDK' })
  assert.equal(classifySdkError(codeBearingEnd).code, 'SERVER')
  const codeBearingEmpty = Object.assign(new Error('empty response body'), { code: 'CODEX_SDK' })
  assert.equal(classifySdkError(codeBearingEmpty).code, 'SERVER')
  assert.equal(classifySdkError(new Error('unexpected end of JSON input')).code, 'CODEX_SDK')
  assert.equal(classifySdkError({ status: 400, message: 'request timed out' }).code, 'CODEX_SDK')
  assert.equal(classifySdkError(new LlmError(
    'Codex structured output was truncated: unexpected end of JSON input',
    'PROTOCOL',
  )).code, 'PROTOCOL')
  const retryAfter = new LlmError(
    'Failed to parse the request body as JSON: expected value at line 1 column 1',
    'CODEX_SDK',
    { providerRetryAfterMs: 1250 },
  )
  const classified = classifySdkError(retryAfter)
  assert.equal(classified.code, 'SERVER')
  assert.equal(classified.failure.providerRetryAfterMs, 1250)
})

test('app-server TurnError codexErrorInfo preserves RPC codes and maps retry classes', () => {
  const classifyTurn = (codexErrorInfo, extra = {}) => classifySdkError({
    code: 'CODEX_APP_SERVER',
    message: 'Codex turn failed',
    codexErrorInfo,
    ...extra,
  })
  assert.equal(classifyTurn({ errorType: 'contextWindowExceeded' }).code, 'CONTEXT_WINDOW_EXCEEDED')
  for (const code of ['serverOverloaded', 'internalServerError', 'responseTooManyFailedAttempts']) {
    assert.equal(classifyTurn({ code }).code, 'SERVER')
  }
  for (const code of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected']) {
    assert.equal(classifyTurn({ code }).code, 'TRANSPORT')
  }
  for (const code of ['usageLimitExceeded', 'sessionBudgetExceeded']) {
    assert.equal(classifyTurn({ code }).code, 'RATE_LIMIT')
  }
  assert.equal(classifyTurn({ code: 'unauthorized' }).code, 'AUTH')
  assert.equal(classifyTurn({ code: 'serverOverloaded', httpStatusCode: 401 }).code, 'AUTH')
  assert.equal(classifyTurn({ code: 'serverOverloaded', httpStatusCode: 403 }).code, 'AUTH')
  assert.equal(classifyTurn({ code: 'serverOverloaded', httpStatusCode: 408 }).code, 'TIMEOUT')
  assert.equal(classifyTurn({ code: 'serverOverloaded', httpStatusCode: 429 }).code, 'RATE_LIMIT')
  assert.equal(classifyTurn({ code: 'responseStreamDisconnected', httpStatusCode: 500 }).code, 'SERVER')
  assert.equal(classifyTurn({ code: 'responseStreamDisconnected', data: { httpStatusCode: 502 } }).code, 'SERVER')
  assert.equal(classifyTurn({ responseStreamDisconnected: { reason: 'socket closed' } }).code, 'TRANSPORT')
  assert.equal(classifyTurn({ nested: { responseTooManyFailedAttempts: {} } }).code, 'SERVER')
  assert.equal(classifyTurn({ nested: { responseStreamDisconnected: { httpStatusCode: 503 } } }).code, 'SERVER')

  const rpcError = { code: -32001, message: 'Server overloaded' }
  const wrapped = classifySdkError(new LlmError('turn failed', 'CODEX_APP_SERVER', {
    cause: { rpcError },
  }))
  assert.equal(wrapped.code, 'SERVER')
  assert.equal(wrapped.cause.cause.rpcError.code, -32001)
  assert.equal(classifySdkError(rpcError).code, 'SERVER')
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

test('app-server compatibility bridge maps v2 events, usage, and request controls', async () => {
  const response = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
  const rpc = new FakeAppServerRpc((method) => {
    if (method !== 'turn/start') return undefined
    queueMicrotask(() => {
      rpc.emit('thread/started', { thread: { id: 'other-thread' } })
      rpc.emit('item/agentMessage/delta', {
        threadId: 'other-thread',
        turnId: 'turn-1',
        itemId: 'other-item',
        delta: 'must be ignored',
      })
      rpc.emit('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { message: 'retrying' } })
      rpc.emit('item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'item-1', text: '' },
      })
      rpc.emit('item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: response,
      })
      rpc.emit('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'item-1', text: response },
      })
      rpc.emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        tokenUsage: { last: { inputTokens: 999 } },
      })
      rpc.emit('thread/tokenUsage/updated', {
        threadId: 'other-thread',
        turnId: 'turn-1',
        tokenUsage: { last: { inputTokens: 998 } },
      })
      rpc.emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'wrong-turn',
        tokenUsage: { last: { inputTokens: 997 } },
      })
      rpc.emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: { totalTokens: 99 },
          last: {
            inputTokens: 20,
            cachedInputTokens: 3,
            cacheWriteInputTokens: 2,
            outputTokens: 4,
            reasoningOutputTokens: 1,
          },
        },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      })
    })
    return { turn: { id: 'turn-1', status: 'inProgress' } }
  })
  const client = new CodexAppServerClient({ rpc })
  const thread = client.startThread({
    model: 'gpt-5.6-sol',
    workingDirectory: '/workspace',
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    modelReasoningEffort: 'high',
    threadSource: 'dsh-test',
  })
  const outputSchema = { type: 'object', required: ['text'] }
  const streamed = await thread.runStreamed('prompt', { outputSchema })
  const events = await collectIterable(streamed.events)
  assert.deepEqual(events, [
    { type: 'item.updated', item: { type: 'agent_message', id: 'item-1', text: response } },
    { type: 'item.completed', item: { type: 'agent_message', id: 'item-1', text: response } },
    {
      type: 'turn.completed',
      turn: { id: 'turn-1', status: 'completed' },
      usage: {
        input_tokens: 20,
        cached_input_tokens: 3,
        cache_write_input_tokens: 2,
        output_tokens: 4,
        reasoning_output_tokens: 1,
      },
    },
  ])
  const start = rpc.calls.find(call => call.method === 'thread/start')
  assert.deepEqual(start.params, {
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    cwd: '/workspace',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: { 'sandbox_workspace_write.network_access': true },
    threadSource: 'dsh-test',
  })
  const turn = rpc.calls.find(call => call.method === 'turn/start')
  assert.deepEqual(turn.params, {
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'prompt', text_elements: [] }],
    model: 'gpt-5.6-sol',
    effort: 'high',
    cwd: '/workspace',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: true },
    outputSchema,
  })
})

test('app-server compatibility bridge interrupts an active turn on abort', async () => {
  const controller = new AbortController()
  const rpc = new FakeAppServerRpc()
  const thread = new CodexAppServerClient({ rpc }).startThread({ model: 'gpt-5.6-sol' })
  const streamed = await thread.runStreamed('wait', { signal: controller.signal })
  const pending = streamed.events.next()
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error.code === 'ABORTED')
  const interrupt = rpc.calls.find(call => call.method === 'turn/interrupt')
  assert.deepEqual(interrupt.params, { threadId: 'thread-1', turnId: 'turn-1' })
})

test('strict unhandled-rejection mode handles an abort queued by thread/start', () => {
  const indexUrl = new URL('../index.js', import.meta.url).href
  const script = `
    import { CodexAppServerClient } from ${JSON.stringify(indexUrl)}

    const controller = new AbortController()
    const calls = []
    const listeners = new Map()
    const rpc = {
      generation: 1,
      diagnostics: { pid: 7, initialized: true },
      closed: false,
      subscribe(method, callback) {
        let handlers = listeners.get(method)
        if (handlers === undefined) {
          handlers = new Set()
          listeners.set(method, handlers)
        }
        handlers.add(callback)
        return () => handlers.delete(callback)
      },
      request(method, params) {
        calls.push(method)
        if (method === 'thread/start') {
          queueMicrotask(() => controller.abort())
          return Promise.resolve({ thread: { id: 'thread-early-abort' } })
        }
        if (method === 'thread/unsubscribe') return Promise.resolve({})
        if (method === 'turn/start') throw new Error('turn/start must not be sent')
        throw Object.assign(new Error('Method not supported'), { code: -32601 })
      },
      close() {
        this.closed = true
      },
    }

    const client = new CodexAppServerClient({ rpc })
    const thread = client.startThread({ model: 'gpt-5.6-sol' })
    const streamed = await thread.runStreamed('abort immediately', { signal: controller.signal })
    try {
      await streamed.events.next()
      process.exitCode = 2
    } catch (error) {
      if (error?.code !== 'ABORTED' || calls.includes('turn/start')) process.exitCode = 3
    }
    await client.close()
  `
  const result = spawnSync(process.execPath, [
    '--unhandled-rejections=strict',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|unhandled rejection/i)
})

test('app-server bridge keeps a late turn/start alive and interrupts once after early abort', async () => {
  const controller = new AbortController()
  const start = deferred()
  const rpc = new FakeAppServerRpc(method => method === 'turn/start' ? start.promise : undefined)
  const thread = new CodexAppServerClient({ rpc }).startThread({ model: 'gpt-5.6-sol' })
  const streamed = await thread.runStreamed('late start', {
    signal: controller.signal,
    timeoutMs: 1_000,
    wireTimeoutMs: 200,
  })
  const pending = streamed.events.next()
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error.code === 'ABORTED')
  assert.equal(rpc.calls.filter(call => call.method === 'turn/interrupt').length, 0)
  assert.equal(rpc.calls.find(call => call.method === 'turn/start').options.signal, undefined)
  assert.equal(rpc.calls.find(call => call.method === 'turn/start').options.timeoutMs, 200)

  start.resolve({ turn: { id: 'turn-late' } })
  await new Promise(resolve => setImmediate(resolve))
  const interrupts = rpc.calls.filter(call => call.method === 'turn/interrupt')
  assert.equal(interrupts.length, 1)
  assert.deepEqual(interrupts[0].params, { threadId: 'thread-1', turnId: 'turn-late' })
})

test('app-server bridge handles turn/started before a late turn/start response without duplicate interrupt', async () => {
  const controller = new AbortController()
  const start = deferred()
  const rpc = new FakeAppServerRpc(method => method === 'turn/start' ? start.promise : undefined)
  const thread = new CodexAppServerClient({ rpc }).startThread({ model: 'gpt-5.6-sol' })
  const streamed = await thread.runStreamed('notified start', {
    signal: controller.signal,
    timeoutMs: 1_000,
  })
  const pending = streamed.events.next()
  await new Promise(resolve => setImmediate(resolve))
  rpc.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-notified' } })
  controller.abort()
  await assert.rejects(pending, error => error.code === 'ABORTED')
  assert.equal(rpc.calls.filter(call => call.method === 'turn/interrupt').length, 1)
  start.resolve({ turn: { id: 'turn-notified' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rpc.calls.filter(call => call.method === 'turn/interrupt').length, 1)
})

test('app-server bridge times out local turn/start promptly and interrupts a late turn', async () => {
  const start = deferred()
  const rpc = new FakeAppServerRpc(method => method === 'turn/start' ? start.promise : undefined)
  const thread = new CodexAppServerClient({ rpc }).startThread({ model: 'gpt-5.6-sol' })
  const streamed = await thread.runStreamed('timed start', { timeoutMs: 10, wireTimeoutMs: 50 })
  const pending = streamed.events.next()
  await assert.rejects(pending, error => error.code === 'TIMEOUT')
  assert.equal(rpc.calls.filter(call => call.method === 'turn/interrupt').length, 0)
  start.resolve({ turn: { id: 'turn-timeout' } })
  await new Promise(resolve => setImmediate(resolve))
  const interrupts = rpc.calls.filter(call => call.method === 'turn/interrupt')
  assert.equal(interrupts.length, 1)
  assert.equal(interrupts[0].params.turnId, 'turn-timeout')
})

test('app-server compatibility bridge resumes a thread after a disconnected generation', async () => {
  const rpc = new FakeAppServerRpc()
  const client = new CodexAppServerClient({ rpc })
  const thread = client.startThread({ model: 'gpt-5.6-sol' })
  const first = await thread.runStreamed('first')
  const pending = first.events.next()
  await new Promise(resolve => setImmediate(resolve))
  rpc.crash()
  await assert.rejects(pending, error => error.code === 'APP_SERVER_EXIT')

  rpc.onRequest = (method) => {
    if (method !== 'turn/start') return undefined
    queueMicrotask(() => {
      rpc.emit('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: {
          type: 'agentMessage',
          id: 'item-2',
          text: JSON.stringify({ reasoning: '', text: 'recovered', tool_calls: [] }),
        },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-2', status: 'completed' },
      })
    })
    return { turn: { id: 'turn-2', status: 'inProgress' } }
  }
  const recovered = await thread.runStreamed('retry')
  const events = await collectIterable(recovered.events)
  assert.equal(events.at(-1).type, 'turn.completed')
  assert.deepEqual(rpc.calls.map(call => call.method), [
    'thread/start',
    'turn/start',
    'thread/resume',
    'turn/start',
  ])
})

test('model discovery and quota lookup share one adapter app-server client', async () => {
  const rpc = new FakeAppServerRpc()
  rpc.onRequest = (method) => {
    if (method === 'model/list') {
      return { data: [{ model: 'gpt-shared', displayName: 'Shared', hidden: false }] }
    }
    if (method === 'account/rateLimits/read') {
      return {
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 12, windowDurationMins: 60, resetsAt: 1_788_452_814 },
            planType: 'pro',
          },
        },
      }
    }
    return undefined
  }
  const shared = new CodexAppServerClient({ rpc })
  let factoryCalls = 0
  const adapter = new CodexSubscriptionAdapter({}, () => {
    factoryCalls += 1
    return shared
  })
  assert.deepEqual((await adapter.listModels(CODEX_PROVIDER)).map(model => model.id), ['gpt-shared'])
  const quota = await readCodexRateLimits(undefined, adapter.getClient())
  assert.equal(quota.buckets[0].primary.usedPercent, 12)
  assert.equal(factoryCalls, 1)
  assert.deepEqual(rpc.calls.map(call => call.method), ['model/list', 'account/rateLimits/read'])
  await adapter.close()
  assert.equal(rpc.closed, true)
})

test('thread subscription release is idempotent and never respawns a dead app-server', async () => {
  const rpc = new FakeAppServerRpc()
  const client = new CodexAppServerClient({ rpc })
  const thread = client.startThread({ model: 'gpt-5.6-sol' })
  await thread.ensureThread()
  assert.equal(client.threads.has(thread), true)
  assert.equal(rpc.calls.filter(call => call.method === 'thread/subscribe').length, 0)

  await Promise.all([thread.unsubscribe(), thread.unsubscribe()])
  assert.equal(rpc.calls.filter(call => call.method === 'thread/unsubscribe').length, 1)
  assert.equal(client.threads.has(thread), false)
  await thread.unsubscribe()
  assert.equal(rpc.calls.filter(call => call.method === 'thread/unsubscribe').length, 1)

  rpc.crash()
  await thread.unsubscribe()
  assert.equal(rpc.calls.filter(call => call.method === 'thread/unsubscribe').length, 1)
  const callCount = rpc.calls.length
  await thread.unsubscribe()
  assert.equal(rpc.calls.length, callCount)

  client.close()
  await thread.unsubscribe()
  assert.equal(rpc.calls.length, callCount)
})

test('concurrent app-server streams require strict thread and turn notification scope', async () => {
  const rpc = new FakeAppServerRpc((method, params) => {
    if (method === 'thread/start') return { thread: { id: params.model === 'stream-a' ? 'thread-a' : 'thread-b' } }
    if (method === 'turn/start') return { turn: { id: params.threadId === 'thread-a' ? 'turn-a' : 'turn-b' } }
    return undefined
  })
  const client = new CodexAppServerClient({ rpc })
  const streamA = await client.startThread({ model: 'stream-a' }).runStreamed('a')
  const streamB = await client.startThread({ model: 'stream-b' }).runStreamed('b')
  const iteratorA = streamA.events[Symbol.asyncIterator]()
  const iteratorB = streamB.events[Symbol.asyncIterator]()
  let aResolved = false
  const firstA = iteratorA.next().then(value => {
    aResolved = true
    return value
  })
  const firstB = iteratorB.next()
  await new Promise(resolve => setImmediate(resolve))

  rpc.emit('item/agentMessage/delta', {
    threadId: 'thread-a',
    turnId: 'turn-a',
    itemId: 'item-a',
    delta: 'A',
  })
  rpc.emit('turn/completed', { threadId: 'thread-a', turn: { status: 'completed' } })
  rpc.emit('item/completed', {
    threadId: 'thread-a',
    item: { type: 'agentMessage', id: 'item-a', text: 'wrong scope' },
  })
  rpc.emit('item/agentMessage/delta', {
    threadId: 'thread-b',
    turnId: 'turn-b',
    itemId: 'item-b',
    delta: 'B',
  })
  assert.equal((await firstA).value.item.text, 'A')
  assert.equal((await firstB).value.item.text, 'B')
  assert.equal(aResolved, true)

  const doneA = iteratorA.next()
  const doneB = iteratorB.next()
  rpc.emit('turn/completed', {
    threadId: 'thread-a',
    turn: { id: 'turn-a', status: 'completed' },
  })
  rpc.emit('turn/completed', {
    threadId: 'thread-b',
    turn: { id: 'turn-b', status: 'completed' },
  })
  assert.equal((await doneA).value.type, 'turn.completed')
  assert.equal((await doneB).value.type, 'turn.completed')
  await Promise.all([iteratorA.next(), iteratorB.next()])
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

test('adapter fails closed for missing or duplicate tool-call identity', async () => {
  const cases = [
    {
      name: 'missing-id',
      toolCalls: [{ id: '', name: 'read', arguments_json: '{}' }],
      diagnostic: /id=.*missing.*empty/i,
    },
    {
      name: 'missing-name',
      toolCalls: [{ id: 'call-no-name', name: ' ', arguments_json: '{}' }],
      diagnostic: /name=.*missing/i,
    },
    {
      name: 'duplicate-id',
      toolCalls: [
        { id: 'call-duplicate', name: 'read', arguments_json: '{}' },
        { id: 'call-duplicate', name: 'write', arguments_json: '{}' },
      ],
      diagnostic: /must be unique/i,
    },
  ]

  for (const scenario of cases) {
    const prompts = []
    const adapter = new CodexSubscriptionAdapter({}, () => ({
      startThread() {
        return {
          id: `thread-strict-${scenario.name}`,
          async runStreamed(prompt) {
            prompts.push(prompt)
            return {
              events: streamedEvents([JSON.stringify({ reasoning: '', text: '', tool_calls: scenario.toolCalls })]),
            }
          },
        }
      },
    }))
    const failure = await collectStreamFailure(adapter, {
      provider: CODEX_PROVIDER,
      model: 'gpt-5.6-sol',
      sessionId: `session-strict-${scenario.name}`,
      messages: [textMessage(`user-${scenario.name}`, 'perform the operation')],
    })
    assert.equal(failure.error.code, 'PROTOCOL')
    assert.match(failure.error.message, scenario.diagnostic)
    assert.equal(prompts.length, 1, `${scenario.name} must not launch an unsafe repair`)
    assert.equal(failure.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
    assert.equal(adapter.threadPool.size(), 0)
  }
})

test('adapter repairs one invalid tool call without duplicating visible blocks or usage', async () => {
  const prompts = []
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-tool-repair',
        async runStreamed(prompt) {
          prompts.push(prompt)
          const response = prompts.length === 1
            ? {
                reasoning: 'initial reasoning',
                text: 'initial answer',
                tool_calls: [{
                  id: 'call-bad',
                  name: 'read',
                  arguments_json: '{"path":"secret.txt"',
                }],
              }
            : {
                reasoning: '',
                text: '',
                tool_calls: [{ id: 'call-bad', name: 'read', arguments_json: '{"path":"README.md"}' }],
              }
          return {
            events: streamedEvents([JSON.stringify(response)], {
              input_tokens: prompts.length === 1 ? 10 : 5,
              cached_input_tokens: prompts.length === 1 ? 2 : 1,
              cache_write_input_tokens: prompts.length === 1 ? 1 : 0,
              output_tokens: prompts.length === 1 ? 3 : 2,
              reasoning_output_tokens: 1,
            }),
          }
        },
      }
    },
  }))

  const chunks = await collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool-repair',
    messages: [textMessage('user-1', 'read the file')],
  })

  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /call-bad/)
  assert.match(prompts[1], /name="read"/)
  assert.match(prompts[1], /invalid JSON syntax/)
  assert.doesNotMatch(prompts[1], /secret\.txt/)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text), [
    'initial reasoning',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), [
    'initial answer',
  ])
  assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 11,
    outputTokens: 5,
    totalTokens: 20,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    reasoningTokens: 2,
  })
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.type), [
    'reasoning', 'text', 'tool-call',
  ])
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('adapter repairs the two redacted malformed tool-call tail fixtures', async () => {
  for (const [fixtureIndex, fixtureName] of [
    [1, 'codex-tool-call-tail-redacted-1.txt'],
    [2, 'codex-tool-call-tail-redacted-2.txt'],
  ]) {
    const fixture = await readFile(new URL(`./fixtures/${fixtureName}`, import.meta.url), 'utf8')
    const initial = JSON.parse(fixture)
    assert.equal(initial.tool_calls[0].arguments_json.endsWith(',{'), true)
    const prompts = []
    const adapter = new CodexSubscriptionAdapter({}, () => ({
      startThread() {
        return {
          id: `thread-tail-fixture-${fixtureIndex}`,
          async runStreamed(prompt) {
            prompts.push(prompt)
            const response = prompts.length === 1
              ? initial
              : {
                  reasoning: '',
                  text: '',
                  tool_calls: [{
                    id: initial.tool_calls[0].id,
                    name: initial.tool_calls[0].name,
                    arguments_json: '{}',
                  }],
                }
            return { events: streamedEvents([JSON.stringify(response)]) }
          },
        }
      },
    }))
    const chunks = await collectStream(adapter, {
      provider: CODEX_PROVIDER,
      model: 'gpt-5.6-sol',
      sessionId: `session-tail-fixture-${fixtureIndex}`,
      messages: [textMessage(`user-tail-fixture-${fixtureIndex}`, 'inspect the result')],
    })
    assert.equal(prompts.length, 2)
    assert.doesNotMatch(prompts[1], /REDACTED/)
    assert.equal(chunks.filter(chunk => chunk.type === 'tool-call-delta').length, 1)
    assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block, {
      type: 'tool-call',
      id: initial.tool_calls[0].id,
      name: initial.tool_calls[0].name,
      arguments: '{}',
    })
  }
})

test('adapter repairs only invalid tool calls and preserves call order', async () => {
  const prompts = []
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-multi-tool-repair',
        async runStreamed(prompt) {
          prompts.push(prompt)
          const response = prompts.length === 1
            ? {
                reasoning: '',
                text: '',
                tool_calls: [
                  { id: 'call-1', name: 'read', arguments_json: '{"path":"a"}' },
                  { id: 'call-2', name: 'write', arguments_json: '{"path":"b"' },
                  { id: 'call-3', name: 'read', arguments_json: '{"path":"c"}' },
                ],
              }
            : {
                reasoning: '',
                text: '',
                tool_calls: [{ id: 'call-2', name: 'write', arguments_json: '{"path":"b","data":"x"}' }],
              }
          return { events: streamedEvents([JSON.stringify(response)]) }
        },
      }
    },
  }))

  const chunks = await collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-multi-tool-repair',
    messages: [textMessage('user-1', 'do three operations')],
  })
  const calls = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(calls.map(chunk => chunk.block.id), ['call-1', 'call-2', 'call-3'])
  assert.deepEqual(calls.map(chunk => chunk.block.arguments), [
    '{"path":"a"}',
    '{"path":"b","data":"x"}',
    '{"path":"c"}',
  ])
  assert.doesNotMatch(prompts[1], /call-1|call-3/)
  assert.equal(prompts.length, 2)
})

test('adapter rejects tool-call repair id or name drift and invalidates the pooled thread', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      const first = starts === 1
      return {
        id: `thread-tool-drift-${starts}`,
        async runStreamed(prompt) {
          if (!first) return {
            events: streamedEvents([JSON.stringify({ reasoning: '', text: 'retry', tool_calls: [] })]),
          }
          const response = prompt.startsWith('Repair ')
            ? { reasoning: '', text: '', tool_calls: [{ id: 'call-other', name: 'read', arguments_json: '{}' }] }
            : { reasoning: '', text: '', tool_calls: [{ id: 'call-original', name: 'read', arguments_json: '{' }] }
          return { events: streamedEvents([JSON.stringify(response)]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool-drift',
    messages: [textMessage('user-1', 'read')],
  }
  const failure = await collectStreamFailure(adapter, options)
  assert.equal(failure.error.code, 'PROTOCOL')
  assert.match(failure.error.message, /call-original/)
  assert.match(failure.error.message, /read/)
  assert.doesNotMatch(failure.error.message, /arguments/)
  await collectStream(adapter, options)
  assert.equal(starts, 2)
})

test('adapter rejects a second invalid repair response and invalidates the thread', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      const first = starts === 1
      return {
        id: `thread-tool-invalid-repair-${starts}`,
        async runStreamed(prompt) {
          if (!first) return {
            events: streamedEvents([JSON.stringify({ reasoning: '', text: 'retry', tool_calls: [] })]),
          }
          const response = prompt.startsWith('Repair ')
            ? { reasoning: '', text: '', tool_calls: [{ id: 'call-original', name: 'read', arguments_json: '[]' }] }
            : { reasoning: '', text: '', tool_calls: [{ id: 'call-original', name: 'read', arguments_json: '{' }] }
          return { events: streamedEvents([JSON.stringify(response)], {
            input_tokens: prompt.startsWith('Repair ') ? 2 : 3,
            output_tokens: 1,
          }) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool-invalid-repair',
    messages: [textMessage('user-1', 'read')],
  }
  const failure = await collectStreamFailure(adapter, options)
  assert.equal(failure.error.code, 'PROTOCOL')
  assert.match(failure.error.message, /call-original/)
  assert.equal(failure.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  assert.equal(failure.chunks.filter(chunk => chunk.type === 'usage').length, 1)
  assert.deepEqual(failure.chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 5,
    outputTokens: 2,
    totalTokens: 7,
  })
  await collectStream(adapter, options)
  assert.equal(starts, 2)
})

test('adapter classifies a failed repair turn as retryable server failure', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      const first = starts === 1
      return {
        id: `thread-tool-failed-${starts}`,
        async runStreamed(prompt) {
          if (!first) return {
            events: streamedEvents([JSON.stringify({ reasoning: '', text: 'retry', tool_calls: [] })]),
          }
          if (prompt.startsWith('Repair ')) {
            return {
              events: (async function * () {
                yield { type: 'turn.failed', error: { message: 'repair turn failed' } }
              })(),
            }
          }
          return { events: streamedEvents([JSON.stringify({
            reasoning: '',
            text: '',
            tool_calls: [{ id: 'call-original', name: 'read', arguments_json: '{' }],
          })]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool-failed',
    messages: [textMessage('user-1', 'read')],
  }
  const failure = await collectStreamFailure(adapter, options)
  assert.equal(failure.error.code, 'SERVER')
  assert.equal(failure.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  await collectStream(adapter, options)
  assert.equal(starts, 2)
})

test('adapter invalidates a thread when tool-call repair fails or is aborted', async () => {
  let starts = 0
  let repairStarted
  const repairReady = new Promise(resolve => { repairStarted = resolve })
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      const first = starts === 1
      return {
        id: `thread-tool-abort-${starts}`,
        async runStreamed(prompt, { signal } = {}) {
          if (!first) return {
            events: streamedEvents([JSON.stringify({ reasoning: '', text: 'retry', tool_calls: [] })]),
          }
          if (prompt.startsWith('Repair ')) {
            repairStarted()
            return {
              events: (async function * () {
                yield { type: 'item.updated', item: {
                  type: 'agent_message',
                  text: JSON.stringify({ reasoning: '', text: '', tool_calls: [] }),
                } }
                while (!signal?.aborted) await new Promise(resolve => setTimeout(resolve, 1))
                yield { type: 'turn.completed', usage: { input_tokens: 2 } }
              })(),
            }
          }
          return { events: streamedEvents([JSON.stringify({
            reasoning: '',
            text: '',
            tool_calls: [{ id: 'call-original', name: 'read', arguments_json: '{' }],
          })]) }
        },
      }
    },
  }))
  const controller = new AbortController()
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool-abort',
    signal: controller.signal,
    messages: [textMessage('user-1', 'read')],
  }
  const pending = collectStreamFailure(adapter, options)
  await repairReady
  controller.abort()
  const failure = await pending
  assert.equal(failure.error.code, 'ABORTED')
  assert.equal(failure.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  assert.equal(failure.chunks.filter(chunk => chunk.type === 'usage').length, 1)
  await collectStream(adapter, { ...options, signal: new AbortController().signal })
  assert.equal(starts, 2)
})

test('transient repair failure is retryable without replaying tools, then the loop can continue', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-tool-retry-${starts}`,
        async runStreamed(prompt) {
          if (starts === 1) {
            if (prompt.startsWith('Repair ')) {
              const error = new Error('socket reset')
              error.code = 'ECONNRESET'
              throw error
            }
            return { events: streamedEvents([JSON.stringify({
              reasoning: '',
              text: '',
              tool_calls: [{ id: 'call-once', name: 'read', arguments_json: '{' }],
            })]) }
          }
          const continuation = prompt.includes('tool-result')
          return { events: streamedEvents([JSON.stringify(continuation
            ? { reasoning: '', text: 'done', tool_calls: [] }
            : {
                reasoning: '',
                text: '',
                tool_calls: [{ id: 'call-once', name: 'read', arguments_json: '{"path":"a"}' }],
              })]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool-retry',
    messages: [textMessage('user-1', 'read a')],
  }
  const first = await collectStreamFailure(adapter, options)
  assert.equal(first.error.code, 'TRANSPORT')
  assert.equal(first.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)

  const toolChunks = await collectStream(adapter, options)
  assert.equal(toolChunks.filter(chunk => chunk.type === 'tool-call-delta').length, 1)
  const continuation = {
    ...options,
    messages: [
      ...options.messages,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-once', name: 'read', arguments: '{"path":"a"}' }],
      },
      {
        id: 'tool-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-once' },
        content: [{ type: 'tool-result', toolCallId: 'call-once', content: [{ type: 'text', text: 'file' }] }],
      },
    ],
  }
  const finished = await collectStream(adapter, continuation)
  assert.equal(finished.at(-1).reason.kind, 'stop')
  assert.equal(starts, 2)
  const runtime = new LlmRuntime(new Context())
  runtime.registerAdapter([CODEX_PROVIDER], adapter)
  const retryPolicy = runtime.providerRetryPolicy(CODEX_PROVIDER)
  assert.ok(retryPolicy.retryableCodes.includes('SERVER'))
  assert.ok(retryPolicy.retryableCodes.includes('TRANSPORT'))
  assert.equal(retryPolicy.maxRetries, 5)
  assert.equal(retryPolicy.initialDelayMs, 500)
  assert.equal(retryPolicy.maxDelayMs, 10_000)
  assert.equal(retryPolicy.jitterRatio, 0.1)

  const failingAdapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-runtime-error',
        async runStreamed(prompt) {
          if (prompt.startsWith('Repair ')) {
            const error = new Error('socket reset')
            error.code = 'ECONNRESET'
            throw error
          }
          return { events: streamedEvents([JSON.stringify({
            reasoning: '',
            text: '',
            tool_calls: [{ id: 'call-runtime', name: 'read', arguments_json: '{' }],
          })]) }
        },
      }
    },
  }), async () => [])
  const runtimeWithFailure = new LlmRuntime(new Context())
  runtimeWithFailure.registerAdapter([CODEX_PROVIDER], failingAdapter)
  const runtimeChunks = await collectIterable(runtimeWithFailure.stream({
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-runtime-error',
    messages: [textMessage('user-1', 'read')],
  }))
  assert.equal(runtimeChunks.at(-1).reason.kind, 'error')
  assert.equal(runtimeChunks.at(-1).reason.failure.code, 'TRANSPORT')
})

test('request-body parse failure is retryable before tool dispatch', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      const first = starts === 1
      return {
        id: `thread-request-body-${starts}`,
        async runStreamed(prompt) {
          if (first) {
            const error = new Error(
              'Failed to parse the request body as JSON: expected value at line 1 column 1',
            )
            error.code = 'CODEX_SDK'
            throw error
          }
          return { events: streamedEvents([JSON.stringify(prompt.includes('tool-result')
            ? { reasoning: '', text: 'done', tool_calls: [] }
            : {
                reasoning: '',
                text: '',
                tool_calls: [{ id: 'call-once', name: 'read', arguments_json: '{"path":"a"}' }],
              })]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-request-body',
    messages: [textMessage('user-1', 'read a')],
  }
  const failure = await collectStreamFailure(adapter, options)
  assert.equal(failure.error.code, 'SERVER')
  assert.equal(failure.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  assert.equal(adapter.threadPool.size(), 0)

  const toolChunks = await collectStream(adapter, options)
  assert.equal(toolChunks.filter(chunk => chunk.type === 'tool-call-delta').length, 1)
  const finished = await collectStream(adapter, {
    ...options,
    messages: [
      ...options.messages,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-once', name: 'read', arguments: '{"path":"a"}' }],
      },
      {
        id: 'tool-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-once' },
        content: [{ type: 'tool-result', toolCallId: 'call-once', content: [{ type: 'text', text: 'file' }] }],
      },
    ],
  })
  assert.equal(finished.at(-1).reason.kind, 'stop')
  assert.equal(starts, 2)
})

test('bounded transient repair retries end with an explicit error and an idle pool', async () => {
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-tool-retry-limit-${starts}`,
        async runStreamed(prompt) {
          if (prompt.startsWith('Repair ')) {
            const error = new Error('request timed out')
            error.code = 'ETIMEDOUT'
            throw error
          }
          return { events: streamedEvents([JSON.stringify({
            reasoning: '',
            text: '',
            tool_calls: [{ id: 'call-never-executed', name: 'write', arguments_json: '{' }],
          })]) }
        },
      }
    },
  }))
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-tool-retry-limit',
    messages: [textMessage('user-1', 'write')],
  }
  const outcomes = []
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const outcome = await collectStreamFailure(adapter, options)
    outcomes.push(outcome)
    if (outcome.error.code !== 'TIMEOUT') break
  }
  assert.equal(outcomes.length, 3)
  assert.equal(outcomes.at(-1).error.code, 'TIMEOUT')
  assert.ok(outcomes.every(outcome => !outcome.chunks.some(chunk => chunk.type === 'tool-call-delta')))
  assert.equal(adapter.threadPool.size(), 0)
  assert.equal(starts, 3)
})

test('adapter repairs an outer structured response once without repeating visible content', async () => {
  const prompts = []
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-outer-repair',
        async runStreamed(prompt) {
          prompts.push(prompt)
          const response = prompts.length === 1
            ? '{"reasoning":"","text":"already visible"'
            : JSON.stringify({ reasoning: '', text: 'already visible', tool_calls: [] })
          return { events: streamedEvents([response], { input_tokens: 2, output_tokens: 1 }) }
        },
      }
    },
  }))
  const chunks = await collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-outer-repair',
    messages: [textMessage('user-1', 'answer')],
  })
  assert.equal(prompts.length, 2)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['already visible'])
  assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('outer repair with unexpected tool calls emits cumulative usage exactly once', async () => {
  const prompts = []
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-outer-repair-tools',
        async runStreamed(prompt) {
          prompts.push(prompt)
          const response = prompts.length === 1
            ? '{"reasoning":"","text":"visible"'
            : JSON.stringify({
                reasoning: '',
                text: '',
                tool_calls: [{ id: 'call-repair', name: 'read', arguments_json: '{}' }],
              })
          return {
            events: streamedEvents([response], {
              input_tokens: prompts.length === 1 ? 4 : 3,
              cached_input_tokens: prompts.length === 1 ? 1 : 1,
              output_tokens: prompts.length === 1 ? 2 : 5,
            }),
          }
        },
      }
    },
  }))

  const failure = await collectStreamFailure(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-outer-repair-tools',
    messages: [textMessage('user-outer-repair-tools', 'answer')],
  })
  assert.equal(failure.error.code, 'PROTOCOL')
  assert.equal(prompts.length, 2)
  assert.deepEqual(failure.chunks.filter(chunk => chunk.type === 'usage').map(chunk => chunk.usage), [{
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 14,
    cacheReadTokens: 2,
  }])
  assert.deepEqual(failure.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['visible'])
  assert.equal(failure.chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
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

test('thread pool unsubscribes exactly once on expiry, eviction, failure, replacement, and isolated release', () => {
  const lineage = (messageCount, continuation = false) => ({
    contextKey: 'pool-cleanup',
    messageKeys: Array.from({ length: messageCount }, (_, index) => String(index)),
    messageContentKeys: Array.from({ length: messageCount }, (_, index) => index === 1 && continuation
      ? codexAssistantFingerprint([])
      : String(index)),
    messageCount,
  })
  const options = { model: 'gpt-5.6-sol', sandboxMode: 'read-only' }
  let now = 0
  let created = 0
  const threads = []
  const create = () => {
    const thread = {
      id: `cleanup-thread-${++created}`,
      unsubscribed: 0,
      unsubscribe() {
        this.unsubscribed += 1
      },
    }
    threads.push(thread)
    return thread
  }
  const pool = new CodexThreadPool({ maxEntries: 1, idleMs: 10, now: () => now })

  const retained = pool.acquire({
    sessionId: 'cleanup-retained',
    lineage: lineage(1),
    threadOptions: options,
    createThread: create,
  })
  retained.release([])
  const reused = pool.acquire({
    sessionId: 'cleanup-retained',
    lineage: lineage(3, true),
    threadOptions: options,
    createThread: create,
  })
  reused.release([])
  assert.equal(retained.thread.unsubscribed, 0)

  now = 10
  pool.prune()
  assert.equal(retained.thread.unsubscribed, 1)
  pool.prune()
  assert.equal(retained.thread.unsubscribed, 1)

  const failed = pool.acquire({
    sessionId: 'cleanup-failed',
    lineage: lineage(1),
    threadOptions: options,
    createThread: create,
  })
  failed.invalidate()
  assert.equal(failed.thread.unsubscribed, 1)

  const isolated = pool.acquireIsolated({
    sessionId: 'cleanup-isolated',
    lineage: lineage(1),
    threadOptions: options,
    createThread: create,
  })
  isolated.release([])
  assert.equal(isolated.thread.unsubscribed, 1)

  const replaced = pool.acquire({
    sessionId: 'cleanup-replaced',
    lineage: lineage(1),
    threadOptions: options,
    createThread: create,
  })
  replaced.release([])
  const replacement = pool.acquire({
    sessionId: 'cleanup-replaced',
    lineage: lineage(1),
    threadOptions: { ...options, model: 'gpt-5.5' },
    createThread: create,
  })
  assert.equal(replaced.thread.unsubscribed, 1)
  replacement.invalidate()
  assert.equal(replacement.thread.unsubscribed, 1)

  const busy = pool.acquire({
    sessionId: 'cleanup-busy',
    lineage: lineage(1),
    threadOptions: options,
    createThread: create,
  })
  pool.invalidateSession('cleanup-busy')
  assert.equal(busy.thread.unsubscribed, 0)
  busy.invalidate()
  assert.equal(busy.thread.unsubscribed, 1)

  const lruPool = new CodexThreadPool({ maxEntries: 1, idleMs: 60_000, now: () => 0 })
  const lruA = lruPool.acquire({
    sessionId: 'cleanup-lru-a',
    lineage: lineage(1),
    threadOptions: options,
    createThread: create,
  })
  lruA.release([])
  const lruB = lruPool.acquire({
    sessionId: 'cleanup-lru-b',
    lineage: lineage(1),
    threadOptions: options,
    createThread: create,
  })
  lruB.release([])
  assert.equal(lruA.thread.unsubscribed, 1)
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
  assert.match(client, /\/auth\/status/)
  assert.match(client, /\/auth\/login/)
  assert.match(client, /\/auth\/cancel/)
  assert.match(client, /\/auth\/logout/)
  assert.match(client, /verificationUrl/)
  assert.match(client, /userCode/)
  assert.match(client, /setInterval/)
  assert.match(client, /confirm/)
  assert.match(client, /x-dsh-codex-auth/)
  assert.doesNotMatch(client, /email|auth\.json|api[_ -]?key|\btoken\b/i)
  const saveBody = client.slice(client.indexOf('const save = async'), client.indexOf('const reset = async'))
  assert.equal(saveBody.match(/\bconst models\b/g)?.length, 1)
  assert.match(saveBody, /const persistedModels/)
  assert.doesNotMatch(server, /registerConfigurableProviders/)
})

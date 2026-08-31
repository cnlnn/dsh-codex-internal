import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  buildCodexPrompt,
  buildCodexInput,
  buildCompactionPrompt,
  CODEX_ADAPTER_CONTEXT_WINDOW,
  CODEX_API_ROOT,
  CODEX_LEGACY_API_ROOT,
  CODEX_IMAGE_REQUEST_POLICY,
  appServerThreadParams,
  codexInputLength,
  CODEX_REPLAY_STATE_KIND,
  CODEX_REPLAY_STATE_VERSION,
  CODEX_COMPACTION_MAX_CALLS,
  CODEX_COMPACTION_MAX_CALLS_PER_LEVEL,
  CODEX_SAFE_PROMPT_CHAR_BUDGET,
  CODEX_PROVIDER,
  CodexAppServerClient,
  CodexAuthAdapter,
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

function replayAssistantMessage(id, text, model, replayState) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: {
      kind: 'model',
      provider: CODEX_PROVIDER,
      model,
      replayState,
    },
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
          {
            model: 'gpt-5.6-sol', displayName: 'Sol', hidden: false,
            inputModalities: ['text', 'image'],
          },
          { model: 'gpt-5.2', displayName: 'Unsupported', hidden: false },
          { model: 'gpt-reserve', displayName: 'Hidden', hidden: true },
        ],
      }
    },
  }

  const models = await discoverCodexCatalog(undefined, appServerClient)
  assert.deepEqual(models.map(model => model.id), ['gpt-5.6-sol'])
  assert.equal(models[0].contextWindow, CODEX_ADAPTER_CONTEXT_WINDOW)
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
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
  const auth = new CodexAuthAdapter(() => ({
    async request(method, params, options) {
      calls.push({ method, params, options })
      return { account: { type: 'chatgpt', email: 'must-not-return@example.test', planType: 'plus' } }
    },
  }))
  const status = await auth.status()
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
  const auth = new CodexAuthAdapter(() => client)
  const result = await auth.startLogin()
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
  const auth = new CodexAuthAdapter(() => client)
  const first = auth.startLogin()
  const second = auth.startLogin()
  await Promise.resolve()
  assert.equal(calls.filter(call => call.method === 'account/login/start').length, 1)
  gate.resolve({ type: 'chatgptDeviceCode', loginId: 'owned-login', verificationUrl: 'https://verify', userCode: 'ABCD-EFGH' })
  assert.deepEqual(await Promise.all([first, second]), [
    { type: 'chatgptDeviceCode', loginId: 'owned-login', verificationUrl: 'https://verify', userCode: 'ABCD-EFGH' },
    { type: 'chatgptDeviceCode', loginId: 'owned-login', verificationUrl: 'https://verify', userCode: 'ABCD-EFGH' },
  ])
  await auth.cancelLogin('attacker-supplied-login')
  assert.deepEqual(calls.at(-1), { method: 'account/login/cancel', params: { loginId: 'owned-login' } })
  await auth.logout()
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
  const auth = new CodexAuthAdapter(() => client)
  const routes = []
  const dispose = registerAuthRoutes({ webServer: { register(route) { routes.push(route); return () => {} } } }, auth)
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
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-dsh-codex-adapter-auth': '1' },
  }, accepted)
  assert.equal(accepted.statusCode, 200)
  assert.deepEqual(JSON.parse(accepted.body).value, {
    type: 'chatgptDeviceCode', loginId: 'route-login', verificationUrl: 'https://verify', userCode: 'ROUTE-CODE',
  })

  const legacyLoginRoute = routes.find(route => route.path === `${CODEX_LEGACY_API_ROOT}/auth/login`)
  const legacyAccepted = fakeResponse()
  await legacyLoginRoute.handler({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-codex-auth': '1' },
  }, legacyAccepted)
  assert.equal(legacyAccepted.statusCode, 200)
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
  const auth = new CodexAuthAdapter(() => ({ request: async () => ({}) }))
  const dispose = registerAuthRoutes(ctx, auth)
  assert.equal(registrations, 8)
  assert.equal(routes.size, 8)
  dispose()
  assert.equal(routes.size, 0)

  routes.set(`${CODEX_LEGACY_API_ROOT}/auth/cancel`, {})
  assert.throws(() => registerAuthRoutes(ctx, auth), /duplicate route/)
  assert.deepEqual([...routes.keys()], [`${CODEX_LEGACY_API_ROOT}/auth/cancel`])
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
    `${CODEX_API_ROOT}/auth/cancel`,
    `${CODEX_API_ROOT}/auth/login`,
    `${CODEX_API_ROOT}/auth/logout`,
    `${CODEX_API_ROOT}/auth/status`,
    `${CODEX_API_ROOT}/quota`,
    `${CODEX_LEGACY_API_ROOT}/auth/cancel`,
    `${CODEX_LEGACY_API_ROOT}/auth/login`,
    `${CODEX_LEGACY_API_ROOT}/auth/logout`,
    `${CODEX_LEGACY_API_ROOT}/auth/status`,
    `${CODEX_LEGACY_API_ROOT}/quota`,
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
      inputModalities: ['text', 'image'],
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
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(models[1].inputModalities, ['text'])
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
  for (const status of [401, 403]) {
    const classifiedAuth = classifySdkError({ status, message: 'provider authentication failed' })
    assert.equal(classifiedAuth.code, 'AUTH_REQUIRED')
    assert.match(classifiedAuth.message, /^Codex ChatGPT is not signed in\./)
  }
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
  const genericAuth = classifySdkError(new Error('authentication request reset'))
  assert.equal(genericAuth.code, 'AUTH_REQUIRED')
  assert.match(genericAuth.message, /^Codex ChatGPT is not signed in\./)
  assert.equal(classifySdkError({ code: 'PROTOCOL', message: 'malformed response' }).code, 'PROTOCOL')
  assert.equal(classifySdkError(new Error('invalid JSON response')).code, 'CODEX_SDK')
})

test('OAuth auth failures use a clear sign-in prompt and avoid DSH API-key AUTH', () => {
  const missingBearer = new Error(
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
  )
  const currentLoginFailure = classifySdkError(missingBearer)
  assert.equal(currentLoginFailure.code, 'AUTH_REQUIRED')
  assert.notEqual(currentLoginFailure.code, 'AUTH')
  assert.match(currentLoginFailure.message, /^Codex ChatGPT is not signed in\./)
  assert.equal(currentLoginFailure.cause, missingBearer)

  const requiredLoginFailure = classifySdkError({
    code: 'auth-required',
    message: 'ChatGPT authentication required; sign in through the Codex panel.',
  })
  assert.equal(requiredLoginFailure.code, 'AUTH_REQUIRED')
  assert.match(requiredLoginFailure.message, /^Codex ChatGPT is not signed in\./)

  const wrappedLoginFailure = classifySdkError(new LlmError('Codex turn failed', 'CODEX_APP_SERVER', {
    cause: { code: 'auth-required', message: 'ChatGPT authentication required' },
  }))
  assert.equal(wrappedLoginFailure.code, 'AUTH_REQUIRED')
  assert.match(wrappedLoginFailure.message, /^Codex ChatGPT is not signed in\./)

  for (const status of [401, 403]) {
    const wrappedStatusFailure = classifySdkError(new LlmError(
      'Codex app-server failed',
      'CODEX_APP_SERVER',
      { status },
    ))
    assert.equal(wrappedStatusFailure.code, 'AUTH_REQUIRED')
    assert.notEqual(wrappedStatusFailure.code, 'AUTH')
    assert.match(wrappedStatusFailure.message, /^Codex ChatGPT is not signed in\./)
    assert.equal(wrappedStatusFailure.failure.status, status)
  }
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
  assert.equal(classifyTurn({ code: 'unauthorized' }).code, 'AUTH_REQUIRED')
  assert.equal(classifyTurn({ code: 'serverOverloaded', httpStatusCode: 401 }).code, 'AUTH_REQUIRED')
  assert.equal(classifyTurn({ code: 'serverOverloaded', httpStatusCode: 403 }).code, 'AUTH_REQUIRED')
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

test('app-server adapter maps v2 events, usage, and request controls', async () => {
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
    ephemeral: false,
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
    summary: 'auto',
    outputSchema,
  })
})

test('app-server thread params mark auxiliary starts ephemeral and never mark resumes', () => {
  const auxiliary = appServerThreadParams({
    model: 'gpt-5.6-sol',
    ephemeral: true,
    threadSource: 'dsh-compaction',
  })
  assert.equal(auxiliary.ephemeral, true)
  assert.equal(auxiliary.threadSource, 'dsh-compaction')

  const ordinary = appServerThreadParams({ model: 'gpt-5.6-sol' })
  assert.equal(ordinary.ephemeral, false)

  const resumed = appServerThreadParams({
    model: 'gpt-5.6-sol',
    ephemeral: true,
    threadSource: 'must-not-be-forwarded',
  }, { resume: true, threadId: 'thread-restart' })
  assert.equal(resumed.threadId, 'thread-restart')
  assert.equal(Object.hasOwn(resumed, 'ephemeral'), false)
  assert.equal(Object.hasOwn(resumed, 'threadSource'), false)
})

test('app-server resume rejects a response without a resumed thread id', async () => {
  const rpc = new FakeAppServerRpc(method => method === 'thread/resume' ? {} : undefined)
  const client = new CodexAppServerClient({ rpc })
  const thread = client.resumeThread('thread-missing-id', { model: 'gpt-5.6-sol' })
  await assert.rejects(thread.ensureThread(), error => error.code === 'THREAD_RESUME_FAILED')
  await client.close()
})

test('app-server adapter maps native reasoning deltas and completed array summaries', async () => {
  const response = JSON.stringify({ reasoning: 'legacy fallback', text: 'done', tool_calls: [] })
  const rpc = new FakeAppServerRpc((method) => {
    if (method !== 'turn/start') return undefined
    queueMicrotask(() => {
      rpc.emit('item/reasoning/summaryTextDelta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', delta: 'first',
      })
      rpc.emit('item/reasoning/summaryTextDelta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', delta: ' second',
      })
      rpc.emit('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'reasoning', id: 'reasoning-1', summary: ['first second'], content: [] },
      })
      // V2 completed reasoning items carry public text in summary/content
      // arrays and may have no preceding delta notification at all.
      rpc.emit('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'reasoning', id: 'reasoning-2', summary: [], content: ['completed only'] },
      })
      rpc.emit('item/agentMessage/delta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: response,
      })
      rpc.emit('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'item-1', text: response },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
      })
    })
    return { turn: { id: 'turn-1', status: 'inProgress' } }
  })
  const thread = new CodexAppServerClient({ rpc }).startThread({ model: 'gpt-5.6-sol' })
  const streamed = await thread.runStreamed('prompt')
  const events = await collectIterable(streamed.events)
  assert.deepEqual(events.filter(event => event.item?.type === 'reasoning'), [
    { type: 'item.updated', item: { type: 'reasoning', id: 'reasoning-1', text: 'first' } },
    { type: 'item.updated', item: { type: 'reasoning', id: 'reasoning-1', text: 'first second' } },
    { type: 'item.completed', item: { type: 'reasoning', id: 'reasoning-1', text: 'first second' } },
    { type: 'item.completed', item: { type: 'reasoning', id: 'reasoning-2', text: 'completed only' } },
  ])
  assert.equal(rpc.calls.find(call => call.method === 'turn/start').params.summary, 'auto')
})

test('adapter prefers native reasoning, merges multiple items, and emits no duplicate fallback', async () => {
  const response = JSON.stringify({ reasoning: 'legacy fallback', text: 'done', tool_calls: [] })
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-native-reasoning',
        async runStreamed() {
          return {
            events: (async function * () {
              yield { type: 'item.updated', item: { type: 'reasoning', id: 'reasoning-empty', text: '' } }
              yield { type: 'item.updated', item: { type: 'reasoning', id: 'reasoning-1', text: 'first' } }
              yield { type: 'item.updated', item: { type: 'reasoning', id: 'reasoning-2', text: '' } }
              yield { type: 'item.updated', item: { type: 'reasoning', id: 'reasoning-2', text: 'second' } }
              yield { type: 'item.completed', item: { type: 'reasoning', id: 'reasoning-2', text: 'second' } }
              yield { type: 'item.completed', item: { type: 'reasoning', id: 'reasoning-1', text: 'first' } }
              yield { type: 'item.updated', item: { type: 'agent_message', id: 'message-1', text: response } }
              yield { type: 'item.completed', item: { type: 'agent_message', id: 'message-1', text: response } }
              yield { type: 'turn.completed' }
            })(),
          }
        },
      }
    },
  }))
  const chunks = await collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-native-reasoning',
    messages: [textMessage('user-native-reasoning', 'hello')],
  })
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text), [
    'first', '\nsecond',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    .map(chunk => chunk.block.text), ['first\nsecond'])
  assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text.includes('legacy')), false)
})

test('adapter falls back to structured reasoning when native items stay empty', async () => {
  const response = JSON.stringify({ reasoning: 'structured fallback', text: 'done', tool_calls: [] })
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-empty-reasoning',
        async runStreamed() {
          return {
            events: (async function * () {
              yield { type: 'item.updated', item: { type: 'reasoning', id: 'reasoning-empty', text: '' } }
              yield { type: 'item.completed', item: { type: 'reasoning', id: 'reasoning-empty', text: '' } }
              yield { type: 'item.updated', item: { type: 'agent_message', id: 'message-empty', text: response } }
              yield { type: 'item.completed', item: { type: 'agent_message', id: 'message-empty', text: response } }
              yield { type: 'turn.completed' }
            })(),
          }
        },
      }
    },
  }))
  const chunks = await collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    sessionId: 'session-empty-reasoning',
    messages: [textMessage('user-empty-reasoning', 'hello')],
  })
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text), [
    'structured fallback',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    .map(chunk => chunk.block.text), ['structured fallback'])
})

test('app-server adapter interrupts an active turn on abort', async () => {
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

test('local turn/start timeout stays live without unrelated ref handles', () => {
  const indexUrl = new URL('../index.js', import.meta.url).href
  const script = `
    import { CodexAppServerClient } from ${JSON.stringify(indexUrl)}

    const start = new Promise(() => {})
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
      request(method) {
        if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-timeout' } })
        if (method === 'turn/start') return start
        return Promise.resolve({})
      },
      close() {
        this.closed = true
      },
    }

    const client = new CodexAppServerClient({ rpc })
    const thread = client.startThread({ model: 'gpt-5.6-sol' })
    const streamed = await thread.runStreamed('timeout without handles', { timeoutMs: 10, wireTimeoutMs: 50 })
    try {
      await streamed.events.next()
      process.stdout.write('UNEXPECTED_RESOLUTION\\n')
      process.exitCode = 2
    } catch (error) {
      process.stdout.write(String(error?.code ?? 'UNKNOWN') + '\\n')
      if (error?.code !== 'TIMEOUT') process.exitCode = 3
    }
  `
  const result = spawnSync(process.execPath, [
    '--unhandled-rejections=strict',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 1_000,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.stdout.trim(), 'TIMEOUT')
})

test('app-server adapter keeps a late turn/start alive and interrupts once after early abort', async () => {
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

test('app-server adapter handles turn/started before a late turn/start response without duplicate interrupt', async () => {
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

test('app-server adapter times out local turn/start promptly and interrupts a late turn', async () => {
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

test('app-server adapter resumes a thread after a disconnected generation', async () => {
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
  const resume = rpc.calls.find(call => call.method === 'thread/resume')
  assert.equal(Object.hasOwn(resume.params, 'ephemeral'), false)
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

test('buildCodexInput projects ordered image attachments to native data URLs', async () => {
  const first = {
    attachmentId: 'sha256:first-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const second = {
    attachmentId: 'sha256:second-image', mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1,
  }
  const calls = []
  const signal = new AbortController().signal
  const attachments = {
    async readImageRequest(ref, policy, receivedSignal) {
      calls.push({ ref, policy, signal: receivedSignal })
      return {
        variantId: `variant:${ref.attachmentId}`,
        attachment: ref,
        data: Uint8Array.from([1, 2, 3]),
        mediaType: ref.mediaType,
        bytes: 3,
        width: 1,
        height: 1,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: first }] },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'image', attachment: second }],
        }],
      },
    ],
  }
  const input = await buildCodexInput(options, {
    id: 'gpt-image',
    inputModalities: ['text', 'image'],
  }, attachments, signal)
  assert.deepEqual(calls.map(call => call.ref.attachmentId), [
    first.attachmentId, second.attachmentId,
  ])
  assert.ok(calls.every(call => call.policy === CODEX_IMAGE_REQUEST_POLICY && call.signal === signal))
  assert.equal(input[1].text, `\n[DSH image 1: ${first.attachmentId}]`)
  assert.equal(input[2].url, 'data:image/png;base64,AQID')
  assert.equal(input[3].text, `\n[DSH image 2: ${second.attachmentId}]`)
  assert.equal(input[4].url, 'data:image/jpeg;base64,AQID')
  assert.match(input[0].text, new RegExp(first.attachmentId))
  assert.match(input[0].text, new RegExp(second.attachmentId))
})

test('buildCodexInput reads duplicate durable refs once but preserves both occurrences', async () => {
  const image = {
    attachmentId: 'sha256:duplicate-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  let reads = 0
  const input = await buildCodexInput({
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: image }] },
      { role: 'user', content: [{ type: 'image', attachment: image }] },
    ],
  }, {
    id: 'gpt-image',
    inputModalities: ['text', 'image'],
  }, {
    async readImageRequest(ref) {
      reads += 1
      return {
        attachment: ref,
        data: Uint8Array.from([1, 2, 3]),
        mediaType: ref.mediaType,
        bytes: 3,
        width: ref.width,
        height: ref.height,
      }
    },
  })
  assert.equal(reads, 1)
  assert.deepEqual(input.filter(item => item.type === 'image'), [
    { type: 'image', url: 'data:image/png;base64,AQID' },
    { type: 'image', url: 'data:image/png;base64,AQID' },
  ])
  assert.equal(input.filter(item => item.type === 'text' && item.text.startsWith('\n[DSH image')).length, 2)
})

test('image projection fails closed for unsupported models and missing attachment service', async () => {
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-text-only',
    messages: [{
      role: 'user',
      content: [{ type: 'image', attachment: {
        attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } }],
    }],
  }
  await assert.rejects(
    buildCodexInput(options, { id: options.model, inputModalities: ['text'] }, undefined),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
  await assert.rejects(
    buildCodexInput(options, { id: 'gpt-image', inputModalities: ['text', 'image'] }, undefined),
    error => error.code === 'ATTACHMENT_SERVICE_UNAVAILABLE',
  )
})

test('image projection rejects corrupted or identity-changing request versions', async () => {
  const image = {
    attachmentId: 'sha256:corrupt-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const base = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: image }] }],
  }
  await assert.rejects(buildCodexInput(base, { id: 'gpt-image', inputModalities: ['text', 'image'] }, {
    async readImageRequest(ref) {
      return { attachment: ref, data: Uint8Array.from([1, 2, 3]), mediaType: ref.mediaType, bytes: 2, width: 1, height: 1 }
    },
  }), error => error.code === 'ATTACHMENT_PROJECTION_FAILED')
  await assert.rejects(buildCodexInput(base, { id: 'gpt-image', inputModalities: ['text', 'image'] }, {
    async readImageRequest(ref) {
      return {
        attachment: { ...ref, width: 9 },
        data: Uint8Array.from([1, 2, 3]),
        mediaType: ref.mediaType,
        bytes: 3,
        width: 9,
        height: 1,
      }
    },
  }), error => error.code === 'ATTACHMENT_PROJECTION_FAILED')
})

test('adapter rejects a 700KB native image before runStreamed', async () => {
  const imageBytes = 700 * 1024
  const image = {
    attachmentId: 'sha256:oversized-native-image', mediaType: 'image/png', bytes: imageBytes, width: 1, height: 1,
  }
  let runs = 0
  const adapter = new CodexSubscriptionAdapter({
    models: [{ id: 'gpt-image', inputModalities: ['text', 'image'] }],
  }, () => ({
    startThread() {
      return {
        id: 'thread-oversized-native-image',
        async runStreamed() {
          runs += 1
          throw new Error('oversized native image must fail before run')
        },
      }
    },
  }), undefined, undefined, {
    async readImageRequest(ref) {
      return {
        attachment: ref,
        data: new Uint8Array(imageBytes),
        mediaType: ref.mediaType,
        bytes: imageBytes,
        width: ref.width,
        height: ref.height,
      }
    },
  })
  const projected = [{
    type: 'image',
    url: `data:image/png;base64,${Buffer.alloc(imageBytes).toString('base64')}`,
  }]
  assert.ok(codexInputLength(projected) > CODEX_SAFE_PROMPT_CHAR_BUDGET)
  const failure = await collectStreamFailure(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    messages: [{ id: 'image-user', role: 'user', content: [{ type: 'image', attachment: image }] }],
  })
  assert.equal(failure.error.code, CONTEXT_WINDOW_EXCEEDED_CODE)
  assert.equal(runs, 0)
  await adapter.close()
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

test('compaction source records nested image origin and durable ref metadata', () => {
  const image = {
    attachmentId: 'sha256:source-nested-image', mediaType: 'image/png', bytes: 3, width: 4, height: 5,
  }
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    messages: [{
      id: 'tool-message',
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-source',
        content: [{ type: 'text', text: 'before' }, { type: 'image', attachment: image }],
      }],
    }, textMessage('instruction', 'summarize')],
  }
  const fragment = splitCompactionSource(options, { includeFinalInstruction: false })
    .find(candidate => candidate.kind === 'image')
  assert.ok(fragment)
  assert.equal(fragment.metadata.blockPath, '0.1')
  assert.equal(fragment.metadata.toolResultId, 'call-source')
  assert.equal(fragment.metadata.pair, 'tool:call-source')
  assert.deepEqual(fragment.imageRefs, [{
    ref: image,
    messageIndex: 0,
    messageId: 'tool-message',
    role: 'user',
    blockIndex: 0,
    blockPath: '0.1',
    blockType: 'image',
    toolResultId: 'call-source',
    toolCallId: 'call-source',
    pair: 'tool:call-source',
    pairType: 'tool-result',
    toolResultContentIndex: 1,
  }])
  const prompt = buildCompactionPrompt(options, [fragment], 'intermediate')
  assert.match(prompt, new RegExp(image.attachmentId))
  assert.match(prompt, /blockPath/)
  assert.doesNotMatch(prompt, /AQID/)
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

test('adapter compacts image history with native input and deterministic references', async () => {
  let starts = 0
  let runs = 0
  const inputs = []
  const reads = []
  const image = {
    attachmentId: 'sha256:compaction-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const attachments = {
    async readImageRequest(ref) {
      reads.push(ref.attachmentId)
      return {
        variantId: `variant:${ref.attachmentId}`,
        attachment: ref,
        data: Uint8Array.from([1, 2, 3]),
        mediaType: ref.mediaType,
        bytes: 3,
        width: ref.width,
        height: ref.height,
      }
    },
  }
  const adapter = new CodexSubscriptionAdapter({
    models: [{ id: 'gpt-image', inputModalities: ['text', 'image'] }],
  }, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-compaction-image-${starts}`,
        async runStreamed(input) {
          runs += 1
          inputs.push(input)
          const finalResponse = JSON.stringify({ reasoning: '', text: 'visual summary', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }), undefined, undefined, attachments)
  const chunks = await collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    sessionId: 'session-compaction-image',
    messages: [
      { id: 'history', role: 'user', content: [{ type: 'image', attachment: image }] },
      textMessage('instruction', 'summarize the history'),
    ],
  })
  assert.equal(starts, 1)
  assert.equal(runs, 1)
  assert.deepEqual(reads, [image.attachmentId])
  assert.ok(Array.isArray(inputs[0]))
  assert.match(inputs[0][0].text, new RegExp(image.attachmentId))
  assert.equal(inputs[0][1].type, 'text')
  assert.equal(inputs[0][2].type, 'image')
  assert.equal(inputs[0][2].url, 'data:image/png;base64,AQID')
  const summaryText = chunks
    .filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text')
    .map(chunk => chunk.block.text)
    .join('\n')
  assert.match(summaryText, /visual summary/)
  assert.match(summaryText, new RegExp(`attachmentId=${image.attachmentId}`))
  assert.match(summaryText, /message=0; block=0/)
  assert.doesNotMatch(summaryText, /AQID/)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('segmented compaction preserves nested image occurrences and reuses one read', async () => {
  const image = {
    attachmentId: 'sha256:nested-compaction-image', mediaType: 'image/png', bytes: 3, width: 2, height: 3,
  }
  const reads = []
  const inputs = []
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    messages: [
      textMessage('history', 'facts-' + 'x'.repeat(6_000)),
      {
        id: 'tool-result',
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'image', attachment: image }],
        }],
      },
      textMessage('instruction', 'summarize the history'),
    ],
  }
  const attachments = {
    async readImageRequest(ref) {
      reads.push(ref.attachmentId)
      return {
        attachment: ref,
        data: Uint8Array.from([7, 8, 9]),
        mediaType: ref.mediaType,
        bytes: 3,
        width: ref.width,
        height: ref.height,
      }
    },
  }
  let created = 0
  const result = await prepareSegmentedCompaction(
    options,
    new AbortController().signal,
    () => ({
      id: `nested-${++created}`,
      async runStreamed(input) {
        inputs.push(input)
        const prompt = Array.isArray(input) ? input[0].text : input
        const text = prompt.includes('final pass') ? 'final visual summary' : `intermediate-${created}`
        return {
          events: streamedEvents([JSON.stringify({ reasoning: '', text, tool_calls: [] })], {
            input_tokens: 2,
            output_tokens: 1,
          }),
        }
      },
    }),
    {
      budget: 3_000,
      model: { id: 'gpt-image', inputModalities: ['text', 'image'] },
      getAttachments: attachments,
    },
  )
  assert.ok(created > 2)
  assert.deepEqual(reads, [image.attachmentId])
  const imageInputs = inputs.filter(input => Array.isArray(input) && input.some(item => item.type === 'image'))
  assert.ok(imageInputs.length > 0)
  assert.equal(imageInputs[0].find(item => item.type === 'image').url, 'data:image/png;base64,BwgJ')
  assert.match(imageInputs[0][0].text, new RegExp(image.attachmentId))
  assert.match(imageInputs[0][0].text, /blockPath|block=1\.0\.0/)
  assert.equal(imageInputs.length, 1)
  assert.match(result.prompt, new RegExp(image.attachmentId))
  assert.equal(typeof result.input, 'string')
  assert.doesNotMatch(result.input, /data:image\/png;base64/)
  assert.deepEqual(result.usage, {
    input_tokens: created * 2,
    output_tokens: created,
  })
})

test('segmented image compaction sends each image once and keeps the final pass text-only', async () => {
  const first = {
    attachmentId: 'sha256:segmented-image-one', mediaType: 'image/png', bytes: 500, width: 10, height: 11,
  }
  const second = {
    attachmentId: 'sha256:segmented-image-two', mediaType: 'image/png', bytes: 500, width: 20, height: 21,
  }
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    messages: [
      { id: 'image-one', role: 'user', content: [{ type: 'image', attachment: first }] },
      { id: 'image-two', role: 'user', content: [{ type: 'image', attachment: second }] },
      textMessage('instruction', 'summarize both images'),
    ],
  }
  const inputs = []
  let reads = 0
  let created = 0
  const result = await prepareSegmentedCompaction(
    options,
    new AbortController().signal,
    () => ({
      id: `segmented-images-${++created}`,
      async runStreamed(input) {
        inputs.push(input)
        return {
          events: streamedEvents([
            JSON.stringify({ reasoning: '', text: `visual-summary-${created}`, tool_calls: [] }),
          ]),
        }
      },
    }),
    {
      budget: 4_000,
      model: { id: 'gpt-image', inputModalities: ['text', 'image'] },
      getAttachments: {
        async readImageRequest(ref) {
          reads += 1
          return {
            attachment: ref,
            data: Uint8Array.from({ length: ref.bytes }, (_, index) =>
              ref.attachmentId.endsWith('one') ? index % 251 : (index + 1) % 251),
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          }
        },
      },
    },
  )
  assert.equal(reads, 2)
  assert.equal(inputs.length, 2)
  const imageInputs = inputs.map(input => input.filter(item => item.type === 'image'))
  assert.deepEqual(imageInputs.map(items => items.length), [1, 1])
  assert.equal(inputs.filter(input => JSON.stringify(input).includes(first.attachmentId)).length, 1)
  assert.equal(inputs.filter(input => JSON.stringify(input).includes(second.attachmentId)).length, 1)
  assert.ok(inputs.every(input => JSON.stringify(input).length <= 4_000))
  assert.equal(typeof result.input, 'string')
  assert.doesNotMatch(result.input, /data:image\/png;base64/)
  assert.match(result.input, new RegExp(first.attachmentId))
  assert.match(result.input, new RegExp(second.attachmentId))
  assert.ok(result.input.length <= 4_000)
})

test('image compaction fails closed for missing durable history before any model call', async () => {
  const image = {
    attachmentId: 'sha256:missing-compaction-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  let starts = 0
  let runs = 0
  const adapter = new CodexSubscriptionAdapter({
    models: [{ id: 'gpt-image', inputModalities: ['text', 'image'] }],
  }, () => ({
    startThread() {
      starts += 1
      return {
        id: `thread-missing-image-${starts}`,
        async runStreamed() {
          runs += 1
          throw new Error('missing image must fail before model run')
        },
      }
    },
  }), undefined, undefined, {
    async readImageRequest() {
      throw Object.assign(new Error('attachment not found'), { code: 'ATTACHMENT_NOT_FOUND' })
    },
  })
  await assert.rejects(collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    sessionId: 'session-missing-compaction-image',
    messages: [
      { id: 'history', role: 'user', content: [{ type: 'image', attachment: image }] },
      textMessage('instruction', 'summarize the history'),
    ],
  }), error => error.code === 'ATTACHMENT_PROJECTION_FAILED'
    && error.cause?.code === 'ATTACHMENT_NOT_FOUND')
  assert.equal(starts, 1)
  assert.equal(runs, 0)
})

test('segmented compaction rejects a duplicate image reference with conflicting metadata', async () => {
  const first = {
    attachmentId: 'sha256:conflicting-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const second = { ...first, width: 2 }
  let reads = 0
  let calls = 0
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    messages: [
      { id: 'one', role: 'user', content: [{ type: 'image', attachment: first }] },
      { id: 'two', role: 'user', content: [{ type: 'image', attachment: second }] },
      textMessage('instruction', 'summarize'),
    ],
  }
  await assert.rejects(prepareSegmentedCompaction(
    options,
    new AbortController().signal,
    () => {
      calls += 1
      throw new Error('conflicting refs must fail before model calls')
    },
    {
      model: { id: 'gpt-image', inputModalities: ['text', 'image'] },
      getAttachments: {
        async readImageRequest() {
          reads += 1
          return { attachment: first, data: Uint8Array.from([1, 2, 3]), mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
        },
      },
    },
  ), error => error.code === 'ATTACHMENT_PROJECTION_FAILED')
  assert.equal(reads, 0)
  assert.equal(calls, 0)
})

test('image compaction rejects an oversized native data URL before model calls', async () => {
  const image = {
    attachmentId: 'sha256:oversized-compaction-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  let runs = 0
  const adapter = new CodexSubscriptionAdapter({
    models: [{ id: 'gpt-image', inputModalities: ['text', 'image'] }],
  }, () => ({
    startThread() {
      return {
        id: 'thread-oversized-image',
        async runStreamed() {
          runs += 1
          throw new Error('oversized image must fail before run')
        },
      }
    },
  }), undefined, undefined, {
    async readImageRequest(ref) {
      return {
        attachment: ref,
        data: new Uint8Array(CODEX_SAFE_PROMPT_CHAR_BUDGET),
        mediaType: ref.mediaType,
        bytes: CODEX_SAFE_PROMPT_CHAR_BUDGET,
        width: ref.width,
        height: ref.height,
      }
    },
  })
  await assert.rejects(collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    messages: [
      { id: 'history', role: 'user', content: [{ type: 'image', attachment: image }] },
      textMessage('instruction', 'summarize'),
    ],
  }), error => error.code === 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(runs, 0)
})

test('image compaction aborts during durable preflight without a model call', async () => {
  const image = {
    attachmentId: 'sha256:aborted-compaction-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const controller = new AbortController()
  let runs = 0
  const adapter = new CodexSubscriptionAdapter({
    models: [{ id: 'gpt-image', inputModalities: ['text', 'image'] }],
  }, () => ({
    startThread() {
      return {
        id: 'thread-aborted-image',
        async runStreamed() {
          runs += 1
          throw new Error('aborted image must fail before run')
        },
      }
    },
  }), undefined, undefined, {
    async readImageRequest() {
      controller.abort()
      await new Promise(resolve => setImmediate(resolve))
      throw new Error('read cancelled')
    },
  })
  await assert.rejects(collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    purpose: 'compaction',
    signal: controller.signal,
    messages: [
      { id: 'history', role: 'user', content: [{ type: 'image', attachment: image }] },
      textMessage('instruction', 'summarize'),
    ],
  }), error => error.code === 'ABORTED')
  assert.equal(runs, 0)
})

test('adapter re-reads durable image refs after an adapter restart', async () => {
  const image = {
    attachmentId: 'sha256:restart-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const reads = []
  const makeAdapter = (label) => new CodexSubscriptionAdapter({
    models: [{ id: 'gpt-image', inputModalities: ['text', 'image'] }],
  }, () => ({
    startThread() {
      return {
        id: `thread-${label}`,
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }), undefined, undefined, {
    async readImageRequest(ref) {
      reads.push(label)
      return {
        attachment: ref,
        data: Uint8Array.from([1, 2, 3]),
        mediaType: ref.mediaType,
        bytes: 3,
        width: ref.width,
        height: ref.height,
      }
    },
  })
  const options = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    messages: [{ id: 'history', role: 'user', content: [{ type: 'image', attachment: image }] }],
  }
  const first = makeAdapter('first')
  await collectStream(first, options)
  await first.close()
  const second = makeAdapter('second')
  await collectStream(second, options)
  await second.close()
  assert.deepEqual(reads, ['first', 'second'])
})

test('app-server input keeps image data URLs on the native image wire', async () => {
  const rpc = new FakeAppServerRpc((method) => {
    if (method !== 'turn/start') return undefined
    queueMicrotask(() => {
      const response = JSON.stringify({ reasoning: '', text: 'ok', tool_calls: [] })
      rpc.emit('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'item-1', text: response },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      })
    })
    return { turn: { id: 'turn-1', status: 'inProgress' } }
  })
  const client = new CodexAppServerClient(rpc)
  const thread = client.startThread({ model: 'gpt-image' })
  const stream = await thread.runStreamed([
    { type: 'text', text: 'image prompt' },
    { type: 'image', url: 'data:image/png;base64,AQID' },
  ])
  await collectIterable(stream.events)
  await new Promise(resolve => setImmediate(resolve))
  const turn = rpc.calls.find(call => call.method === 'turn/start')
  assert.deepEqual(turn.params.input, [
    { type: 'text', text: 'image prompt', text_elements: [] },
    { type: 'image', url: 'data:image/png;base64,AQID' },
  ])
  await client.close()
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

test('adapter carries only hashed lineage metadata in the assistant replay state', async () => {
  const secret = 'do-not-persist-this-prompt'
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-replay-metadata',
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const chunks = await collectStream(adapter, {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-replay-metadata',
    system: secret,
    messages: [textMessage('replay-user-1', secret)],
  })
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.replayState.response.kind, CODEX_REPLAY_STATE_KIND)
  assert.equal(finish.replayState.response.version, CODEX_REPLAY_STATE_VERSION)
  assert.equal(finish.replayState.response.provider, CODEX_PROVIDER)
  assert.equal(finish.replayState.response.model, 'gpt-5.6-sol')
  assert.equal(finish.replayState.response.sessionId, 'session-replay-metadata')
  assert.equal(finish.replayState.response.threadId, 'thread-replay-metadata')
  assert.equal(finish.replayState.response.assistantCursor, 1)
  assert.equal(typeof finish.replayState.response.threadSignature, 'string')
  assert.equal(typeof finish.replayState.response.contextKey, 'string')
  assert.equal(typeof finish.replayState.response.assistantFingerprint, 'string')
  assert.equal(typeof finish.replayState.response.lineagePrefixFingerprint, 'string')
  assert.equal(typeof finish.replayState.response.savedAt, 'number')
  assert.equal(Object.hasOwn(finish.replayState, 'blocks'), false)
  assert.equal(JSON.stringify(finish.replayState).includes(secret), false)
})

test('adapter rejects unknown, versioned, flattened, and source-mismatched replay state', async () => {
  const firstAdapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-invalid-replay-state',
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const firstOptions = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-invalid-replay-state',
    messages: [textMessage('invalid-replay-user-1', 'hello')],
  }
  const replayState = (await collectStream(firstAdapter, firstOptions)).at(-1).replayState
  const baseResponse = replayState.response
  await firstAdapter.close()

  const cases = [
    {
      name: 'unknown-kind',
      replay: { response: { ...baseResponse, kind: 'other-adapter' } },
      sourceModel: firstOptions.model,
      requestModel: firstOptions.model,
    },
    {
      name: 'unknown-version',
      replay: { response: { ...baseResponse, version: CODEX_REPLAY_STATE_VERSION + 1 } },
      sourceModel: firstOptions.model,
      requestModel: firstOptions.model,
    },
    {
      name: 'flattened',
      replay: { ...baseResponse },
      sourceModel: firstOptions.model,
      requestModel: firstOptions.model,
    },
    {
      name: 'flattened-without-kind',
      replay: { ...baseResponse, kind: undefined },
      sourceModel: firstOptions.model,
      requestModel: firstOptions.model,
    },
    {
      name: 'source-model-mismatch',
      replay: replayState,
      sourceModel: 'gpt-5.6-luna',
      requestModel: firstOptions.model,
    },
    {
      name: 'request-model-mismatch',
      replay: replayState,
      sourceModel: firstOptions.model,
      requestModel: 'gpt-5.6-luna',
    },
  ]
  for (const testCase of cases) {
    let resumes = 0
    let starts = 0
    const adapter = new CodexSubscriptionAdapter({}, () => ({
      resumeThread() {
        resumes += 1
        throw new Error(`unexpected resume in ${testCase.name} case`)
      },
      startThread() {
        starts += 1
        return {
          id: `thread-${testCase.name}`,
          async runStreamed() {
            const finalResponse = JSON.stringify({ reasoning: '', text: 'fresh', tool_calls: [] })
            return { events: streamedEvents([finalResponse]) }
          },
        }
      },
    }))
    await collectStream(adapter, {
      ...firstOptions,
      model: testCase.requestModel,
      messages: [
        ...firstOptions.messages,
        replayAssistantMessage(
          `invalid-replay-assistant-${testCase.name}`,
          'done',
          testCase.sourceModel,
          testCase.replay,
        ),
        textMessage(`invalid-replay-user-2-${testCase.name}`, 'next'),
      ],
    })
    assert.equal(resumes, 0, `${testCase.name} should not resume`)
    assert.equal(starts, 1, `${testCase.name} should start a fresh thread`)
    await adapter.close()
  }
})

test('adapter resumes a persisted Codex thread after a new adapter instance', async () => {
  const firstAdapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-restart',
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const firstOptions = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-restart',
    system: 'system',
    messages: [textMessage('restart-user-1', 'hello')],
  }
  const firstChunks = await collectStream(firstAdapter, firstOptions)
  const replayState = firstChunks.at(-1).replayState
  assert.equal(replayState.response.threadId, 'thread-restart')
  await firstAdapter.close()

  const resumed = []
  const prompts = []
  const secondAdapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      throw new Error('persisted thread must not start a new thread before resume')
    },
    resumeThread(threadId, options) {
      resumed.push({ threadId, options })
      return {
        id: threadId,
        async ensureThread() {},
        async runStreamed(prompt) {
          prompts.push(prompt)
          const finalResponse = JSON.stringify({ reasoning: '', text: 'continued', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  await collectStream(secondAdapter, {
    ...firstOptions,
    messages: [
      ...firstOptions.messages,
      replayAssistantMessage('restart-assistant-1', 'done', firstOptions.model, replayState),
      textMessage('restart-user-2', 'next'),
    ],
  })

  assert.deepEqual(resumed.map(call => call.threadId), ['thread-restart'])
  assert.equal(prompts.length, 1)
  const payload = JSON.parse(prompts[0].slice(prompts[0].lastIndexOf('\n') + 1))
  assert.deepEqual(payload, {
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'next' }],
    }],
    generation: { max_tokens: null },
  })
  await secondAdapter.close()
})

test('adapter falls back to a fresh thread for a raw no-rollout resume error', async () => {
  const firstAdapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-expired',
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const firstOptions = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-expired',
    system: 'system',
    messages: [textMessage('expired-user-1', 'hello')],
  }
  const firstChunks = await collectStream(firstAdapter, firstOptions)
  const replayState = firstChunks.at(-1).replayState
  await firstAdapter.close()

  const resumes = []
  const starts = []
  const prompts = []
  const secondAdapter = new CodexSubscriptionAdapter({}, () => ({
    resumeThread(threadId) {
      resumes.push(threadId)
      return {
        id: threadId,
        async ensureThread() {
          throw Object.assign(new Error('no rollout found'), {
            code: -32600,
            method: 'thread/resume',
          })
        },
        async runStreamed() {
          throw new Error('expired resume must not run')
        },
      }
    },
    startThread() {
      const threadId = `thread-fresh-${starts.length + 1}`
      starts.push(threadId)
      return {
        id: threadId,
        async ensureThread() {},
        async runStreamed(prompt) {
          prompts.push(prompt)
          const finalResponse = JSON.stringify({ reasoning: '', text: 'fresh', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  await collectStream(secondAdapter, {
    ...firstOptions,
    messages: [
      ...firstOptions.messages,
      replayAssistantMessage('expired-assistant-1', 'done', firstOptions.model, replayState),
      textMessage('expired-user-2', 'next'),
    ],
  })

  assert.deepEqual(resumes, ['thread-expired'])
  assert.deepEqual(starts, ['thread-fresh-1'])
  const payload = JSON.parse(prompts[0].slice(prompts[0].lastIndexOf('\n') + 1))
  assert.equal(payload.system, 'system')
  assert.equal(payload.messages.length, 3)
  assert.equal(payload.messages[0].content[0].text, 'hello')
  assert.equal(payload.messages[2].content[0].text, 'next')
  await secondAdapter.close()
})

test('adapter does not hide a global app-server failure as a fresh thread', async () => {
  const firstAdapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-global-failure',
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const firstOptions = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-global-failure',
    messages: [textMessage('global-failure-user-1', 'hello')],
  }
  const firstChunks = await collectStream(firstAdapter, firstOptions)
  const replayState = firstChunks.at(-1).replayState
  await firstAdapter.close()

  let starts = 0
  const secondAdapter = new CodexSubscriptionAdapter({}, () => ({
    resumeThread(threadId) {
      assert.equal(threadId, 'thread-global-failure')
      return {
        id: threadId,
        async ensureThread() {
          throw Object.assign(new Error('Codex app-server exited'), { code: 'APP_SERVER_EXIT' })
        },
        async runStreamed() {
          throw new Error('global resume failure must not run')
        },
      }
    },
    startThread() {
      starts += 1
      throw new Error('global resume failure must not start a new thread')
    },
  }))
  const failure = await collectStreamFailure(secondAdapter, {
    ...firstOptions,
    messages: [
      ...firstOptions.messages,
      replayAssistantMessage('global-failure-assistant-1', 'done', firstOptions.model, replayState),
      textMessage('global-failure-user-2', 'next'),
    ],
  })
  assert.equal(failure.error.code, 'SERVER')
  assert.equal(starts, 0)
  await secondAdapter.close()
})

test('adapter does not treat an unknown -32600 resume failure as a stale thread', async () => {
  const firstAdapter = new CodexSubscriptionAdapter({}, () => ({
    startThread() {
      return {
        id: 'thread-backend-exploded',
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const firstOptions = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-backend-exploded',
    messages: [textMessage('backend-exploded-user-1', 'hello')],
  }
  const firstChunks = await collectStream(firstAdapter, firstOptions)
  const replayState = firstChunks.at(-1).replayState
  await firstAdapter.close()

  let starts = 0
  const secondAdapter = new CodexSubscriptionAdapter({}, () => ({
    resumeThread(threadId) {
      assert.equal(threadId, 'thread-backend-exploded')
      return {
        id: threadId,
        async ensureThread() {
          throw Object.assign(new Error('backend exploded'), {
            code: -32600,
            method: 'thread/resume',
          })
        },
        async runStreamed() {
          throw new Error('unknown resume failure must not run')
        },
      }
    },
    startThread() {
      starts += 1
      throw new Error('unknown resume failure must not start a new thread')
    },
  }))
  const failure = await collectStreamFailure(secondAdapter, {
    ...firstOptions,
    messages: [
      ...firstOptions.messages,
      replayAssistantMessage('backend-exploded-assistant-1', 'done', firstOptions.model, replayState),
      textMessage('backend-exploded-user-2', 'next'),
    ],
  })
  assert.equal(failure.error.code, 'CODEX_SDK')
  assert.match(failure.error.message, /backend exploded/)
  assert.equal(starts, 0)
  await secondAdapter.close()
})

test('adapter does not resume persisted threads across history or runtime changes', async () => {
  const baseConfig = { workingDirectory: '/tmp/replay', allowNetworkAccess: false }
  const firstAdapter = new CodexSubscriptionAdapter(baseConfig, () => ({
    startThread() {
      return {
        id: 'thread-isolated-replay',
        async runStreamed() {
          const finalResponse = JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([finalResponse]) }
        },
      }
    },
  }))
  const firstOptions = {
    provider: CODEX_PROVIDER,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sessionId: 'session-isolated-replay',
    system: 'system',
    messages: [textMessage('isolated-user-1', 'hello')],
  }
  const firstChunks = await collectStream(firstAdapter, firstOptions)
  const replayState = firstChunks.at(-1).replayState
  await firstAdapter.close()

  const cases = [
    {
      name: 'history',
      config: baseConfig,
      options: {
        ...firstOptions,
        messages: [
          textMessage('isolated-user-edited', 'changed'),
          replayAssistantMessage('isolated-assistant-1', 'done', firstOptions.model, replayState),
          textMessage('isolated-user-2', 'next'),
        ],
      },
    },
    {
      name: 'model',
      config: baseConfig,
      options: {
        ...firstOptions,
        model: 'gpt-5.6-luna',
        messages: [
          ...firstOptions.messages,
          replayAssistantMessage('isolated-assistant-1', 'done', firstOptions.model, replayState),
          textMessage('isolated-user-2', 'next'),
        ],
      },
    },
    {
      name: 'effort',
      config: baseConfig,
      options: {
        ...firstOptions,
        reasoningEffort: 'high',
        messages: [
          ...firstOptions.messages,
          replayAssistantMessage('isolated-assistant-1', 'done', firstOptions.model, replayState),
          textMessage('isolated-user-2', 'next'),
        ],
      },
    },
    {
      name: 'network',
      config: { ...baseConfig, allowNetworkAccess: true },
      options: {
        ...firstOptions,
        messages: [
          ...firstOptions.messages,
          replayAssistantMessage('isolated-assistant-1', 'done', firstOptions.model, replayState),
          textMessage('isolated-user-2', 'next'),
        ],
      },
    },
    {
      name: 'directory',
      config: { ...baseConfig, workingDirectory: '/tmp/other-replay' },
      options: {
        ...firstOptions,
        messages: [
          ...firstOptions.messages,
          replayAssistantMessage('isolated-assistant-1', 'done', firstOptions.model, replayState),
          textMessage('isolated-user-2', 'next'),
        ],
      },
    },
  ]
  for (const testCase of cases) {
    let resumes = 0
    let starts = 0
    const adapter = new CodexSubscriptionAdapter(testCase.config, () => ({
      resumeThread() {
        resumes += 1
        throw new Error(`unexpected resume in ${testCase.name} case`)
      },
      startThread() {
        starts += 1
        return {
          id: `thread-${testCase.name}`,
          async runStreamed() {
            const finalResponse = JSON.stringify({ reasoning: '', text: 'fresh', tool_calls: [] })
            return { events: streamedEvents([finalResponse]) }
          },
        }
      },
    }))
    await collectStream(adapter, testCase.options)
    assert.equal(resumes, 0, `${testCase.name} should not resume`)
    assert.equal(starts, 1, `${testCase.name} should start a fresh thread`)
    await adapter.close()
  }
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

test('adapter projects only new images across three reused turns', async () => {
  const prompts = []
  const reads = []
  let starts = 0
  const firstImage = {
    attachmentId: 'sha256:turn-one-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const secondImage = {
    attachmentId: 'sha256:turn-two-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  }
  const assistantToolCall = (messageId, callId) => ({
    id: messageId,
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }],
  })
  const toolResult = (id, callId, image) => ({
    id,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: image === undefined
        ? [{ type: 'text', text: 'no image' }]
        : [{ type: 'image', attachment: image }],
    }],
  })
  const attachments = {
    async readImageRequest(ref) {
      reads.push(ref.attachmentId)
      return {
        attachment: ref,
        data: Uint8Array.from([7, 8, 9]),
        mediaType: ref.mediaType,
        bytes: 3,
        width: 1,
        height: 1,
      }
    },
  }
  const adapter = new CodexSubscriptionAdapter({
    models: [{ id: 'gpt-image', inputModalities: ['text', 'image'] }],
  }, () => ({
    startThread() {
      starts += 1
      let calls = 0
      return {
        id: `thread-image-${starts}`,
        async runStreamed(prompt) {
          prompts.push(prompt)
          calls += 1
          const response = calls < 3
            ? JSON.stringify({
                reasoning: '',
                text: '',
                tool_calls: [{ id: `call-${calls}`, name: 'inspect', arguments_json: '{}' }],
              })
            : JSON.stringify({ reasoning: '', text: 'done', tool_calls: [] })
          return { events: streamedEvents([response]) }
        },
      }
    },
  }), undefined, undefined, attachments)
  const first = {
    provider: CODEX_PROVIDER,
    model: 'gpt-image',
    sessionId: 'session-three-images',
    messages: [{
      id: 'user-1',
      role: 'user',
      content: [{ type: 'image', attachment: firstImage }],
    }],
  }
  const second = {
    ...first,
    messages: [
      ...first.messages,
      assistantToolCall('assistant-1', 'call-1'),
      toolResult('tool-1', 'call-1', secondImage),
    ],
  }
  const third = {
    ...second,
    messages: [
      ...second.messages,
      assistantToolCall('assistant-2', 'call-2'),
      toolResult('tool-2', 'call-2'),
    ],
  }

  await collectStream(adapter, first)
  await collectStream(adapter, second)
  await collectStream(adapter, third)

  assert.equal(starts, 1)
  assert.deepEqual(reads, [firstImage.attachmentId, secondImage.attachmentId])
  assert.match(prompts[0][0].text, new RegExp(firstImage.attachmentId))
  assert.match(prompts[0][2].url, /^data:image\/png;base64,/)
  assert.match(prompts[1][0].text, new RegExp(secondImage.attachmentId))
  assert.doesNotMatch(prompts[1][0].text, new RegExp(firstImage.attachmentId))
  assert.doesNotMatch(prompts[2], new RegExp(firstImage.attachmentId))
  assert.doesNotMatch(prompts[2], new RegExp(secondImage.attachmentId))
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
  const threadOptions = []
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread(options) {
      starts += 1
      threadOptions.push(options)
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
  assert.deepEqual(threadOptions.map(options => options.ephemeral), [false, true, true, false])
})

test('adapter segments an oversized compaction request and emits one cumulative usage event', async () => {
  const prompts = []
  const threadOptions = []
  let starts = 0
  const adapter = new CodexSubscriptionAdapter({}, () => ({
    startThread(options) {
      starts += 1
      threadOptions.push(options)
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
  assert.ok(threadOptions.every(options => options.ephemeral === true))
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
	assert.doesNotMatch(client, /工作目录/)
	assert.match(client, /独立登录域/)
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
  assert.match(client, /x-dsh-codex-adapter-auth/)
  assert.match(client, /inputModalities/)
  assert.match(client, /单次请求输出默认值/)
  assert.doesNotMatch(client, /email|auth\.json|api[_ -]?key|\btoken\b/i)
  const saveBody = client.slice(client.indexOf('const save = async'), client.indexOf('const reset = async'))
  assert.equal(saveBody.match(/\bconst models\b/g)?.length, 1)
  assert.match(saveBody, /const persistedModels/)
  assert.doesNotMatch(server, /registerConfigurableProviders/)
})

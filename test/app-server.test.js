import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, getEventListeners } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
	CODEX_ADAPTER_VERSION,
	CODEX_APP_SERVER_CONFIG_TOML,
	CODEX_APP_SERVER_CONFIG_OVERRIDES,
	CODEX_CLI_PATH,
	CodexAppServerRpc,
	applyWindowsPrivateDirectoryAcl,
	atomicWritePrivateFile,
	codexAppServerEnvironment,
	ensureCodexRuntime,
	expandHomePath,
	resolveCodexRuntimePaths,
	validateWindowsAclSnapshot,
} from '../lib/app-server.js'
import { CodexAppServerClient } from '../index.js'

class FakeStream extends EventEmitter {
	setEncoding(encoding) {
		this.encoding = encoding
	}
}

class FakeStdin extends EventEmitter {
	constructor(onWrite) {
		super()
		this.writes = []
		this.onWrite = onWrite
	}

	write(line) {
		this.writes.push(line)
		this.onWrite(JSON.parse(line))
		return true
	}
}

class FakeChild extends EventEmitter {
	constructor(pid, onWrite) {
		super()
		this.pid = pid
		this.stdout = new FakeStream()
		this.stderr = new FakeStream()
		this.stdin = new FakeStdin(onWrite)
		this.killCalls = []
		this.unrefCalls = 0
	}

	kill(signal) {
		this.killCalls.push(signal)
		return true
	}

	unref() {
		this.unrefCalls += 1
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

function fakeSpawner(onMessage = () => {}) {
	const children = []
	const calls = []
	const spawn = (command, args, options) => {
		const child = new FakeChild(children.length + 1, message => onMessage(child, message, children.length))
		children.push(child)
		calls.push({ command, args, options, child })
		return child
	}
	return { children, calls, spawn }
}

function respond(child, id, result) {
	child.stdout.emit('data', `${JSON.stringify({ id, result })}\n`)
}

function rejectRpc(child, id, code, message) {
	child.stdout.emit('data', `${JSON.stringify({ id, error: { code, message } })}\n`)
}

function initializeAndRespond(onRequest = (child, message) => respond(child, message.id, { ok: true })) {
	return fakeSpawner((child, message) => {
		if (message.method === 'initialize') {
			respond(child, message.id, { serverInfo: { name: 'fake' } })
			return
		}
		if (message.method === 'initialized') return
		onRequest(child, message)
	})
}

test('resolves the plugin Codex home from DSH_HOME without inheriting CODEX_HOME', () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-codex-path-test-'))
	try {
		const testHome = join(root, 'test-user')
		const configuredDshHome = join(root, 'dsh-configured')
		const globalCodexHome = join(root, 'global-codex')
		const paths = resolveCodexRuntimePaths({
			env: { DSH_HOME: configuredDshHome, CODEX_HOME: globalCodexHome },
			homeDir: testHome,
		})
		assert.deepEqual(paths, {
			dshHome: configuredDshHome,
			codexHome: join(configuredDshHome, 'codex-adapter'),
			workspace: join(configuredDshHome, 'codex-adapter', 'workspace'),
			configPath: join(configuredDshHome, 'codex-adapter', 'config.toml'),
		})
		const fallback = resolveCodexRuntimePaths({ env: { DSH_HOME: '  ' }, homeDir: testHome })
		assert.equal(fallback.codexHome, join(testHome, '.dsh', 'codex-adapter'))

		const environment = codexAppServerEnvironment({
			paths,
			source: { HOME: testHome, CODEX_HOME: globalCodexHome, OPENAI_API_KEY: 'must-not-pass' },
		})
		assert.equal(environment.CODEX_HOME, paths.codexHome)
		assert.equal(environment.HOME, testHome)
		assert.equal(environment.OPENAI_API_KEY, undefined)
		assert.equal(environment.CODEX_SQLITE_HOME, undefined)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('expands POSIX and Windows home shorthands before resolving the plugin home', () => {
	const home = join(tmpdir(), 'dsh-home-expansion-test')
	assert.equal(expandHomePath('~', home), home)
	assert.equal(expandHomePath('~/codex-adapter', home), join(home, 'codex-adapter'))
	assert.equal(expandHomePath('~\\codex-adapter', home), join(home, 'codex-adapter'))
	assert.equal(expandHomePath('~other/codex-adapter', home), '~other/codex-adapter')
	assert.equal(resolveCodexRuntimePaths({ env: { DSH_HOME: '~/dsh' }, homeDir: home }).dshHome, join(home, 'dsh'))
	assert.equal(resolveCodexRuntimePaths({ env: { DSH_HOME: '~\\dsh' }, homeDir: home }).dshHome, join(home, 'dsh'))
})

test('Windows private ACL helper replaces explicit rules and fails closed on an extra ACE', () => {
	const calls = []
	const sid = 'S-1-5-21-111-222-333-1001'
	const path = 'C:\\dsh\\codex-adapter'
	const ownerRule = {
		Sid: sid,
		Type: 'Allow',
		Rights: 0x1f01ff,
		Inheritance: 3,
		Propagation: 0,
		Inherited: false,
	}
	const runCommand = (command, args) => {
		calls.push({ command, args })
		if (command === 'whoami') return 'USER\nS-1-5-21-111-222-333-1001\n'
		return `DCA_ACL_RESULT:${JSON.stringify({ Protected: true, Rules: [ownerRule] })}`
	}
	applyWindowsPrivateDirectoryAcl(path, { platform: 'win32', runCommand })
	assert.equal(calls.length, 2)
	assert.deepEqual(calls[0], { command: 'whoami', args: ['/user'] })
	assert.equal(calls[1].command, 'powershell.exe')
	assert.deepEqual(calls[1].args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive'])
	assert.equal(calls[1].args[3], '-EncodedCommand')
	const script = Buffer.from(calls[1].args[4], 'base64').toString('utf16le')
	assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/)
	assert.match(script, /RemoveAccessRuleSpecific/)
	assert.match(script, /\$rules\.Count -ne 1/)
	assert.doesNotThrow(() => validateWindowsAclSnapshot({ Protected: true, Rules: [ownerRule] }, sid))
	assert.throws(() => validateWindowsAclSnapshot({
		Protected: true,
		Rules: [ownerRule, { ...ownerRule, Sid: 'S-1-1-0' }],
	}, sid), /owner-only DACL/)
	assert.throws(() => applyWindowsPrivateDirectoryAcl(path, {
		platform: 'win32',
		userSid: sid,
		runCommand() {
			return `DCA_ACL_RESULT:${JSON.stringify({ Protected: true, Rules: [ownerRule, { ...ownerRule, Sid: 'S-1-1-0' }] })}`
		},
	}), /owner-only DACL/)
	assert.throws(() => applyWindowsPrivateDirectoryAcl(path, {
		platform: 'win32',
		userSid: sid,
		runCommand() {
			throw new Error('access denied')
		},
	}), /access denied/)
	const ignored = []
	applyWindowsPrivateDirectoryAcl(join(tmpdir(), 'ignored'), {
		platform: 'linux',
		runCommand: (...args) => ignored.push(args),
	})
	assert.deepEqual(ignored, [])
})

test('writes a private minimal Codex config atomically and preserves the old file on replacement', () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-codex-runtime-test-'))
	try {
		const paths = resolveCodexRuntimePaths({ env: { DSH_HOME: root }, homeDir: join(root, 'unused') })
		ensureCodexRuntime({ paths })
		if (process.platform !== 'win32') {
			assert.equal(statSync(paths.codexHome).mode & 0o777, 0o700)
			assert.equal(statSync(paths.workspace).mode & 0o777, 0o700)
			assert.equal(statSync(paths.configPath).mode & 0o777, 0o600)
		}
		const canonical = readFileSync(paths.configPath, 'utf8')
		assert.equal(canonical, CODEX_APP_SERVER_CONFIG_TOML)
		assert.ok(canonical.indexOf('forced_login_method') < canonical.indexOf('[features]'))
		const rootConfig = canonical.split('[features]', 1)[0]
		assert.doesNotMatch(rootConfig, /^mcp_servers\s*=/m)
		assert.doesNotMatch(rootConfig, /^plugins\s*=/m)

		const before = process.platform === 'win32' ? undefined : statSync(paths.configPath).ino
		atomicWritePrivateFile(paths.configPath, 'instructions = "replacement-marker"\n', 0o600)
		assert.equal(readFileSync(paths.configPath, 'utf8'), 'instructions = "replacement-marker"\n')
		if (process.platform !== 'win32') assert.notEqual(statSync(paths.configPath).ino, before)
		assert.deepEqual(readdirSync(paths.codexHome).filter(name => name.endsWith('.tmp')), [])

		// A later app-server generation restores the plugin-owned canonical config.
		ensureCodexRuntime({ paths })
		assert.equal(readFileSync(paths.configPath, 'utf8'), CODEX_APP_SERVER_CONFIG_TOML)
		if (process.platform !== 'win32') assert.equal(statSync(paths.configPath).mode & 0o777, 0o600)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('official app-server reads the isolated config and ignores global MCP and instruction markers', async () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-codex-isolation-test-'))
	let child
	try {
		const globalHome = join(root, 'global-codex')
		mkdirSync(globalHome, { recursive: true, mode: 0o700 })
		const marker = join(root, 'global-marker')
		const markerCode = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')`
		const globalConfig = [
			'instructions = "GLOBAL-INSTRUCTION-MARKER"',
			'[mcp_servers.global_marker]',
			`command = ${JSON.stringify(process.execPath)}`,
			`args = ${JSON.stringify(['-e', markerCode])}`,
		].join('\n') + '\n'
		writeFileSync(join(globalHome, 'config.toml'), globalConfig, { mode: 0o600 })
		const paths = resolveCodexRuntimePaths({ env: { DSH_HOME: join(root, 'dsh') }, homeDir: join(root, 'unused') })
		ensureCodexRuntime({ paths })
		const source = {
			...process.env,
			HOME: root,
			CODEX_HOME: globalHome,
		}
		child = spawn(
			process.execPath,
			[CODEX_CLI_PATH, 'app-server', '--stdio'],
			{
				cwd: paths.workspace,
				env: codexAppServerEnvironment({ paths, source }),
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		)
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		let stdout = ''
		let stderr = ''
		const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
		const response = await new Promise((resolve, reject) => {
			let settled = false
			let buffer = ''
			let initialized = false
			const timer = setTimeout(() => finish(new Error(`config/read timed out. stdout=${stdout} stderr=${stderr}`)), 15_000)
			const finish = (error, value) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (error === undefined) resolve(value)
				else reject(error)
			}
			child.stdout.on('data', chunk => {
				stdout += chunk
				buffer += chunk
				for (;;) {
					const newline = buffer.indexOf('\n')
					if (newline < 0) break
					const line = buffer.slice(0, newline).trim()
					buffer = buffer.slice(newline + 1)
					if (line.length === 0) continue
					let message
					try { message = JSON.parse(line) } catch (error) {
						finish(new Error(`invalid app-server JSON: ${error.message}; line=${line}`))
						return
					}
					if (message.id === 1 && !initialized) {
						initialized = true
						child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
						child.stdin.write(`${JSON.stringify({ id: 2, method: 'config/read', params: {} })}\n`)
					}
					if (message.id === 2) finish(undefined, message)
				}
			})
			child.stderr.on('data', chunk => { stderr += chunk })
			child.once('error', error => finish(error))
			child.once('exit', (code, signal) => {
				if (!settled) finish(new Error(`app-server exited before config/read: code=${code} signal=${signal}; stdout=${stdout} stderr=${stderr}`))
			})
			child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {
				clientInfo: { name: 'dsh-isolation-test', version: CODEX_ADAPTER_VERSION },
				capabilities: { experimentalApi: true },
			} })}\n`)
		})
		child.stdin.end()
		await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1_000))])
		assert.ok(response?.result?.config)
		assert.equal(response.result.config.instructions, null)
		assert.equal(response.result.config.developer_instructions, null)
		assert.equal(response.result.config.model_instructions_file, null)
		assert.deepEqual(response.result.config.mcp_servers, {})
		assert.deepEqual(response.result.config.plugins, {})
		assert.equal(response.result.config.hooks, null)
		for (const feature of ['apps', 'plugins', 'hooks', 'memories', 'shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'web_search', 'standalone_web_search']) {
			assert.equal(response.result.config.features[feature], false, feature)
		}
		assert.equal(readFileSync(join(globalHome, 'config.toml'), 'utf8'), globalConfig)
		assert.equal(statSync(marker, { throwIfNoEntry: false }), undefined)
	} finally {
		if (child !== undefined && child.exitCode === null) child.kill()
		rmSync(root, { recursive: true, force: true })
	}
})

test('app-server generations use the same private home and controlled cwd for thread resume', async () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-codex-restart-test-'))
	try {
		const paths = resolveCodexRuntimePaths({ env: { DSH_HOME: root }, homeDir: join(root, 'unused') })
		const makeHarness = () => initializeAndRespond((child, message) => {
			if (message.method === 'thread/start' || message.method === 'thread/resume') {
				respond(child, message.id, { thread: { id: 'persisted-thread' } })
				return
			}
			respond(child, message.id, { ok: true })
		})

		const first = makeHarness()
		const firstRpc = new CodexAppServerRpc({ spawn: first.spawn, runtimePaths: paths })
		assert.deepEqual(await firstRpc.request('thread/start', { ephemeral: false }), {
			thread: { id: 'persisted-thread' },
		})
		firstRpc.close()

		const second = makeHarness()
		const secondRpc = new CodexAppServerRpc({ spawn: second.spawn, runtimePaths: paths })
		assert.deepEqual(await secondRpc.request('thread/resume', { threadId: 'persisted-thread' }), {
			thread: { id: 'persisted-thread' },
		})
		assert.equal(first.calls[0].options.cwd, paths.workspace)
		assert.equal(second.calls[0].options.cwd, paths.workspace)
		assert.equal(first.calls[0].options.env.CODEX_HOME, paths.codexHome)
		assert.equal(second.calls[0].options.env.CODEX_HOME, paths.codexHome)
		assert.equal(readFileSync(paths.configPath, 'utf8'), CODEX_APP_SERVER_CONFIG_TOML)
		secondRpc.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('lazily initializes once and reuses one child for sequential requests', async () => {
	const harness = initializeAndRespond()
	const rpc = new CodexAppServerRpc({
		spawn: harness.spawn,
		env: { CODEX_HOME: '/tmp/codex-test' },
		configOverrides: ['one=1', 'two=false'],
	})

	assert.equal(rpc.generation, 0)
	assert.deepEqual(await rpc.request('first', { value: 1 }), { ok: true })
	assert.deepEqual(await rpc.request('second', { value: 2 }), { ok: true })
	assert.equal(harness.children.length, 1)
	assert.equal(rpc.generation, 1)
	assert.equal(rpc.pid, 1)
	assert.equal(harness.children[0].unrefCalls, 1)
	assert.deepEqual(harness.calls[0].args, [
		CODEX_CLI_PATH,
		'app-server',
		'--stdio',
		'-c',
		'one=1',
		'-c',
		'two=false',
	])
	assert.equal(harness.calls[0].command, process.execPath)
	assert.deepEqual(harness.calls[0].options.env, { CODEX_HOME: '/tmp/codex-test' })
	const messages = harness.children[0].stdin.writes.map(line => JSON.parse(line))
	assert.deepEqual(messages.map(message => message.method), ['initialize', 'initialized', 'first', 'second'])
	assert.deepEqual(messages.map(message => message.id), [1, undefined, 2, 3])
	rpc.close()
})

test('routes concurrent responses by incrementing request id, even out of order', async () => {
	const requests = []
	const harness = initializeAndRespond((child, message) => requests.push({ child, message }))
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const first = rpc.request('first', { order: 1 })
	const second = rpc.request('second', { order: 2 })
	await Promise.resolve()
	assert.equal(requests.length, 2)
	respond(harness.children[0], requests[1].message.id, 'second result')
	respond(harness.children[0], requests[0].message.id, 'first result')
	assert.deepEqual(await Promise.all([first, second]), ['first result', 'second result'])
	rpc.close()
})

test('buffers fragmented JSONL and parses multiple lines from one chunk', async () => {
	const pending = deferred()
	const harness = initializeAndRespond((child, message) => {
		pending.resolve({ child, message })
	})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const result = rpc.request('fragmented', { ok: true })
	const { child, message } = await pending.promise
	const payload = `${JSON.stringify({ id: message.id, result: { parsed: true } })}\n`
	child.stdout.emit('data', payload.slice(0, 5))
	child.stdout.emit('data', payload.slice(5, -1))
	child.stdout.emit('data', `${payload.slice(-1)}${JSON.stringify({ method: 'unused', params: { ignored: true } })}\n`)
	assert.deepEqual(await result, { parsed: true })
	rpc.close()
})

test('isolates notification subscriptions and supports unsubscribe', async () => {
	const notification = deferred()
	const harness = initializeAndRespond((child, message) => {
		notification.resolve({ child, message })
	})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const alpha = []
	const beta = []
	const removeAlpha = rpc.subscribe('alpha', params => alpha.push(params))
	rpc.subscribe('beta', params => beta.push(params))
	const result = rpc.request('notify-test')
	const { child, message } = await notification.promise
	child.stdout.emit('data', [
		JSON.stringify({ method: 'alpha', params: { n: 1 } }),
		JSON.stringify({ method: 'beta', params: { n: 2 } }),
		JSON.stringify({ method: 'other', params: { n: 3 } }),
	].join('\n') + '\n')
	removeAlpha()
	child.stdout.emit('data', `${JSON.stringify({ method: 'alpha', params: { n: 4 } })}\n`)
	respond(child, message.id, 'done')
	assert.equal(await result, 'done')
	assert.deepEqual(alpha, [{ n: 1 }])
	assert.deepEqual(beta, [{ n: 2 }])
	assert.equal(rpc.unsubscribe('other', () => {}), false)
	rpc.close()
})

test('aborts a pending request and removes its AbortSignal listener', async () => {
	const harness = initializeAndRespond(() => {})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const controller = new AbortController()
	const promise = rpc.request('abort-me', {}, { signal: controller.signal, timeoutMs: 10_000 })
	await new Promise(resolve => setImmediate(resolve))
	controller.abort()
	await assert.rejects(promise, error => error.code === 'ABORTED')
	assert.equal(rpc.diagnostics.pending, 0)
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
	rpc.close()
})

test('times out one request without leaving pending state', async () => {
	const harness = initializeAndRespond(() => {})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const promise = rpc.request('timeout-me', {}, { timeoutMs: 10 })
	await assert.rejects(promise, error => error.code === 'TIMEOUT' && /timed out/.test(error.message))
	assert.equal(rpc.diagnostics.pending, 0)
	rpc.close()
})

test('initialize timeout kills the stuck child and allows a later respawn', async () => {
	const harness = fakeSpawner((child, message, generation) => {
		if (generation === 1) return
		if (message.method === 'initialize') {
			respond(child, message.id, { serverInfo: { name: 'recovered' } })
			return
		}
		if (message.method !== 'initialized') respond(child, message.id, 'recovered')
	})
	const rpc = new CodexAppServerRpc({
		spawn: harness.spawn,
		initializeTimeoutMs: 10,
	})
	const stuck = rpc.request('stuck', {}, { timeoutMs: 2_000 })
	await assert.rejects(stuck, error => error.code === 'INITIALIZE_TIMEOUT'
		&& /initialize timed out/.test(error.message))
	assert.equal(harness.children.length, 1)
	assert.deepEqual(harness.children[0].killCalls, ['SIGTERM'])
	assert.equal(rpc.pid, null)
	assert.equal(rpc.diagnostics.initialized, false)
	assert.equal(rpc.diagnostics.pending, 0)

	const recovered = rpc.request('recovered')
	assert.equal(await recovered, 'recovered')
	assert.equal(harness.children.length, 2)
	assert.equal(rpc.generation, 2)
	rpc.close()
})

test('rejects immediately when a spawned child is missing a required stream', async () => {
	for (const missing of ['stdin', 'stdout', 'stderr']) {
		const child = new EventEmitter()
		child.stdin = { write() {} }
		child.stdout = new FakeStream()
		child.stderr = new FakeStream()
		child.killCalls = []
		child.kill = signal => {
			child.killCalls.push(signal)
			return true
		}
		child[missing] = undefined
		const rpc = new CodexAppServerRpc({ spawn: () => child })
		await assert.rejects(rpc.request('missing-stream'), error => error.code === 'APP_SERVER_START'
			&& error.message.includes(missing))
		assert.deepEqual(child.killCalls, ['SIGTERM'])
		assert.equal(rpc.generation, 0)
		assert.equal(rpc.pid, null)
	}
})

test('includes stderr tail on exit, rejects pending requests, and respawns next time', async () => {
	const requests = []
	const harness = initializeAndRespond((child, message) => requests.push({ child, message }))
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const failed = rpc.request('will-crash')
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(harness.children.length, 1)
	harness.children[0].stderr.emit('data', 'first diagnostic\n')
	harness.children[0].stderr.emit('data', 'last diagnostic')
	harness.children[0].emit('exit', 17, null)
	await assert.rejects(failed, error => error.code === 'APP_SERVER_EXIT'
		&& /code 17/.test(error.message)
		&& /last diagnostic/.test(error.message))
	assert.equal(rpc.pid, null)
	assert.equal(rpc.generation, 1)

	const next = rpc.request('after-crash')
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(harness.children.length, 2)
	assert.equal(rpc.generation, 2)
	const secondRequest = requests.find(entry => entry.child === harness.children[1])
	respond(harness.children[1], secondRequest.message.id, 'recovered')
	assert.equal(await next, 'recovered')
	rpc.close()
})

test('child error rejects all pending requests and clears the connection', async () => {
	const harness = initializeAndRespond(() => {})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const first = rpc.request('first')
	const second = rpc.request('second')
	await new Promise(resolve => setImmediate(resolve))
	const cause = new Error('spawn transport failed')
	harness.children[0].stderr.emit('data', 'stderr tail')
	harness.children[0].emit('error', cause)
	await assert.rejects(first, error => error.code === 'APP_SERVER_ERROR'
		&& /spawn transport failed/.test(error.message)
		&& /stderr tail/.test(error.message))
	await assert.rejects(second, error => error.code === 'APP_SERVER_ERROR')
	assert.equal(rpc.pid, null)
	assert.equal(rpc.diagnostics.pending, 0)
	assert.deepEqual(harness.children[0].killCalls, ['SIGTERM'])
	rpc.close()
})

test('notifies crash subscribers once when an idle child exits', async () => {
	const harness = initializeAndRespond()
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const crashes = []
	rpc.subscribe('crash', error => crashes.push(error))
	assert.deepEqual(await rpc.request('completed'), { ok: true })
	const child = harness.children[0]
	child.emit('exit', 9, null)
	child.emit('close')
	assert.equal(crashes.length, 1)
	assert.ok(crashes[0] instanceof Error)
	assert.equal(crashes[0].code, 'APP_SERVER_EXIT')
	assert.equal(rpc.pid, null)
	// Closing after the crash must not report the already-detached child again.
	rpc.close()
	assert.equal(crashes.length, 1)
})

test('close rejects pending requests, kills its child, and prevents restart', async () => {
	const harness = initializeAndRespond(() => {})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const pending = rpc.request('never-answered')
	await new Promise(resolve => setImmediate(resolve))
	rpc.close()
	await assert.rejects(pending, error => error.code === 'CLOSED')
	assert.equal(rpc.closed, true)
	assert.equal(rpc.diagnostics.pending, 0)
	assert.deepEqual(harness.children[0].killCalls, ['SIGTERM'])
	await assert.rejects(rpc.request('after-close'), error => error.code === 'CLOSED')
	assert.equal(harness.children.length, 1)
})

test('close notifies active stream subscribers with a stable CLOSED error', async () => {
	const harness = initializeAndRespond((child, message) => respond(child, message.id, { started: true }))
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const crashes = []
	rpc.subscribe('crash', error => crashes.push(error))
	assert.deepEqual(await rpc.request('stream-start'), { started: true })
	rpc.close()
	assert.equal(crashes.length, 1)
	assert.ok(crashes[0] instanceof Error)
	assert.equal(crashes[0].code, 'CLOSED')
	assert.equal(crashes[0].message, 'Codex app-server client is closed.')
	assert.equal(rpc.diagnostics.pending, 0)
	rpc.close()
	assert.equal(crashes.length, 1)
})

test('answers unsupported server requests instead of leaving them pending', async () => {
	const pending = deferred()
	const harness = initializeAndRespond((child, message) => pending.resolve({ child, message }))
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const result = rpc.request('normal')
	const { child, message } = await pending.promise
	child.stdout.emit('data', `${JSON.stringify({ id: 404, method: 'server/request', params: { ask: true } })}\n`)
	const responses = child.stdin.writes.map(line => JSON.parse(line))
	const response = responses.find(item => item.id === 404)
	assert.deepEqual(response.error, {
		code: -32601,
		message: 'Method not supported',
		data: { code: 'METHOD_NOT_SUPPORTED' },
	})
	respond(child, message.id, 'normal result')
	assert.equal(await result, 'normal result')
	rpc.close()
})

test('preserves server RPC errors as rejected request errors', async () => {
	const pending = deferred()
	const harness = initializeAndRespond((child, message) => pending.resolve({ child, message }))
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const result = rpc.request('rejected')
	const { child, message } = await pending.promise
	rejectRpc(child, message.id, 4001, 'not available')
	await assert.rejects(result, error => error.code === 4001
		&& /not available/.test(error.message)
		&& error.rpcError.code === 4001)
	rpc.close()
})

test('a synchronous stdin EPIPE fails the child and respawns the next request', async () => {
	let harness
	harness = initializeAndRespond((child, message) => {
		if (child === harness.children[0] && message.method === 'write-fails') {
			throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
		}
		respond(child, message.id, 'recovered')
	})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	await assert.rejects(rpc.request('write-fails'), error => error.code === 'APP_SERVER_ERROR'
		&& error.cause?.code === 'EPIPE')
	assert.deepEqual(harness.children[0].killCalls, ['SIGTERM'])
	assert.equal(rpc.pid, null)
	assert.equal(await rpc.request('after-write-failure'), 'recovered')
	assert.equal(harness.children.length, 2)
	assert.equal(rpc.generation, 2)
	rpc.close()
})

test('malformed JSONL immediately fails the generation instead of waiting for request timeout', async () => {
	const harness = initializeAndRespond(() => {})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const pending = rpc.request('malformed')
	await new Promise(resolve => setImmediate(resolve))
	harness.children[0].stdout.emit('data', '{not-json}\n')
	await assert.rejects(pending, error => error.code === 'APP_SERVER_ERROR'
		&& /malformed JSONL/.test(error.message))
	assert.deepEqual(harness.children[0].killCalls, ['SIGTERM'])
	assert.equal(rpc.pid, null)
	rpc.close()
})

test('bounds an unterminated JSONL frame and fails stdout/stderr stream errors', async () => {
	const harness = initializeAndRespond(() => {})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const pending = rpc.request('oversized-frame')
	await new Promise(resolve => setImmediate(resolve))
	harness.children[0].stdout.emit('data', 'x'.repeat(4 * 1024 * 1024 + 1))
	await assert.rejects(pending, error => error.code === 'APP_SERVER_ERROR'
		&& /buffer limit/.test(error.message))
	rpc.close()

	for (const stream of ['stdout', 'stderr']) {
		const streamHarness = initializeAndRespond(() => {})
		const streamRpc = new CodexAppServerRpc({ spawn: streamHarness.spawn })
		const streamPending = streamRpc.request(`stream-${stream}-error`)
		await new Promise(resolve => setImmediate(resolve))
		streamHarness.children[0][stream].emit('error', new Error(`${stream} failed`))
		await assert.rejects(streamPending, error => error.code === 'APP_SERVER_ERROR'
			&& error.message.includes(`${stream} failed`))
		assert.deepEqual(streamHarness.children[0].killCalls, ['SIGTERM'])
		streamRpc.close()
	}
})

test('adapter local timeout leaves no wire request or abort listener after bounded cleanup', async () => {
	const harness = initializeAndRespond((child, message) => {
		if (message.method === 'thread/start') respond(child, message.id, { thread: { id: 'thread-cleanup' } })
		if (message.method === 'thread/unsubscribe') respond(child, message.id, {})
		// Deliberately leave turn/start unanswered. The adapter must return on
		// its local timeout, then the bounded wire timeout must clear the RPC.
	})
	const rpc = new CodexAppServerRpc({ spawn: harness.spawn })
	const client = new CodexAppServerClient({ rpc })
	const thread = client.startThread({ model: 'gpt-5.6-sol' })
	const controller = new AbortController()
	const streamed = await thread.runStreamed('never answered', {
		signal: controller.signal,
		timeoutMs: 5,
		wireTimeoutMs: 20,
	})
	const pending = streamed.events.next()
	await assert.rejects(pending, error => error.code === 'TIMEOUT')
	assert.equal(rpc.diagnostics.pending, 1)
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
	await new Promise(resolve => setTimeout(resolve, 40))
	assert.equal(rpc.diagnostics.pending, 0)
	assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
	await client.close()
})

assert.deepEqual(CODEX_APP_SERVER_CONFIG_OVERRIDES, [
	'forced_login_method="chatgpt"',
	'model_provider="openai"',
	'enable_request_compression=false',
])

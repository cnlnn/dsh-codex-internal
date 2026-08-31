import { spawn as nodeSpawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The CLI entry point used by the installed official Codex package. */
export const CODEX_CLI_PATH = require.resolve('@openai/codex/bin/codex.js')

/**
 * Keep an app-server instance independent from global Codex routers. These
 * values are passed as separate `-c` arguments to the CLI.
 */
export const CODEX_APP_SERVER_CONFIG_OVERRIDES = Object.freeze([
	'forced_login_method="chatgpt"',
	'model_provider="openai"',
	'enable_request_compression=false',
])

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000
const STDERR_TAIL_LIMIT = 4_000
// Keep an incomplete JSONL frame bounded so a broken child cannot grow the
// transport's memory without ever emitting a newline.
const MAX_JSONL_BUFFER = 4 * 1024 * 1024
const DEFAULT_INITIALIZE_PARAMS = Object.freeze({
	clientInfo: Object.freeze({ name: 'dsh-codex-app-server', version: '0.1.0' }),
	capabilities: Object.freeze({ experimentalApi: true }),
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
	'LOCALAPPDATA',
	'LOGNAME',
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

/** Return only values needed by the official Codex CLI process. */
export function sanitizedEnvironment(source = process.env) {
	return Object.fromEntries(
		Object.entries(source).filter(([key, value]) => SAFE_ENV_KEYS.has(key.toUpperCase()) && value !== undefined),
	)
}

/**
 * Error raised by the small JSON-RPC transport. `code` is intentionally a
 * stable string so callers can distinguish lifecycle errors from RPC errors.
 */
export class CodexAppServerRpcError extends Error {
	constructor(message, code = 'CODEX_APP_SERVER', options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause })
		this.name = 'CodexAppServerRpcError'
		this.code = code
		if (options.rpcError !== undefined) this.rpcError = options.rpcError
		if (options.method !== undefined) this.method = options.method
		if (options.stderrTail !== undefined) this.stderrTail = options.stderrTail
	}
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error)
}

function hasEventMethod(value, name) {
	return value !== null && typeof value === 'object' && typeof value[name] === 'function'
}

function appendStderr(tail, chunk) {
	return `${tail}${String(chunk)}`.slice(-STDERR_TAIL_LIMIT)
}

function isFiniteTimeout(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function rpcErrorMessage(error) {
	if (error === null || typeof error !== 'object') return String(error)
	if (typeof error.message === 'string' && error.message.length > 0) return error.message
	if (typeof error.code === 'string' || typeof error.code === 'number') return `error ${String(error.code)}`
	return 'unknown error'
}

/**
 * Persistent JSONL JSON-RPC client for `codex app-server --stdio`.
 *
 * The process is started on the first request and reused until it exits or
 * `close()` is called. A fresh process performs its own initialize handshake.
 */
export class CodexAppServerRpc {
	#spawn
	#cliPath
	#args
	#configOverrides
	#env
	#spawnOptions
	#initializeParams
	#initializeTimeoutMs
	#child = null
	#generation = 0
	#nextId = 1
	#initialized = false
	#initializeId = null
	#buffer = ''
	#stderrTail = ''
	#initializeTimer = null
	#pending = new Map()
	#notificationHandlers = new Map()
	#closed = false
	#closeFailure = null
	#childListeners = new Map()

	constructor(options = {}) {
		if (typeof options === 'function') options = { spawn: options }
		if (options === null || typeof options !== 'object') {
			throw new TypeError('CodexAppServerRpc options must be an object')
		}

		this.#spawn = options.spawn ?? options.spawnProcess ?? nodeSpawn
		if (typeof this.#spawn !== 'function') throw new TypeError('spawn must be a function')
		this.#cliPath = options.cliPath ?? options.codexCliPath ?? CODEX_CLI_PATH
		this.#args = options.args ?? options.cliArgs ?? options.appServerArgs ?? ['app-server', '--stdio']
		if (!Array.isArray(this.#args)) throw new TypeError('args must be an array')
		this.#configOverrides = options.configOverrides ?? options.overrides ?? CODEX_APP_SERVER_CONFIG_OVERRIDES
		if (!Array.isArray(this.#configOverrides)) throw new TypeError('configOverrides must be an array')
		this.#env = options.env === undefined ? sanitizedEnvironment() : options.env
		this.#spawnOptions = options.spawnOptions ?? {}
		this.#initializeParams = options.initializeParams ?? DEFAULT_INITIALIZE_PARAMS
		this.#initializeTimeoutMs = options.initializeTimeoutMs === undefined
			? DEFAULT_INITIALIZE_TIMEOUT_MS
			: options.initializeTimeoutMs
	}

	/** Number of app-server generations successfully spawned by this client. */
	get generation() {
		return this.#generation
	}

	/** PID of the currently connected child, or `null` when disconnected. */
	get pid() {
		return this.#child?.pid ?? null
	}

	/** Tail of stderr from the current (or most recently connected) child. */
	get stderrTail() {
		return this.#stderrTail
	}

	/** Whether `close()` has permanently closed this client. */
	get closed() {
		return this.#closed
	}

	/** Read-only diagnostic snapshot for adapters and tests. */
	get diagnostics() {
		return Object.freeze({
			generation: this.#generation,
			pid: this.pid,
			initialized: this.#initialized,
			pending: this.#pending.size,
			stderrTail: this.#stderrTail,
			closed: this.#closed,
		})
	}

	/** Register a handler for one server notification method. */
	subscribe(method, callback) {
		if (typeof method !== 'string' || method.length === 0) throw new TypeError('notification method must be a non-empty string')
		if (typeof callback !== 'function') throw new TypeError('notification callback must be a function')
		let handlers = this.#notificationHandlers.get(method)
		if (handlers === undefined) {
			handlers = new Set()
			this.#notificationHandlers.set(method, handlers)
		}
		handlers.add(callback)
		return () => this.unsubscribe(method, callback)
	}

	/** Remove one handler, or all handlers for a method when callback is omitted. */
	unsubscribe(method, callback) {
		const handlers = this.#notificationHandlers.get(method)
		if (handlers === undefined) return false
		const removed = callback === undefined
			? handlers.size > 0
			: handlers.delete(callback)
		if (callback === undefined) handlers.clear()
		if (handlers.size === 0) this.#notificationHandlers.delete(method)
		return removed
	}

	/** EventEmitter-style aliases for callers that prefer `on`/`off`. */
	on(method, callback) {
		return this.subscribe(method, callback)
	}

	off(method, callback) {
		return this.unsubscribe(method, callback)
	}

	/**
	 * Send one JSON-RPC request. Requests made during initialization are queued
	 * and flushed in insertion order after the initialized notification.
	 */
	request(method, params = {}, options = {}) {
		return new Promise((resolve, reject) => {
			if (typeof method !== 'string' || method.length === 0) {
				reject(new TypeError('RPC method must be a non-empty string'))
				return
			}
			if (options === null || typeof options !== 'object') {
				reject(new TypeError('RPC request options must be an object'))
				return
			}
			const signal = options.signal
			if (signal?.aborted === true) {
				reject(this.#abortedError(method))
				return
			}
			if (this.#closed) {
				reject(this.#closedError())
				return
			}

			if (options.allowRestart === false && this.#child === null) {
				reject(new CodexAppServerRpcError(
					'Codex app-server is disconnected.',
					'APP_SERVER_DISCONNECTED',
					{ method },
				))
				return
			}

			try {
				this.#ensureChild()
			} catch (error) {
				reject(error)
				return
			}

			const id = this.#nextId++
			const record = {
				id,
				method,
				params,
				resolve,
				reject,
				signal,
				abortListener: null,
				timer: null,
				sent: false,
			}
			this.#pending.set(id, record)

			if (signal !== undefined && hasEventMethod(signal, 'addEventListener')) {
				record.abortListener = () => this.#abortPending(record)
				signal.addEventListener('abort', record.abortListener, { once: true })
			}

			const timeoutMs = options.timeoutMs === undefined
				? DEFAULT_TIMEOUT_MS
				: options.timeoutMs
			if (isFiniteTimeout(timeoutMs)) {
				record.timer = setTimeout(() => this.#timeoutPending(record), timeoutMs)
				if (typeof record.timer.unref === 'function') record.timer.unref()
			}

			if (this.#initialized) this.#sendPending(record)
		})
	}

	/** Permanently close this client and kill only its currently owned child. */
	close() {
		if (this.#closed) return
		this.#closed = true
		const child = this.#child
		const error = this.#closedError()
		this.#child = null
		this.#initialized = false
		this.#initializeId = null
		this.#buffer = ''
		this.#clearInitializeTimer()
		this.#rejectAll(error)
		if (child !== null) this.#notify('crash', error)
		if (child !== null) {
			this.#detachChild(child)
			this.#killChild(child)
		}
	}

	#ensureChild() {
		if (this.#closed) throw this.#closedError()
		if (this.#child !== null) return this.#child

		const args = [this.#cliPath, ...this.#args]
		for (const override of this.#configOverrides) args.push('-c', override)
		const spawnOptions = {
			...this.#spawnOptions,
			env: typeof this.#env === 'function' ? this.#env() : this.#env,
			stdio: ['pipe', 'pipe', 'pipe'],
		}
		let child
		try {
			child = this.#spawn(process.execPath, args, spawnOptions)
		} catch (error) {
			throw new CodexAppServerRpcError(
				`Unable to start Codex app-server: ${messageOf(error)}`,
				'APP_SERVER_START',
				{ cause: error },
			)
		}
		if (child === null || typeof child !== 'object') {
			throw new CodexAppServerRpcError('Unable to start Codex app-server: spawn returned no child.', 'APP_SERVER_START')
		}
		const missing = []
		if (typeof child.on !== 'function') missing.push('child events')
		if (child.stdin === undefined || child.stdin === null || typeof child.stdin.write !== 'function') missing.push('stdin')
		if (child.stdout === undefined || child.stdout === null || typeof child.stdout.on !== 'function') missing.push('stdout')
		if (child.stderr === undefined || child.stderr === null || typeof child.stderr.on !== 'function') missing.push('stderr')
		if (missing.length > 0) {
			const failure = new CodexAppServerRpcError(
				`Unable to start Codex app-server: child is missing ${missing.join(', ')}.`,
				'APP_SERVER_START',
			)
			this.#killChild(child)
			throw failure
		}

		this.#child = child
		this.#generation += 1
		this.#initialized = false
		this.#initializeId = this.#nextId++
		this.#buffer = ''
		this.#stderrTail = ''
		this.#attachChild(child)
		this.#startInitializeTimer(child)
		try {
			this.#write({ id: this.#initializeId, method: 'initialize', params: this.#initializeParams }, child)
		} catch (error) {
			const failure = error instanceof CodexAppServerRpcError
				? error
				: new CodexAppServerRpcError(
					`Unable to write Codex initialize request: ${messageOf(error)}`,
					'APP_SERVER_ERROR',
					{ cause: error },
				)
			this.#failChild(failure, child, true)
			throw failure
		}
		if (this.#child !== child) {
			throw new CodexAppServerRpcError('Codex app-server failed during initialization.', 'APP_SERVER_ERROR')
		}
		return child
	}

	#attachChild(child) {
		const onError = error => {
			if (this.#child !== child) return
			const tail = this.#stderrTail.trim()
			const suffix = tail.length > 0 ? ` ${tail}` : ''
			this.#failChild(new CodexAppServerRpcError(
				`Unable to start Codex app-server: ${messageOf(error)}${suffix}`,
				'APP_SERVER_ERROR',
				{ cause: error, stderrTail: tail },
			), child, true)
		}
		const onExit = (code, signal) => {
			if (this.#child !== child) return
			const tail = this.#stderrTail.trim()
			const detail = signal === undefined || signal === null
				? `code ${String(code)}`
				: `signal ${String(signal)}`
			const suffix = tail.length > 0 ? ` ${tail}` : ''
			this.#failChild(new CodexAppServerRpcError(
				`Codex app-server exited with ${detail}.${suffix}`,
				'APP_SERVER_EXIT',
				{ stderrTail: tail },
			), child)
		}
		const onClose = () => {
			if (this.#child !== child) return
			const tail = this.#stderrTail.trim()
			this.#failChild(new CodexAppServerRpcError(
				`Codex app-server closed.${tail.length > 0 ? ` ${tail}` : ''}`,
				'APP_SERVER_EXIT',
				{ stderrTail: tail },
			), child)
		}
		const onStdout = chunk => this.#consumeStdout(child, chunk)
		const onStdoutEnd = () => {
			if (this.#child === child) this.#consumeStdout(child, '')
		}
		const onStdoutError = error => {
			if (this.#child !== child) return
			this.#failChild(new CodexAppServerRpcError(
				`Codex app-server stdout failed: ${messageOf(error)}`,
				'APP_SERVER_ERROR',
				{ cause: error },
			), child, true)
		}
		const onStderr = chunk => {
			if (this.#child === child) this.#stderrTail = appendStderr(this.#stderrTail, chunk)
		}
		const onStderrError = error => {
			if (this.#child !== child) return
			const tail = this.#stderrTail.trim()
			this.#failChild(new CodexAppServerRpcError(
				`Codex app-server stderr failed: ${messageOf(error)}${tail.length > 0 ? ` ${tail}` : ''}`,
				'APP_SERVER_ERROR',
				{ cause: error, stderrTail: tail },
			), child, true)
		}
		const onStdinError = error => {
			if (this.#child !== child) return
			this.#failChild(new CodexAppServerRpcError(
				`Codex app-server stdin failed: ${messageOf(error)}`,
				'APP_SERVER_ERROR',
				{ cause: error },
			), child, true)
		}

		this.#childListeners.set(child, {
			onError,
			onExit,
			onClose,
			onStdout,
			onStdoutEnd,
			onStdoutError,
			onStderr,
			onStderrError,
			onStdinError,
		})
		if (hasEventMethod(child, 'on')) {
			child.on('error', onError)
			child.on('exit', onExit)
			child.on('close', onClose)
		}
		const stdout = child.stdout
		if (stdout !== undefined && stdout !== null && hasEventMethod(stdout, 'on')) {
			if (typeof stdout.setEncoding === 'function') stdout.setEncoding('utf8')
			stdout.on('data', onStdout)
			stdout.on('error', onStdoutError)
			stdout.on('end', onStdoutEnd)
		}
		const stderr = child.stderr
		if (stderr !== undefined && stderr !== null && hasEventMethod(stderr, 'on')) {
			if (typeof stderr.setEncoding === 'function') stderr.setEncoding('utf8')
			stderr.on('data', onStderr)
			stderr.on('error', onStderrError)
		}
		const stdin = child.stdin
		if (stdin !== undefined && stdin !== null && hasEventMethod(stdin, 'on')) stdin.on('error', onStdinError)
		if (typeof child.unref === 'function') child.unref()
	}

	#detachChild(child) {
		const listeners = this.#childListeners.get(child)
		this.#childListeners.delete(child)
		if (listeners === undefined) return
		if (hasEventMethod(child, 'removeListener')) {
			child.removeListener('error', listeners.onError)
			child.removeListener('exit', listeners.onExit)
			child.removeListener('close', listeners.onClose)
		}
		if (child.stdout !== undefined && child.stdout !== null && hasEventMethod(child.stdout, 'removeListener')) {
			child.stdout.removeListener('data', listeners.onStdout)
			child.stdout.removeListener('error', listeners.onStdoutError)
			child.stdout.removeListener('end', listeners.onStdoutEnd)
		}
		if (child.stderr !== undefined && child.stderr !== null && hasEventMethod(child.stderr, 'removeListener')) {
			child.stderr.removeListener('data', listeners.onStderr)
			child.stderr.removeListener('error', listeners.onStderrError)
		}
		if (child.stdin !== undefined && child.stdin !== null && hasEventMethod(child.stdin, 'removeListener')) {
			child.stdin.removeListener('error', listeners.onStdinError)
		}
	}

	#consumeStdout(child, chunk) {
		if (this.#child !== child) return
		this.#buffer += String(chunk)
		while (true) {
			const newline = this.#buffer.indexOf('\n')
			if (newline < 0) {
				if (this.#buffer.length > MAX_JSONL_BUFFER) {
					this.#failChild(new CodexAppServerRpcError(
						'Codex app-server emitted a JSONL line exceeding the transport buffer limit.',
						'APP_SERVER_ERROR',
					), child, true)
					return
				}
				break
			}
			if (newline > MAX_JSONL_BUFFER) {
				this.#failChild(new CodexAppServerRpcError(
					'Codex app-server emitted a JSONL line exceeding the transport buffer limit.',
					'APP_SERVER_ERROR',
				), child, true)
				return
			}
			const line = this.#buffer.slice(0, newline).trim()
			this.#buffer = this.#buffer.slice(newline + 1)
			if (line.length === 0) continue
			this.#consumeLine(child, line)
			if (this.#child !== child) return
		}
		// A cleanly ended stream can contain one final JSON line without \n.
		if (chunk === '' && this.#buffer.trim().length > 0) {
			const line = this.#buffer.trim()
			this.#buffer = ''
			this.#consumeLine(child, line)
		}
	}

	#consumeLine(child, line) {
		let message
		try {
			message = JSON.parse(line)
		} catch (cause) {
			this.#failChild(new CodexAppServerRpcError(
				`Codex app-server emitted malformed JSONL: ${messageOf(cause)}`,
				'APP_SERVER_ERROR',
				{ cause },
			), child, true)
			return
		}
		if (message === null || typeof message !== 'object' || Array.isArray(message)) {
			this.#failChild(new CodexAppServerRpcError(
				'Codex app-server emitted a non-object JSONL frame.',
				'APP_SERVER_ERROR',
			), child, true)
			return
		}
		if ((message.id === undefined && message.method === undefined)
			|| (message.method !== undefined && typeof message.method !== 'string')) {
			this.#failChild(new CodexAppServerRpcError(
				'Codex app-server emitted an invalid JSON-RPC frame.',
				'APP_SERVER_ERROR',
			), child, true)
			return
		}

		if (message.id !== undefined && message.id === this.#initializeId && this.#initialized === false) {
			if (message.error !== undefined) {
				const error = this.#rpcFailure('initialize', message.error)
				this.#failChild(error, child, true)
				return
			}
			this.#clearInitializeTimer()
			this.#initialized = true
			this.#initializeId = null
			try {
				this.#write({ method: 'initialized', params: {} }, child)
			} catch (error) {
				this.#failChild(error instanceof CodexAppServerRpcError
					? error
					: new CodexAppServerRpcError(
						`Unable to write Codex initialized notification: ${messageOf(error)}`,
						'APP_SERVER_ERROR',
						{ cause: error },
					), child, true)
				return
			}
			this.#flushPending()
			return
		}

		if (message.method !== undefined) {
			if (message.id !== undefined) this.#respondMethodNotSupported(child, message.id)
			else this.#notify(String(message.method), message.params)
			return
		}

		if (message.id === undefined) return
		const record = this.#pending.get(message.id)
		if (record === undefined) return
		this.#pending.delete(message.id)
		this.#cleanupRecord(record)
		if (message.error !== undefined) {
			record.reject(this.#rpcFailure(record.method, message.error))
		} else {
			record.resolve(message.result)
		}
	}

	#flushPending() {
		for (const record of this.#pending.values()) {
			if (this.#child === null || this.#initialized === false) break
			if (!record.sent) this.#sendPending(record)
		}
	}

	#sendPending(record) {
		if (!this.#pending.has(record.id) || record.sent || this.#child === null || this.#initialized === false) return
		record.sent = true
		const child = this.#child
		try {
			this.#write({ id: record.id, method: record.method, params: record.params }, child)
		} catch (error) {
			const failure = error instanceof CodexAppServerRpcError
				? error
				: new CodexAppServerRpcError(
					`Unable to write Codex ${record.method} request: ${messageOf(error)}`,
					'APP_SERVER_ERROR',
					{ cause: error },
				)
			this.#failChild(failure, child, true)
		}
	}

	#write(message, child = this.#child) {
		if (child === null || child?.stdin === undefined || child.stdin === null || typeof child.stdin.write !== 'function') {
			throw new CodexAppServerRpcError('Codex app-server stdin is unavailable.', 'APP_SERVER_ERROR')
		}
		child.stdin.write(`${JSON.stringify(message)}\n`)
	}

	#respondMethodNotSupported(child, id) {
		try {
			this.#write({
				id,
				error: {
					code: -32601,
					message: 'Method not supported',
					data: { code: 'METHOD_NOT_SUPPORTED' },
				},
			}, child)
		} catch (error) {
			const failure = error instanceof CodexAppServerRpcError
				? error
				: new CodexAppServerRpcError(
					`Unable to write Codex app-server error response: ${messageOf(error)}`,
					'APP_SERVER_ERROR',
					{ cause: error },
				)
			this.#failChild(failure, child, true)
		}
	}

	#notify(method, params) {
		const handlers = this.#notificationHandlers.get(method)
		if (handlers === undefined) return
		for (const callback of [...handlers]) {
			try {
				callback(params)
			} catch {
				// Notification consumers must not be able to break JSONL processing.
			}
		}
	}

	#rpcFailure(method, rpcError) {
		const detail = rpcErrorMessage(rpcError)
		const code = rpcError !== null && typeof rpcError === 'object' && rpcError.code !== undefined
			? rpcError.code
			: 'RPC_ERROR'
		return new CodexAppServerRpcError(
			`Codex app-server rejected ${method}: ${detail}`,
			code,
			{ rpcError, method },
		)
	}

	#abortPending(record) {
		if (!this.#pending.delete(record.id)) return
		this.#cleanupRecord(record)
		record.reject(this.#abortedError(record.method))
	}

	#timeoutPending(record) {
		if (!this.#pending.delete(record.id)) return
		this.#cleanupRecord(record)
		record.reject(new CodexAppServerRpcError(
			`Codex ${record.method} request timed out.`,
			'TIMEOUT',
			{ method: record.method },
		))
	}

	#cleanupRecord(record) {
		if (record.timer !== null) clearTimeout(record.timer)
		record.timer = null
		if (record.signal !== undefined
			&& record.abortListener !== null
			&& hasEventMethod(record.signal, 'removeEventListener')) {
			record.signal.removeEventListener('abort', record.abortListener)
		}
		record.abortListener = null
	}

	#startInitializeTimer(child) {
		if (!isFiniteTimeout(this.#initializeTimeoutMs)) return
		this.#initializeTimer = setTimeout(() => {
			if (this.#child !== child || this.#initialized || this.#initializeId === null) return
			const tail = this.#stderrTail.trim()
			const suffix = tail.length > 0 ? ` ${tail}` : ''
			this.#failChild(new CodexAppServerRpcError(
				`Codex app-server initialize timed out.${suffix}`,
				'INITIALIZE_TIMEOUT',
				{ stderrTail: tail },
			), child, true)
		}, this.#initializeTimeoutMs)
		if (typeof this.#initializeTimer.unref === 'function') this.#initializeTimer.unref()
	}

	#clearInitializeTimer() {
		if (this.#initializeTimer !== null) clearTimeout(this.#initializeTimer)
		this.#initializeTimer = null
	}

	#rejectAll(error) {
		for (const record of this.#pending.values()) {
			this.#cleanupRecord(record)
			record.reject(error)
		}
		this.#pending.clear()
	}

	#failChild(error, child, kill = false) {
		if (this.#child !== child) return
		this.#child = null
		this.#initialized = false
		this.#initializeId = null
		this.#buffer = ''
		this.#clearInitializeTimer()
		this.#stderrTail = error.stderrTail ?? this.#stderrTail
		this.#detachChild(child)
		this.#rejectAll(error)
		// A streaming turn may no longer have an outstanding RPC request after
		// `turn/start` resolves. Notify subscribers so they can terminate that
		// turn immediately when the owned app-server crashes.
		this.#notify('crash', error)
		if (kill) this.#killChild(child)
	}

	#killChild(child) {
		if (child === null || typeof child.kill !== 'function') return
		try {
			child.kill('SIGTERM')
		} catch {
			// The process may have exited between detaching and kill().
		}
	}

	#abortedError(method) {
		return new CodexAppServerRpcError(`Codex ${method} request was aborted.`, 'ABORTED', { method })
	}

	#closedError() {
		if (this.#closeFailure === null) {
			this.#closeFailure = new CodexAppServerRpcError('Codex app-server client is closed.', 'CLOSED')
		}
		return this.#closeFailure
	}
}

export default CodexAppServerRpc

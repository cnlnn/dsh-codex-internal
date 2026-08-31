import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The CLI entry point used by the installed official Codex package. */
export const CODEX_CLI_PATH = require.resolve('@openai/codex/bin/codex.js')

/** Version advertised to the official app-server during its initialize turn. */
export const CODEX_ADAPTER_VERSION = '0.8.3'

/** Stable names owned by this plugin below the DSH home. */
export const CODEX_ADAPTER_HOME_NAME = 'codex-adapter'
export const CODEX_ADAPTER_WORKSPACE_NAME = 'workspace'
export const CODEX_ADAPTER_CONFIG_NAME = 'config.toml'

/** Expand only the current user's home shorthand, including Windows `~\\x`. */
export function expandHomePath(value, home = homedir()) {
	const path = typeof value === 'string' ? value.trim() : ''
	if (path === '~') return home
	if (/^~[\\/]/.test(path)) {
		const suffix = path.slice(1).replace(/^[\\/]+/, '')
		if (suffix.length === 0) return home
		return join(home, ...suffix.split(/[\\/]+/).filter(Boolean))
	}
	return path
}

/**
 * Keep the official runtime in a private home. We intentionally do not use an
 * ambient CODEX_HOME: that home can contain user MCPs, plugins, hooks, and
 * model instructions, all of which are outside the DSH plugin boundary.
 */
export function resolveCodexRuntimePaths(options = {}) {
	const env = options?.env ?? process.env
	const home = options?.homeDir ?? options?.home ?? homedir()
	const configuredDshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
		? expandHomePath(env.DSH_HOME, home)
		: join(home, '.dsh')
	const dshHome = resolve(configuredDshHome)
	const codexHome = join(dshHome, CODEX_ADAPTER_HOME_NAME)
	return Object.freeze({
		dshHome,
		codexHome,
		workspace: join(codexHome, CODEX_ADAPTER_WORKSPACE_NAME),
		configPath: join(codexHome, CODEX_ADAPTER_CONFIG_NAME),
	})
}

/**
 * This is deliberately a small, fixed config. Keep all root keys above the
 * `[features]` table: Codex's TOML parser treats subsequent keys as table
 * members. Empty MCP/plugin sections are omitted rather than relying on the
 * CLI's non-deleting recursive `-c` merge semantics.
 */
export const CODEX_APP_SERVER_CONFIG_TOML = [
	'forced_login_method = "chatgpt"',
	'model_provider = "openai"',
	'enable_request_compression = false',
	'cli_auth_credentials_store = "file"',
	'include_apps_instructions = false',
	'include_collaboration_mode_instructions = false',
	'include_permissions_instructions = false',
	'include_environment_context = false',
	'',
	'[features]',
	'apps = false',
	'enable_mcp_apps = false',
	'plugins = false',
	'plugin_hooks = false',
	'hooks = false',
	'memories = false',
	'memory_tool = false',
	'shell_tool = false',
	'unified_exec = false',
	'experimental_use_unified_exec_tool = false',
	'view_image = false',
	'multi_agent = false',
	'multi_agent_mode = false',
	'multi_agent_v2 = false',
	'collab = false',
	'collaboration_modes = false',
	'deferred_executor = false',
	'request_permissions_tool = false',
	'token_budget = false',
	'current_time_reminder = false',
	'tool_suggest = false',
	'standalone_web_search = false',
	'web_search = false',
	'web_search_cached = false',
	'web_search_request = false',
	'search_tool = false',
	'tool_search = false',
	'browser_use = false',
	'browser_use_external = false',
	'browser_use_full_cdp_access = false',
	'computer_use = false',
	'in_app_browser = false',
	'in_app_local_automation = false',
	'image_generation = false',
	'code_mode = false',
	'code_mode_only = false',
	'code_mode_host = false',
	'connectors = false',
	'remote_control = false',
	'remote_models = false',
	'remote_plugin = false',
	'recommended_plugins = false',
	'plugin_sharing = false',
	'',
	'[tools.update_plan]',
	'enabled = false',
	'',
	'[tools.experimental_request_user_input]',
	'enabled = false',
	'',
].join('\n')

function runWindowsCommand(command, args, options = {}) {
	let result
	try {
		result = nodeSpawnSync(command, args, {
			encoding: 'utf8',
			env: options.env ?? sanitizedEnvironment(),
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			timeout: 10_000,
		})
	} catch (error) {
		throw new Error(`Windows ${command} failed to start: ${error instanceof Error ? error.message : String(error)}`)
	}
	if (result.error !== undefined) {
		throw new Error(`Windows ${command} failed: ${result.error.message}`)
	}
	if (result.status !== 0) {
		const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim()
		throw new Error(`Windows ${command} failed with status ${String(result.status)}${detail.length > 0 ? `: ${detail}` : ''}`)
	}
	return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function windowsUserSid(runCommand) {
	const output = runCommand('whoami.exe', ['/user'])
	const match = String(output).match(/\bS-\d-(?:\d+-)+\d+\b/i)
	if (match === null) throw new Error('Windows whoami did not return a user SID')
	return match[0]
}

const WINDOWS_FULL_CONTROL = 0x1f01ff
const WINDOWS_CONTAINER_INHERIT = 0x1
const WINDOWS_OBJECT_INHERIT = 0x2

function windowsAclCacheKey(directory) {
	const key = resolve(directory)
	return process.platform === 'win32' ? key.toLowerCase() : key
}

function windowsDirectoryIdentity(directory) {
	const stat = lstatSync(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Codex adapter path is not a private directory: ${directory}`)
	}
	return Object.freeze({
		dev: stat.dev,
		ino: stat.ino,
		birthtimeMs: stat.birthtimeMs,
	})
}

function sameWindowsDirectoryIdentity(left, right) {
	return left !== undefined && right !== undefined
		&& left.dev === right.dev
		&& left.ino === right.ino
		&& left.birthtimeMs === right.birthtimeMs
}

function windowsAclDiagnostic(snapshot, userSid) {
	const hasRules = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.Rules)
	const rules = hasRules ? snapshot.Rules : []
	const rule = rules[0]
	const sid = String(userSid)
	const numeric = value => {
		const number = Number(value)
		return Number.isSafeInteger(number) ? String(number) : 'invalid'
	}
	return [
		`Protected=${snapshot?.Protected === true}`,
		`Rules=${hasRules ? String(rules.length) : 'invalid'}`,
		`Type=${rule?.Type === 'Allow' ? 'Allow' : 'other'}`,
		`Rights=${numeric(rule?.Rights)}`,
		`Inheritance=${numeric(rule?.Inheritance)}`,
		`Propagation=${numeric(rule?.Propagation)}`,
		`Inherited=${rule?.Inherited === true}`,
		`SidMatches=${rule?.Sid === sid}`,
	].join(' ')
}

/** Validate the one-rule ACL snapshot emitted by the Windows verifier. */
export function validateWindowsAclSnapshot(snapshot, userSid) {
	const sid = String(userSid)
	if (!/^S-\d-(?:\d+-)+\d+$/i.test(sid)
		|| snapshot === null || typeof snapshot !== 'object'
		|| snapshot.Protected !== true || !Array.isArray(snapshot.Rules)
		|| snapshot.Rules.length !== 1) {
		throw new Error(`Windows ACL is not a protected owner-only DACL (${windowsAclDiagnostic(snapshot, sid)})`)
	}
	const [rule] = snapshot.Rules
	const rights = Number(rule?.Rights)
	const inheritance = Number(rule?.Inheritance)
	if (rule?.Sid !== sid
		|| rule?.Type !== 'Allow'
		|| rule?.Inherited !== false
		|| !Number.isSafeInteger(rights)
		|| (rights & WINDOWS_FULL_CONTROL) !== WINDOWS_FULL_CONTROL
		|| inheritance !== (WINDOWS_CONTAINER_INHERIT | WINDOWS_OBJECT_INHERIT)
		|| Number(rule?.Propagation) !== 0) {
		throw new Error(`Windows ACL owner rule is incomplete or contains an unexpected access rule (${windowsAclDiagnostic(snapshot, sid)})`)
	}
}

function windowsSddlFlags(value) {
	const flags = []
	let remaining = value
	const tokens = ['OI', 'CI', 'IO', 'NP', 'ID', 'SA', 'FA', 'TP', 'TL', 'I']
	while (remaining.length > 0) {
		const token = tokens.find(candidate => remaining.startsWith(candidate))
		if (token === undefined) return null
		flags.push(token)
		remaining = remaining.slice(token.length)
	}
	return flags
}

function windowsSddlRights(value) {
	if (value === 'FA' || value === 'GA') return WINDOWS_FULL_CONTROL
	const match = String(value).match(/^0x([0-9a-f]+)$/i)
	if (match === null) return 0
	const rights = Number.parseInt(match[1], 16)
	return Number.isSafeInteger(rights) ? rights : 0
}

/** Convert the machine-readable SDDL emitted by `icacls /save`. */
export function parseWindowsAclSddl(contents) {
	const text = String(contents)
	// The ACL file starts with the target path, which may itself use a `D:`
	// drive prefix. A real SDDL DACL marker is followed by control flags and an
	// ACE, never by the drive separator.
	const daclMarker = /D:(?=[A-Z]*\()/i.exec(text)
	if (daclMarker === null) throw new Error('Windows ACL verification returned no DACL')
	const daclStart = daclMarker.index
	const daclWithSacl = text.slice(daclStart + 2)
	const saclStart = daclWithSacl.indexOf('S:')
	const dacl = saclStart < 0 ? daclWithSacl : daclWithSacl.slice(0, saclStart)
	const firstAce = dacl.indexOf('(')
	if (firstAce < 0) throw new Error('Windows ACL verification returned no DACL rules')
	const controlFlags = dacl.slice(0, firstAce)
	const rules = [...dacl.slice(firstAce).matchAll(/\(([^()]*)\)/g)].map(match => {
		const fields = match[1].split(';')
		if (fields.length !== 6) throw new Error('Windows ACL verification returned a malformed ACE')
		const flags = windowsSddlFlags(fields[1])
		if (flags === null) throw new Error('Windows ACL verification returned unknown ACE flags')
		let inheritance = 0
		if (flags.includes('CI')) inheritance |= WINDOWS_CONTAINER_INHERIT
		if (flags.includes('OI')) inheritance |= WINDOWS_OBJECT_INHERIT
		return {
			Sid: fields[5],
			Type: fields[0] === 'A' ? 'Allow' : fields[0],
			Rights: windowsSddlRights(fields[2]),
			Inheritance: inheritance,
			Propagation: flags.includes('NP') ? 0x4 : flags.includes('IO') ? 0x8 : 0,
			Inherited: flags.includes('I') || flags.includes('ID'),
		}
	})
	return { Protected: controlFlags.includes('P'), Rules: rules }
}

function readWindowsAclSnapshot(directory, runCommand) {
	const aclFile = join(directory, `.${basename(directory)}.${process.pid}.${randomUUID()}.acl`)
	try {
		runCommand('icacls.exe', [directory, '/save', aclFile, '/q'], {
			env: sanitizedEnvironment(),
		})
		return parseWindowsAclSddl(readFileSync(aclFile, 'utf16le'))
	} finally {
		try { unlinkSync(aclFile) } catch { /* absent when icacls failed */ }
	}
}

function writeWindowsAclRestoreFile(directory, sid) {
	const relativeName = basename(directory)
	if (relativeName.length === 0 || relativeName === '.' || relativeName === '..') {
		throw new Error(`Windows ACL restore requires a named directory: ${directory}`)
	}
	const aclFile = join(dirname(directory), `.${relativeName}.${process.pid}.${randomUUID()}.acl`)
	const contents = `${relativeName}\r\nD:PAI(A;OICI;FA;;;${sid})\r\n`
	let fd
	try {
		fd = openSync(aclFile, 'wx', 0o600)
		writeFileSync(fd, Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from(contents, 'utf16le'),
		]))
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		return aclFile
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd) } catch { /* best effort cleanup */ }
		}
		try { unlinkSync(aclFile) } catch { /* absent or already closed */ }
		throw error
	}
}

/**
 * Replace a directory's DACL with one protected FullControl rule for the
 * current user and verify the resulting ACL. `platform`, `runCommand`, and
 * `cache` are injectable so the failure path can be tested without Windows.
 */
export function applyWindowsPrivateDirectoryAcl(directory, options = {}) {
	if ((options.platform ?? process.platform) !== 'win32') return
	const runCommand = options.runCommand ?? runWindowsCommand
	const cache = options.cache
	const cacheKey = cache === undefined ? undefined : windowsAclCacheKey(directory)
	const identity = windowsDirectoryIdentity(directory)
	// A verified path may skip another native helper launch only while it still
	// names the same directory object. Replacing the path forces a fresh ACL
	// write and readback instead of extending the cache across a replacement.
	if (cache !== undefined && sameWindowsDirectoryIdentity(cache.get(cacheKey), identity)) return
	const sid = String(options.userSid ?? windowsUserSid(runCommand))
	if (!/^S-\d-(?:\d+-)+\d+$/i.test(sid)) {
		throw new Error('Windows user SID is invalid')
	}
	const aclFile = writeWindowsAclRestoreFile(directory, sid)
	try {
		runCommand('icacls.exe', [dirname(directory), '/restore', aclFile, '/q'], { env: sanitizedEnvironment() })
	} finally {
		try { unlinkSync(aclFile) } catch { /* absent when icacls failed */ }
	}
	const snapshot = options.readSnapshot === undefined
		? readWindowsAclSnapshot(directory, runCommand)
		: options.readSnapshot(directory, sid)
	validateWindowsAclSnapshot(snapshot, sid)
	if (cache !== undefined) cache.set(cacheKey, identity)
}

// The owner-only ACL protects this process from other users; a same-user
// process already has the authority to change/read the directory, so caching
// a successful identity-bound validation does not widen that boundary.
const WINDOWS_ACL_CACHE = new Map()

function setPrivateMode(filePath, mode) {
	try {
		chmodSync(filePath, mode)
	} catch (error) {
		// Windows ACLs, not POSIX mode bits, provide the privacy guarantee. The
		// chmod call is best-effort there because some filesystems reject it.
		if (process.platform !== 'win32') throw error
	}
}

function ensurePrivateDirectory(directory) {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const stat = lstatSync(directory)
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Codex adapter path is not a private directory: ${directory}`)
	}
	// chmod is a no-op on platforms without POSIX mode bits, and is important
	// on Unix when an existing directory was created with a broader umask.
	setPrivateMode(directory, 0o700)
	applyWindowsPrivateDirectoryAcl(directory, {
		cache: WINDOWS_ACL_CACHE,
	})
}

function syncDirectory(directory) {
	try {
		const fd = openSync(directory, 'r')
		try {
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
	} catch {
		// Directory fsync is not available on all supported platforms/filesystems.
	}
}

/** Replace a private file without exposing a partially-written config. */
export function atomicWritePrivateFile(filePath, contents, mode = 0o600) {
	const directory = dirname(filePath)
	ensurePrivateDirectory(directory)
	const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
	let fd
	try {
		fd = openSync(temporaryPath, 'wx', mode)
		writeFileSync(fd, contents, { encoding: 'utf8' })
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		setPrivateMode(temporaryPath, mode)
		// rename replaces an existing regular file atomically. A pre-existing
		// symlink is replaced, never followed, so auth files are never involved.
		renameSync(temporaryPath, filePath)
		setPrivateMode(filePath, mode)
		syncDirectory(directory)
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd) } catch { /* best effort cleanup */ }
		}
		try { unlinkSync(temporaryPath) } catch { /* absent or already renamed */ }
		throw error
	}
}

/** Ensure the home, controlled process cwd, and fixed config exist. */
export function ensureCodexRuntime(options = {}) {
	const paths = options?.paths ?? resolveCodexRuntimePaths(options)
	ensurePrivateDirectory(paths.codexHome)
	ensurePrivateDirectory(paths.workspace)
	atomicWritePrivateFile(paths.configPath, CODEX_APP_SERVER_CONFIG_TOML, 0o600)
	return paths
}

/** Build the child environment while forcibly replacing any ambient home. */
export function codexAppServerEnvironment(options = {}) {
	const paths = options?.paths ?? ensureCodexRuntime(options)
	const source = options?.source ?? process.env
	return Object.freeze({
		...sanitizedEnvironment(source),
		CODEX_HOME: paths.codexHome,
	})
}

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
	clientInfo: Object.freeze({ name: 'dsh-codex-adapter', version: CODEX_ADAPTER_VERSION }),
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
		const runtimePaths = options.env === undefined
			? ensureCodexRuntime({ paths: options.runtimePaths })
			: undefined
		this.#env = options.env === undefined
			? codexAppServerEnvironment({ paths: runtimePaths })
			: options.env
		this.#spawnOptions = options.spawnOptions ?? (runtimePaths === undefined ? {} : { cwd: runtimePaths.workspace })
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
				// A pending RPC is an active caller operation; its deadline must
				// remain live until the record is settled and cleaned up.
				record.timer = setTimeout(() => this.#timeoutPending(record), timeoutMs)
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
		// Initialization gates pending RPCs, so its failure deadline must remain
		// live until the child initializes or the client tears it down.
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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import type { AccountLoginState, StartAccountLoginInput } from '../../shared/limitsTypes'
import { APP_VERSION } from '../../shared/version'
import { cliToken } from '../limits/probes/agyRenewal'
import { record, resolveAgyCli, resolveCli, text } from '../limits/probes/cli'
import { validateExternalUrl } from './externalUrl'
import { claudeLoginEnvironment, loginEnvironment, loginProfilesRoot, readLoginCredential, safeLoginRoot, terminateLoginProcess } from './loginProcess'

type Provider = StartAccountLoginInput['provider']
type Credential = { filename: string; text: string }
interface LoginOptions {
  userData: string
  getScanT3(): boolean | Promise<boolean>
  onUpdate(state: AccountLoginState): void
  commitAccount(account: { id: string; provider: Provider; displayName?: string; dataDir?: string }, credential?: Credential): Promise<void>
  version?: string
  spawnProcess?: typeof spawnLogin
  terminateProcess?: typeof terminateLoginProcess
  resolveCli?: typeof resolveCli
  resolveAgyCli?: typeof resolveAgyCli
  tempDirectory?: string
  timeoutMs?: number
}

const providers = {
  antigravity: ['Antigravity', 'agy', ['accounts.google.com']],
  codex: ['Codex', 'codex', ['auth.openai.com', 'chatgpt.com']],
  claude: ['Claude Code', 'claude', ['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com']]
} as const
const callback = 'https://antigravity.google/oauth-callback'
const failure = '登录未完成，请重试。'
const codePattern = /^[\w./~-]{1,2048}$/

function spawnLogin(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(executable, args, {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function authorizationUrl(raw: string, provider: Provider): URL | undefined {
  try {
    if (raw.length > 8192) return
    const url = validateExternalUrl(raw)
    const hosts: readonly string[] = providers[provider][2]
    if (!hosts.includes(url.hostname) || url.port || url.hash || /callback/i.test(url.pathname)) return
    if (Array.from(url.searchParams.keys()).some(key => /^(?:code|access_token|refresh_token|id_token|token|email|login_hint)$/i.test(key))) return
    if (/@/.test(decodeURIComponent(url.toString()))) return
    return url
  } catch { return undefined }
}

function submittedCode(raw: string, pendingState: string): string | undefined {
  if (raw.length > 8192 || /[\r\n\u2028\u2029]/.test(raw)) return
  const value = raw.trim()
  if (codePattern.test(value)) return value
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return
  const url = URL.parse(value)
  if (!value.startsWith(`${callback}?`) || !url || `${url.origin}${url.pathname}` !== callback || url.hash) return
  const codes = url.searchParams.getAll('code')
  const states = url.searchParams.getAll('state')
  if (states.length === 1 && states[0] === pendingState && codes.length === 1 && codePattern.test(codes[0])) return value
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return undefined }
}

async function findAgyCredential(root: string): Promise<Credential> {
  for (const filename of ['antigravity-oauth-token', 'acp_token.json']) {
    const raw = await readLoginCredential(root, filename).catch(() => '')
    const json = parseJson(raw)
    const acp = record(json)
    if (cliToken.safeParse(json).success ||
      (acp && text(acp.client_id) && text(acp.client_secret) && text(acp.refresh_token) &&
        (acp.project_id === undefined || text(acp.project_id))) ||
      (filename === 'antigravity-oauth-token' && /^[A-Za-z0-9\-._~+/]+=*$/.test(raw.trim()))) {
      return { filename, text: raw }
    }
  }
  throw new Error(failure)
}

interface Flow {
  id: string
  input: StartAccountLoginInput
  controller: AbortController
  done: Promise<void>
  committed: boolean
  committing: boolean
  pendingState?: string
  submit?: (value: string) => void
}

export function createAccountLoginManager(options: LoginOptions) {
  let state: AccountLoginState = { phase: 'idle', flowId: null, provider: null, authorizationUrl: null, message: null }
  let active: Flow | undefined
  let operations = Promise.resolve()
  let stopped = false

  function publish(flow: Flow, phase: AccountLoginState['phase'], message: string | null = null, authorizationUrl: string | null = null) {
    state = { phase, flowId: flow.id, provider: flow.input.provider, authorizationUrl, message }
    try { options.onUpdate({ ...state }) } catch { /* observers must not interrupt cleanup */ }
  }

  function runProtocol(flow: Flow, child: ChildProcessWithoutNullStreams): Promise<boolean> {
    const { signal } = flow.controller
    const { provider } = flow.input
    return new Promise(resolve => {
      let finished = false
      let authShown = false
      let initialized = false
      let loginId: string | undefined
      const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
      const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity })
      function finish(success: boolean) {
        if (finished) return
        finished = true
        flow.submit = undefined
        signal.removeEventListener('abort', abort)
        stdout.close()
        stderr.close()
        resolve(success)
      }
      const write = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`)
      function abort() {
        if (loginId && child.stdin.writable) {
          try { write({ id: 3, method: 'account/login/cancel', params: { loginId } }) } catch { /* best effort */ }
        }
        finish(false)
      }
      function showAuth(url: URL, phase: 'waiting_browser' | 'waiting_code') {
        authShown = true
        const safeUrl = url.toString()
        publish(flow, phase, null, safeUrl)
      }
      function line(raw: string) {
        if (finished || signal.aborted || raw.length > 65536) return
        if (provider === 'codex') {
          const message = record(parseJson(raw))
          if (!message) return
          if (message.id === 1 && !initialized) {
            if (!record(message.result) || message.error) return finish(false)
            initialized = true
            write({ method: 'initialized' })
            write({ id: 2, method: 'account/login/start', params: { type: 'chatgpt' } })
          } else if (message.id === 2 && initialized && !loginId) {
            const result = record(message.result)
            const url = typeof result?.authUrl === 'string' ? authorizationUrl(result.authUrl, provider) : undefined
            const id = text(result?.loginId)
            if (message.error || result?.type !== 'chatgpt' || !url || !id) return finish(false)
            loginId = id
            showAuth(url, 'waiting_browser')
          } else if (message.method === 'account/login/completed' && loginId) {
            const params = record(message.params)
            if (params && (params.loginId === undefined || params.loginId === loginId)) finish(params.success === true)
          }
          return
        }
        if (authShown) return
        for (const match of stripVTControlCharacters(raw).matchAll(/https:\/\/[^\s<>"'`]+/g)) {
          const url = authorizationUrl(match[0], provider)
          if (!url) continue
          if (provider === 'antigravity') {
            const states = url.searchParams.getAll('state')
            if (url.searchParams.getAll('response_type').join(',') !== 'code' ||
              url.searchParams.getAll('redirect_uri').join(',') !== callback ||
              states.length !== 1 || !/^[^\s\u0000-\u001f\u007f]{1,512}$/.test(states[0])) continue
            flow.pendingState = states[0]
            flow.submit = value => { child.stdin.write(`${value}\n`) }
            showAuth(url, 'waiting_code')
          } else showAuth(url, 'waiting_browser')
          break
        }
      }
      const handleLine = (raw: string) => { try { line(raw) } catch { finish(false) } }
      for (const stream of [child, child.stdin, child.stdout, child.stderr, stdout, stderr]) {
        stream.on('error', () => finish(false))
      }
      child.once('close', code => finish(provider !== 'codex' && code === 0))
      signal.addEventListener('abort', abort, { once: true })
      stdout.on('line', handleLine)
      if (provider === 'claude') stderr.on('line', handleLine)
      if (signal.aborted) abort()
      else if (provider === 'codex') {
        try {
          write({ id: 1, method: 'initialize', params: { clientInfo: { name: 't3-like-usageboard', version: options.version ?? APP_VERSION } } })
        } catch { finish(false) }
      } else if (provider === 'claude') publish(flow, 'waiting_browser')
    })
  }

  async function run(flow: Flow, ready: () => void) {
    const { signal } = flow.controller
    const { provider, displayName } = flow.input
    const id = `manual-${randomUUID()}`
    let root: string | undefined
    let profile: string | undefined
    let removeDir: string | undefined
    let child: ChildProcessWithoutNullStreams | undefined
    let message = failure
    const timeout = setTimeout(() => flow.controller.abort('timeout'), options.timeoutMs ?? 300_000)
    async function stopChild() {
      if (!child) return
      const running = child
      child = undefined
      try { await (options.terminateProcess ?? terminateLoginProcess)(running) }
      finally { running.stdin.destroy(); running.stdout.destroy(); running.stderr.destroy() }
    }
    try {
      const [label, command] = providers[provider]
      let executable: string | undefined
      if (provider === 'antigravity') {
        const scanT3 = await options.getScanT3()
        signal.throwIfAborted()
        executable = await (options.resolveAgyCli ?? resolveAgyCli)({ scanT3 })
      } else {
        executable = await (options.resolveCli ?? resolveCli)(provider)
      }
      signal.throwIfAborted()
      if (!executable) {
        message = `未检测到 ${label} CLI（${command}），请先安装 ${label}${provider === 'codex' ? ' CLI' : ''} 后再登录。`
        return
      }
      if (!isAbsolute(executable) || (process.platform === 'win32' && !/\.exe$/i.test(executable))) return
      if (provider === 'antigravity') {
        root = removeDir = await mkdtemp(join(await safeLoginRoot(options.tempDirectory ?? tmpdir()), 'usage-agy-login-'))
        await mkdir(join(root, 'antigravity-acp'), { mode: 0o700 })
        await writeFile(join(root, 'antigravity-acp', 'settings.json'), '{"auth":{"type":"oauth-personal"}}\n', { flag: 'wx', mode: 0o600 })
      } else {
        const candidate = join(await loginProfilesRoot(options.userData), id)
        await mkdir(candidate, { mode: 0o700 })
        root = profile = removeDir = candidate
        if (provider === 'codex') {
          await writeFile(join(root, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { flag: 'wx', mode: 0o600 })
        }
      }
      signal.throwIfAborted()
      const args = provider === 'antigravity'
        ? ['acp', '--gemini-dir', root, '--app-data-dir', 'antigravity-acp', '--disable-telemetry', '--include-default-customizations=false', '--login']
        : provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', 'app-server'] : ['auth', 'login', '--claudeai']
      const env = provider === 'claude' ? claudeLoginEnvironment(root) : loginEnvironment(root, provider === 'antigravity'
        ? { GEMINI_HOME: root, SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', AGY_ACP_FORCE_FILE_STORAGE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1' }
        : { CODEX_HOME: root })
      child = (options.spawnProcess ?? spawnLogin)(executable, args, root, env)
      const result = runProtocol(flow, child)
      ready()
      if (!await result) return
      signal.throwIfAborted()
      publish(flow, 'verifying')
      await stopChild()
      let credential: Credential | undefined
      if (provider === 'antigravity') {
        credential = await findAgyCredential(join(root, 'antigravity-acp'))
        const accountsPath = join(await safeLoginRoot(options.userData), 'accounts')
        const storage = await lstat(accountsPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        if (storage && (!storage.isDirectory() || relative(accountsPath, await realpath(accountsPath)))) return
      } else {
        const raw = await readLoginCredential(root, provider === 'codex' ? 'auth.json' : '.credentials.json')
        const json = record(parseJson(raw))
        const oauth = record(provider === 'codex' ? json?.tokens : json?.claudeAiOauth)
        if (!(provider === 'codex' ? text(oauth?.access_token) : text(oauth?.accessToken) || text(oauth?.refreshToken))) return
      }
      signal.throwIfAborted()
      flow.committing = true
      await options.commitAccount({ id, provider, displayName, dataDir: profile }, credential)
      flow.committed = true
    } catch { /* never publish upstream errors */ }
    finally {
      clearTimeout(timeout)
      try { await stopChild() } catch { /* still attempt directory removal */ }
      if (removeDir && (!profile || !flow.committed)) {
        try { await rm(removeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
        catch { message = '无法清理临时登录目录。' }
      }
      active = undefined
      if (flow.committed) publish(flow, 'succeeded')
      else if (signal.aborted && signal.reason !== 'timeout') publish(flow, 'cancelled')
      else publish(flow, 'failed', signal.reason === 'timeout' ? '登录已超时，请重试。' : message)
      ready()
    }
  }

  return {
    getState: () => ({ ...state }),
    async start(input: StartAccountLoginInput): Promise<AccountLoginState> {
      let ready: () => void = () => {}
      const started = new Promise<void>(resolve => { ready = resolve })
      operations = operations.then(async () => {
        if (active) {
          if (!active.committing) active.controller.abort()
          await active.done
        }
        if (stopped) { ready(); return }
        const flow: Flow = { id: randomUUID(), input, controller: new AbortController(), done: Promise.resolve(), committed: false, committing: false }
        active = flow
        flow.done = Promise.resolve().then(() => run(flow, ready))
        publish(flow, 'starting')
      })
      await started
      return { ...state }
    },
    async submitCode(flowId: string, raw: string): Promise<AccountLoginState> {
      const flow = active
      if (flow?.id !== flowId || flow.controller.signal.aborted || state.phase !== 'waiting_code' || !flow.pendingState || !flow.submit) return { ...state }
      const value = submittedCode(raw, flow.pendingState)
      if (!value) throw new Error('授权码或回调链接无效。')
      try { flow.submit(value) } catch { throw new Error(failure) }
      publish(flow, 'verifying')
      return { ...state }
    },
    async cancel(flowId: string): Promise<AccountLoginState> {
      if (active?.id === flowId) {
        if (!active.committing) active.controller.abort()
        await active.done
      }
      return { ...state }
    },
    async stop(): Promise<void> {
      stopped = true
      if (active && !active.committing) active.controller.abort()
      await operations
      await active?.done
    }
  }
}

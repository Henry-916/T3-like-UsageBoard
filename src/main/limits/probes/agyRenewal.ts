import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { APP_VERSION } from '../../../shared/version'
import type { CachedAntigravityToken } from '../antigravityTokenCache'

export const cliToken = z.object({
  token: z.object({
    access_token: z.string().trim().min(1),
    refresh_token: z.string().trim().optional(),
    expiry: z.string().optional()
  }).passthrough()
}).passthrough()

export interface CliRenewParams {
  executable: string
  stored: z.infer<typeof cliToken>
  authMethod: 'oauth-personal' | 'oauth-business'
  refreshToken: string
  signal: AbortSignal
  now: () => number
}

export type CliRenewOutcome =
  | { kind: 'ok'; token: CachedAntigravityToken }
  | { kind: 'expired' | 'failed' }

const envAllow = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
])
const loginRequired = /https:\/\/accounts\.google\.com\/|No browser is available here|invalid_grant|revoked|sign-in required/i

async function killWindowsTree(pid: number, stillRunning: () => boolean): Promise<void> {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  if (!root || !isAbsolute(root)) return
  const executable = join(root, 'System32', 'taskkill.exe')
  const handle = await open(executable, 'r')
  try {
    const header = Buffer.alloc(64)
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.readUInt16LE(0) !== 0x5a4d) return
    const offset = header.readUInt32LE(60)
    if ((await handle.read(header, 0, 4, offset)).bytesRead !== 4 || header.readUInt32LE(0) !== 0x4550) return
  } finally {
    await handle.close()
  }
  if (!stillRunning()) return
  await new Promise<void>(resolve => {
    const tree = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore'
    })
    tree.once('error', () => resolve())
    tree.once('close', () => resolve())
  })
}

function acp(
  executable: string, root: string, cwd: string, authMethod: string, signal: AbortSignal
): Promise<'ok' | 'expired' | 'failed'> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => envAllow.has(key.toUpperCase()))
  )
  Object.assign(env, {
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    ...(process.platform === 'win32' ? { HOMEDRIVE: parse(root).root.slice(0, 2), HOMEPATH: root.slice(2) } : {}),
    XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
    GEMINI_HOME: root, AGY_ACP_FORCE_FILE_STORAGE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    TEMP: root, TMP: root, TMPDIR: root, SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0'
  })
  return new Promise(resolve => {
    signal.throwIfAborted()
    const child = spawn(executable, ['acp', '--gemini-dir', root, '--app-data-dir', 'antigravity-acp',
      '--disable-telemetry', '--include-default-customizations=false'], {
      cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    let outcome: 'ok' | 'expired' | 'failed' | undefined
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const stdout = createInterface({ input: child.stdout })
    const abort = (): void => finish('failed')
    function finish(result: NonNullable<typeof outcome>): void {
      if (outcome) return
      outcome = result
      signal.removeEventListener('abort', abort)
      stdout.close()
      child.stdin.destroy()
      if (process.platform === 'win32' && child.pid && child.exitCode === null) {
        void killWindowsTree(child.pid, () => child.exitCode === null && child.signalCode === null)
          .catch(() => {}).then(() => { child.kill('SIGKILL') })
      } else child.kill('SIGKILL')
      cleanupTimer = setTimeout(() => {
        child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        resolve(outcome ?? 'failed')
      }, 1500)
    }
    child.once('close', () => {
      finish('failed')
      clearTimeout(cleanupTimer)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve(outcome ?? 'failed')
    })
    child.on('error', abort)
    child.stdin.on('error', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return abort()
    let initialized = false
    const send = (id: number, method: string, params: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }
    let stderrTail = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (loginRequired.test(stderrTail + chunk)) finish('expired')
      stderrTail = chunk.slice(-100)
    })
    stdout.on('line', line => {
      if (loginRequired.test(line)) return finish('expired')
      try {
        const message = JSON.parse(line)
        if (message?.method && message.id != null) return finish('expired')
        if (message?.id === 1 && !initialized && 'result' in message) {
          initialized = true
          send(2, 'authenticate', { methodId: authMethod })
        } else if (message?.id === 2 && initialized) {
          if (message.error) finish(message.error.code === -32000 ? 'expired' : 'failed')
          else if ('result' in message) finish('ok')
        } else if (message?.id === 1 && message.error) finish('failed')
      } catch {
        // Non-JSON diagnostic output is never surfaced.
      }
    })
    send(1, 'initialize', {
      protocolVersion: 2,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 't3-code', title: 'UsageDashboard', version: APP_VERSION }
    })
  })
}

export async function renewAgyCliToken(params: CliRenewParams): Promise<CliRenewOutcome> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, params.signal])
  const timer = setTimeout(() => controller.abort(), 25_000)
  let root: string | undefined
  let tokenPath: string | undefined
  try {
    signal.throwIfAborted()
    root = await mkdtemp(join(tmpdir(), 'usage-agy-'))
    const app = join(root, 'antigravity-acp')
    const cwd = join(root, 'cwd')
    await mkdir(app)
    await mkdir(cwd)
    tokenPath = join(app, 'antigravity-oauth-token')
    await writeFile(join(app, 'settings.json'), `${JSON.stringify({ auth: { type: params.authMethod } })}\n`)
    await writeFile(tokenPath, JSON.stringify({
      ...params.stored,
      token: { ...params.stored.token, refresh_token: params.refreshToken, expiry: new Date(0).toISOString() }
    }), { signal, mode: 0o600 })
    const status = await acp(params.executable, root, cwd, params.authMethod, signal)
    signal.throwIfAborted()
    if (status !== 'ok') return { kind: status }
    const { token } = cliToken.parse(JSON.parse(await readFile(tokenPath, { encoding: 'utf8', signal })))
    const now = params.now()
    if (!token.expiry || !(Date.parse(token.expiry) > now + 60_000)) return { kind: 'failed' }
    return { kind: 'ok', token: {
      accessToken: token.access_token, refreshToken: token.refresh_token || params.refreshToken,
      expiry: token.expiry, updatedAt: now
    } }
  } catch {
    return { kind: 'failed' }
  } finally {
    clearTimeout(timer)
    // Remove the secret first; recursive removal also retries if the CLI still has it open.
    if (tokenPath) await unlink(tokenPath).catch(() => {})
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(async () => {
      if (tokenPath) await unlink(tokenPath).catch(() => {})
    })
  }
}

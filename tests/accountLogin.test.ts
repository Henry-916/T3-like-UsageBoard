import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateExternalUrl } from '../src/main/accounts/externalUrl'
import { createAccountLoginManager } from '../src/main/accounts/loginManager'

const tempDirs: string[] = []
const managers: ReturnType<typeof createAccountLoginManager>[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.stop()))
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

async function fixture(overrides: Partial<Parameters<typeof createAccountLoginManager>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'usage-login-test-'))
  tempDirs.push(root)
  const userData = join(root, 'userData')
  await mkdir(userData)
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  })
  const writes: string[] = []
  child.stdin.on('data', data => writes.push(String(data)))
  const spawnProcess = vi.fn((_exe: string, _args: string[], _cwd: string, _env: NodeJS.ProcessEnv) =>
    child as unknown as ChildProcessWithoutNullStreams)
  const resolveExecutable = vi.fn(async () => join(root, 'mock-cli.exe'))
  const terminateProcess = vi.fn(async () => {})
  const commitAccount = vi.fn<Parameters<typeof createAccountLoginManager>[0]['commitAccount']>(async () => {})
  const openExternal = vi.fn()
  const onUpdate = vi.fn()
  // Supply the legacy callback as a tripwire for browser-launch regressions.
  const manager = createAccountLoginManager({
    userData, tempDirectory: root, ...{ openExternal }, onUpdate,
    spawnProcess, resolveCli: resolveExecutable, resolveAgyCli: resolveExecutable, terminateProcess, commitAccount, ...overrides
  })
  managers.push(manager)
  const line = (data: unknown) => child.stdout.write(`${JSON.stringify(data)}\n`)
  return { manager, child, spawnProcess, openExternal, onUpdate, commitAccount, terminateProcess, writes, userData, root, line }
}

describe('login external URLs', () => {
  it('rejects spoofed hosts, credentials, and whitespace', () => {
    expect(validateExternalUrl('https://github.com/a').hostname).toBe('github.com')
    for (const url of ['http://github.com', 'https://github.com.evil.test', 'https://u:p@github.com', 'https://@github.com',
      'https://github.com/\nx', 'https://github.com /x', 'https://github.com\\x']) {
      expect(() => validateExternalUrl(url)).toThrow('不允许打开此链接。')
    }
  })
})

describe('mock account login', () => {
  it('isolates Antigravity login, validates code and hands credentials to the encrypted commit boundary', async () => {
    const f = await fixture()
    const { flowId } = await f.manager.start({ provider: 'antigravity' })
    const [, args, cwd, env] = f.spawnProcess.mock.calls[0]
    expect(args).toContain('--login')
    expect(env).toMatchObject({ GEMINI_HOME: cwd, SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', HOME: cwd, LOCALAPPDATA: cwd })
    const acp = join(cwd, 'antigravity-acp')
    expect(JSON.parse(await readFile(join(acp, 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } })
    const redirect = 'https://antigravity.google/oauth-callback'
    const url = `https://accounts.google.com/o/oauth2/auth?response_type=code&state=expected&redirect_uri=${encodeURIComponent(redirect)}`
    f.child.stdout.write(`${url}&state=other\n${url.replace('accounts.google.com', 'github.com')}\n`)
    expect(f.manager.getState().phase).toBe('starting')
    f.child.stdout.write(`${url}\n${url}\n`)
    expect(f.manager.getState()).toMatchObject({ phase: 'waiting_code', authorizationUrl: url })
    await expect(f.manager.submitCode(flowId!, 'mock\npayload')).rejects.toThrow('授权码或回调链接无效')
    await expect(f.manager.submitCode(flowId!, `${redirect}?state=other&code=mock`)).rejects.toThrow()
    expect(f.writes).toEqual([])
    const response = `${redirect}?state=expected&code=mock-code`
    await f.manager.submitCode(flowId!, response)
    expect(f.writes).toEqual([`${response}\n`])
    const credential = '{"token":{"access_token":"mock-secret"}}'
    await writeFile(join(acp, 'antigravity-oauth-token'), credential)
    f.child.emit('close', 0)
    await vi.waitFor(() => expect(f.manager.getState().phase).toBe('succeeded'))
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(f.commitAccount).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'antigravity' }),
      { filename: 'antigravity-oauth-token', text: credential })
    expect(JSON.stringify(f.onUpdate.mock.calls)).not.toMatch(/mock-code|mock-secret/)
    await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([false, true])('runs the Codex protocol with an isolated profile (cancel=%s)', async cancel => {
    vi.stubEnv('OPENAI_API_KEY', 'host-secret')
    const f = await fixture()
    const { flowId } = await f.manager.start({ provider: 'codex' })
    const [, args, cwd, env] = f.spawnProcess.mock.calls[0]
    expect(args).toEqual(['-c', 'cli_auth_credentials_store="file"', 'app-server'])
    expect(env).toMatchObject({ CODEX_HOME: cwd, USERPROFILE: cwd })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(await readFile(join(cwd, 'config.toml'), 'utf8')).toBe('cli_auth_credentials_store = "file"\n')
    expect(f.writes.map(raw => JSON.parse(raw).method)).toEqual(['initialize'])
    f.line({ id: 1, result: {} })
    expect(f.writes.map(raw => JSON.parse(raw).method)).toEqual(['initialize', 'initialized', 'account/login/start'])
    const url = 'https://auth.openai.com/oauth/authorize'
    f.line({ id: 2, result: { type: 'chatgpt', loginId: 'mock-id', authUrl: url } })
    expect(f.manager.getState()).toMatchObject({ phase: 'waiting_browser', authorizationUrl: url })
    if (cancel) {
      await f.manager.cancel(flowId!)
      expect(f.writes.map(raw => JSON.parse(raw)).at(-1)).toMatchObject({
        method: 'account/login/cancel', params: { loginId: 'mock-id' }
      })
      expect(f.manager.getState().phase).toBe('cancelled')
      await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await writeFile(join(cwd, 'auth.json'), '{"tokens":{"access_token":"mock-secret"}}')
      f.line({ method: 'account/login/completed', params: { loginId: 'mock-id', success: true } })
      await vi.waitFor(() => expect(f.manager.getState().phase).toBe('succeeded'))
      expect(f.commitAccount).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'codex', dataDir: cwd }), undefined)
      expect(await readFile(join(cwd, 'auth.json'), 'utf8')).toContain('mock-secret')
    }
    expect(f.openExternal).not.toHaveBeenCalled()
  })

  it.each([
    { host: 'claude.ai', stream: 'stderr', valid: false },
    { host: 'claude.com', stream: 'stdout', valid: true },
    { host: 'platform.claude.com', stream: 'stderr', valid: true }
  ] as const)('publishes a sanitized $host authorization URL without opening a browser', async ({ host, stream, valid }) => {
    const f = await fixture()
    const hostPaths = {
      HOME: 'C:\\host\\home', USERPROFILE: 'C:\\host\\profile',
      APPDATA: 'C:\\host\\roaming', LOCALAPPDATA: 'C:\\host\\local',
      HOMEDRIVE: 'C:', HOMEPATH: '\\host\\profile',
      TEMP: 'C:\\host\\temp', TMP: 'C:\\host\\tmp'
    }
    for (const [name, value] of Object.entries(hostPaths)) vi.stubEnv(name, value)
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-secret')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'host-secret')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://example.test')
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    await f.manager.start({ provider: 'claude' })
    const [, args, cwd, env] = f.spawnProcess.mock.calls[0]
    expect(args).toEqual(['auth', 'login', '--claudeai'])
    expect(env).toMatchObject({
      ...hostPaths, CLAUDE_CONFIG_DIR: cwd, DISABLE_AUTOUPDATER: '1',
      BROWSER: '__USAGE_DASHBOARD_NO_BROWSER__'
    })
    expect(Object.keys(env).some(name => /^ANTHROPIC_/i.test(name))).toBe(false)
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    const url = `https://${host}/oauth/authorize`
    f.child[stream].write(`\x1b[32m${url}?login_hint=hidden%40example.test\x1b[0m\n`)
    expect(f.manager.getState().authorizationUrl).toBeNull()
    f.child[stream].write(`\x1b[?25lOpen \x1b[1;32m${url}\x1b[0m\x1b[?25h\n`)
    expect(f.manager.getState().authorizationUrl).toBe(url)
    await writeFile(join(cwd, '.credentials.json'), valid ? '{"claudeAiOauth":{"refreshToken":"mock"}}' : '{}')
    f.child.emit('close', 0)
    await vi.waitFor(() => expect(f.manager.getState().phase).toBe(valid ? 'succeeded' : 'failed'))
    expect(f.openExternal).not.toHaveBeenCalled()
    if (!valid) await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a redirected profiles directory without spawning a child', async () => {
    const f = await fixture()
    const external = join(f.root, 'external')
    await mkdir(external)
    await symlink(external, join(f.userData, 'profiles'), 'junction')
    expect((await f.manager.start({ provider: 'claude' })).phase).toBe('failed')
    expect(f.spawnProcess).not.toHaveBeenCalled()
  })

  it('handles missing executables and sanitizes upstream failures', async () => {
    const missing = await fixture({ resolveCli: async () => undefined })
    expect((await missing.manager.start({ provider: 'codex' })).message).toContain('未检测到 Codex CLI')
    const f = await fixture()
    await f.manager.start({ provider: 'claude' })
    f.child.emit('error', new Error('private-token user@example.test'))
    await vi.waitFor(() => expect(f.manager.getState().phase).toBe('failed'))
    expect(JSON.stringify(f.onUpdate.mock.calls)).not.toMatch(/private-token|example\.test/)
  })

  it('awaits process termination and profile removal on stop', async () => {
    let complete!: () => void
    const terminated = new Promise<void>(resolve => { complete = resolve })
    const f = await fixture({ terminateProcess: () => terminated })
    await f.manager.start({ provider: 'claude' })
    const [, , cwd] = f.spawnProcess.mock.calls[0]
    const stopped = f.manager.stop()
    expect((await lstat(cwd)).isDirectory()).toBe(true)
    complete()
    await stopped
    expect(f.manager.getState().phase).toBe('cancelled')
    await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('timing out terminates the mock child before reporting failure', async () => {
    const f = await fixture({ timeoutMs: 200 })
    await f.manager.start({ provider: 'claude' })
    const [, , cwd] = f.spawnProcess.mock.calls[0]
    await vi.waitFor(() => expect(f.manager.getState()).toMatchObject({ phase: 'failed', message: '登录已超时，请重试。' }))
    expect(f.terminateProcess).toHaveBeenCalledOnce()
    expect(f.commitAccount).not.toHaveBeenCalled()
    await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

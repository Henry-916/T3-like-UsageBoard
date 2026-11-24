import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, constants, open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DiscoveredAccount } from '../../../shared/types'

export function credentialCandidates(account: DiscoveredAccount): string[] {
  const paths = account.credentialPaths ?? []
  const dataDir = account.dataDir
  if (account.origin !== 't3' || !dataDir) return paths
  const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return paths.filter(path => key(dirname(path)) === key(dataDir))
}

export async function safeCliHome(account: DiscoveredAccount): Promise<string | undefined> {
  if (account.origin === 't3' || !account.dataDir) return
  return safeCliDirectory(account.dataDir)
}

async function safeCliDirectory(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return
  const t3 = join(homedir(), '.t3')
  const within = (root: string, path: string) => {
    if (process.platform === 'win32') { root = root.toLowerCase(); path = path.toLowerCase() }
    const child = relative(root, path)
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  }
  if (within(t3, path)) return
  try {
    const dataDir = await realpath(path)
    const resolvedT3 = await realpath(t3).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return t3
      throw error
    })
    if (within(t3, dataDir) || within(resolvedT3, dataDir) || !(await stat(dataDir)).isDirectory()) return
    return dataDir
  } catch { return undefined }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
}

export function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
}

export const clamp = (value: number): number => Math.min(100, Math.max(0, value))

export function iso(value: string | number | undefined): string | undefined {
  if (value === undefined) return
  const date = new Date(value)
  if (Number.isFinite(date.getTime())) return date.toISOString()
}

export function fingerprint(identity: string | undefined): string | undefined {
  if (identity) return createHash('sha256').update(identity).digest('hex')
}

export function cliEnvironment(homeKey: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR', dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // Do not inherit provider API keys, OAuth overrides, or custom API endpoints.
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT',
    'WINDIR', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env[homeKey] = dataDir
  return env
}

export async function resolveCli(command: 'codex' | 'claude'): Promise<string | undefined> {
  if (process.platform === 'win32') return resolveWindowsCli(command, process.env, process.arch)
  for (const dir of (process.env.PATH ?? '').split(delimiter).map(entry => entry.replace(/^"|"$/g, ''))) {
    if (!isAbsolute(dir)) continue
    const path = join(dir, command)
    try {
      await access(path, constants.X_OK)
      return path
    } catch { /* try next PATH entry */ }
  }
}

async function nativeWindowsExecutable(path: string): Promise<string | undefined> {
  try {
    const target = await realpath(path)
    if (!target.toLowerCase().endsWith('.exe') || !(await stat(target)).isFile()) return
    if (!await safeCliDirectory(dirname(target))) return
    // Claude's npm wrapper can ship a text placeholder at bin/claude.exe until postinstall runs.
    const file = await open(target, 'r')
    try {
      const header = Buffer.alloc(64)
      if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length ||
          header.toString('ascii', 0, 2) !== 'MZ') return
      const offset = header.readUInt32LE(60)
      if (offset < header.length) return
      if ((await file.read(header, 0, 4, offset)).bytesRead === 4 && header.readUInt32LE(0) === 0x4550) return target
    } finally { await file.close() }
  } catch { /* missing or unreadable candidate */ }
}

async function packageExecutable(root: string, command: 'codex' | 'claude', arch: string) {
  const scope = command === 'claude' ? '@anthropic-ai' : '@openai'
  const name = command === 'claude' ? 'claude-code' : 'codex'
  const wrapper = join(root, scope, name)
  if (command === 'claude') {
    const installed = await nativeWindowsExecutable(join(wrapper, 'bin', 'claude.exe'))
    if (installed) return installed
  }
  if (arch !== 'x64' && arch !== 'arm64') return
  const platform = `${name}-win32-${arch}`
  const vendor = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
  const bin = command === 'claude' ? ['claude.exe'] : ['vendor', vendor, 'bin', 'codex.exe']
  const roots = [join(wrapper, 'node_modules'), root]
  // A pnpm wrapper is linked into the virtual store, where its dependencies are siblings.
  const linked = await realpath(wrapper).catch(() => undefined)
  if (linked && linked !== wrapper) roots.unshift(dirname(dirname(linked)))
  for (const modules of roots) {
    const installed = await nativeWindowsExecutable(join(modules, scope, platform, ...bin))
    if (installed) return installed
  }
}

export async function resolveWindowsCli(command: 'codex' | 'claude', env: NodeJS.ProcessEnv, arch: string) {
  const absolute = (value: string | undefined): value is string => !!value && isAbsolute(value)
  const path = (env.PATH ?? '').split(';').map(entry => entry.replace(/^"|"$/g, '')).filter(absolute)
  const pnpmHomes = [env.PNPM_HOME, absolute(env.LOCALAPPDATA) ? join(env.LOCALAPPDATA, 'pnpm') : undefined]
    .filter(absolute)
  const pnpmBins = new Set(pnpmHomes.flatMap(home => [home, join(home, 'bin')]).map(dir => resolve(dir).toLowerCase()))
  for (const dir of path) {
    // Recent pnpm versions can generate executable shims, not only .cmd/.ps1.
    if (!pnpmBins.has(resolve(dir).toLowerCase())) {
      const native = await nativeWindowsExecutable(join(dir, `${command}.exe`))
      if (native) return native
    }
    const packaged = await packageExecutable(join(dir, 'node_modules'), command, arch)
    if (packaged) return packaged
  }
  if (command === 'claude') {
    const home = absolute(env.USERPROFILE) ? env.USERPROFILE : homedir()
    const native = await nativeWindowsExecutable(join(home, '.local', 'bin', 'claude.exe'))
    if (native) return native
  }
  const npmHomes = [env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX,
    absolute(env.APPDATA) ? join(env.APPDATA, 'npm') : undefined].filter(absolute)
  for (const dir of new Set(npmHomes)) {
    const packaged = await packageExecutable(join(dir, 'node_modules'), command, arch)
    if (packaged) return packaged
  }
  for (const global of new Set([env.pnpm_config_global_dir ?? env.PNPM_CONFIG_GLOBAL_DIR,
    ...pnpmHomes.map(home => join(home, 'global'))].filter(absolute))) {
    const versions = await readdir(global, { withFileTypes: true }).catch(() => [])
    for (const version of versions) {
      if (!version.isDirectory() || !/^\d+$|^v11$/.test(version.name)) continue
      const dir = join(global, version.name)
      // pnpm <=10 uses numeric layout versions; >=11 exposes active groups via links.
      const installs = version.name === 'v11'
        ? (await readdir(dir, { withFileTypes: true }).catch(() => []))
          .filter(entry => entry.isSymbolicLink()).map(entry => join(dir, entry.name))
        : [dir]
      for (const install of installs) {
        const packaged = await packageExecutable(join(install, 'node_modules'), command, arch)
        if (packaged) return packaged
      }
    }
  }
}

type Exchange<T> = (frame: Record<string, unknown>, send: (frame: object) => void) => T | undefined

export async function exchangeCli<T>(
  executable: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal,
  start: object, receive: Exchange<T>
): Promise<T | undefined> {
  const cwd = await safeCliDirectory(tmpdir())
  if (!cwd || signal.aborted) return
  return new Promise(resolve => {
    const group = process.platform !== 'win32'
    const child = spawn(executable, args, { env, cwd, detached: group,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    let result: T | undefined
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      child.stdin.destroy()
      child.stdout.destroy()
      if (group && child.pid) {
        // POSIX npm shims may start a native grandchild. Stop their isolated group.
        try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* process already gone */ }
      }
      child.kill('SIGKILL')
    }
    const abort = () => { result = undefined; stop() }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', stop)
    child.once('close', () => {
      signal.removeEventListener('abort', abort)
      resolve(result)
    })
    child.stdin.on('error', stop)
    child.stdout.on('error', stop)
    const send = (frame: object) => {
      if (!stopping) child.stdin.write(`${JSON.stringify(frame)}\n`)
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stopping) return
      output += chunk
      if (output.length > 1024 * 1024) { stop(); return }
      let newline: number
      while (!stopping && (newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline)
        output = output.slice(newline + 1)
        let frame
        try { frame = record(JSON.parse(line)) } catch { continue }
        if (!frame) continue
        result = receive(frame, send)
        if (result !== undefined) stop()
      }
    })
    send(start)
  })
}

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { killWindowsTree } from '../processTree'

const allowedEnvironment = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'
])

const claudeHostPaths = new Set([
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'
])

export function claudeLoginEnvironment(root: string): NodeJS.ProcessEnv {
  // Claude launches the browser itself. Keep its host paths while isolating Claude's credentials.
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase()
      return allowedEnvironment.has(name) || claudeHostPaths.has(name)
    })),
    CLAUDE_CONFIG_DIR: root,
    DISABLE_AUTOUPDATER: '1'
  }
}

export function loginEnvironment(root: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase()))),
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    ...(process.platform === 'win32' && /^[a-z]:\\/i.test(root)
      ? { HOMEDRIVE: parse(root).root.slice(0, 2), HOMEPATH: root.slice(2) } : {}),
    XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_STATE_HOME: root,
    TEMP: root, TMP: root, TMPDIR: root, ...extra
  }
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === ''
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

export async function safeLoginRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Unsafe login directory')
  const actual = await realpath(path)
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(actual)) throw new Error('Unsafe login directory')
  for (const name of ['.t3', '.codex', '.claude', '.gemini']) {
    const native = join(homedir(), name)
    const canonical = await realpath(native).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return native
      throw error
    })
    if (within(native, actual) || within(canonical, actual)) throw new Error('Unsafe login directory')
  }
  return actual
}

export async function loginProfilesRoot(userData: string): Promise<string> {
  if (!isAbsolute(userData) || (process.platform === 'win32' && !/^[a-z]:\\/i.test(resolve(userData)))) {
    throw new Error('Unsafe login directory')
  }
  const root = join(await safeLoginRoot(userData), 'profiles')
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  if (!(await lstat(root)).isDirectory() || !samePath(root, await realpath(root))) throw new Error('Unsafe login directory')
  return root
}

export async function readLoginCredential(root: string, filename: string): Promise<string> {
  const path = join(root, filename)
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || !samePath(path, await realpath(path))) {
    throw new Error('Unsafe credential file')
  }
  return readFile(path, 'utf8')
}

export async function terminateLoginProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    const stillRunning = () => child.exitCode === null && child.signalCode === null
    await killWindowsTree(pid, stillRunning).catch(() => {})
    if (stillRunning()) child.kill('SIGKILL')
  } else {
    // Login children are spawned in a private process group.
    try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(done => {
    const timer = setTimeout(finish, 2_000)
    function finish() { clearTimeout(timer); child.off('exit', finish); done() }
    child.once('exit', finish)
  })
}

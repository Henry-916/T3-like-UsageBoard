import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { DiscoveredAccount } from '../../shared/types'
import { writeFileAtomic } from '../jsonFile'
import { cliToken } from '../limits/probes/agyRenewal'
import { antigravityTokenKey, type AntigravityTokenCache } from '../limits/antigravityTokenCache'
import { credentialEmail, field } from './identities'
import type { WindowsCredential } from './windowsCredentials'

type Provider = 'codex' | 'antigravity'
type Restart = () => Promise<void>
type Prepared = {
  original: Buffer
  apply(): Promise<void>
  restore(): Promise<void>
  prune?(): Promise<void>
}

export class SwitchRollbackError extends Error {
  constructor() {
    super('切换失败，且无法恢复原凭证或项目缓存。请停止操作并使用备份恢复。')
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function decode(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function email(provider: Provider, bytes: Buffer): string | undefined {
  const parsed: unknown = JSON.parse(decode(bytes))
  if (provider === 'antigravity' && !cliToken.safeParse(parsed).success) return undefined
  return credentialEmail(provider, parsed)
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('Unexpected file type')
    return await readFile(path)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** Refuse T3 even when a parent directory resolves through a junction. */
export async function assertSwitchPath(path: string, home = homedir()): Promise<void> {
  const t3 = join(home, '.t3')
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const inside = (root: string, candidate: string) => {
    const child = relative(normalize(root), normalize(candidate))
    return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }
  if (!isAbsolute(path) || inside(t3, path)) throw new Error('默认路径不安全，未切换账号。')
  const t3Real = await realpath(t3).catch(error => { if (missing(error)) return t3; throw error })
  let existing = path
  while (true) {
    try {
      const physical = await realpath(existing)
      if (inside(t3, physical) || inside(t3Real, physical)) throw new Error('默认路径不安全，未切换账号。')
      return
    } catch (error) {
      if (!missing(error) || dirname(existing) === existing) throw error
      existing = dirname(existing)
    }
  }
}

export async function runAccountSwitch(options: {
  provider: Provider
  target: Buffer
  expectedEmail: string
  stop(): Promise<Restart>
  prepare(target: Buffer): Promise<Prepared>
  snapshot(text: string): Promise<void>
}): Promise<void> {
  const { provider, target, expectedEmail, stop, prepare, snapshot } = options
  let restart: Restart | undefined
  let prepared: Prepared | undefined
  let attemptedWrite = false
  let phase: 'stop' | 'snapshot' | 'write' | 'restart' = 'stop'
  try {
    if (email(provider, target) !== expectedEmail) throw new Error('Target identity changed')
    restart = await stop()
    phase = 'snapshot'
    prepared = await prepare(target)
    const originalEmail = email(provider, prepared.original)
    if (!originalEmail || originalEmail === expectedEmail) throw new Error('Original identity unavailable or already active')
    await snapshot(decode(prepared.original))
    phase = 'write'
    attemptedWrite = true
    await prepared.apply()
    phase = 'restart'
    await restart()
    await prepared.prune?.().catch(() => undefined)
  } catch {
    if (attemptedWrite && prepared) {
      try { await prepared.restore() } catch {
        throw new SwitchRollbackError()
      }
      await prepared.prune?.().catch(() => undefined)
    }
    if (restart) await restart().catch(() => undefined)
    if (phase === 'restart') throw new Error('应用未能重启，已恢复原账号。')
    if (phase === 'write') throw new Error('无法写入新凭证，已恢复原账号。')
    if (phase === 'snapshot') throw new Error('无法确认或备份当前账号，未切换。')
    throw new Error('无法验证目标凭证或关闭对应应用，未切换。')
  }
}

export async function prepareCodexSwitch(file: string, target: Buffer): Promise<Prepared> {
  const original = await readOptional(file)
  if (!original) throw new Error('Missing default credential')
  const prefix = `${basename(file)}.bak-usageboard-`
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(dirname(file), `${prefix}${stamp}-${randomUUID()}`)
  let attempted = false
  return {
    original,
    async apply() {
      await writeFileAtomic(backup, original)
      if (!(await readOptional(file))?.equals(original)) throw new Error('Default credential changed')
      attempted = true
      await writeFileAtomic(file, target)
    },
    async restore() {
      if (!attempted) return
      const observed = await readOptional(file)
      if (observed?.equals(original)) return
      if (observed && !observed.equals(target)) throw new Error('Default credential changed')
      await writeFileAtomic(file, original)
    },
    async prune() {
      const backups = (await readdir(dirname(file), { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.startsWith(prefix)).map(entry => entry.name).sort().reverse()
      await Promise.all(backups.slice(3).map(name => rm(join(dirname(file), name))))
    }
  }
}

export async function prepareAntigravitySwitch(
  target: Buffer, cacheFiles: string[],
  read: () => Promise<WindowsCredential | undefined>,
  compareWrite: (expected: Buffer, next: Buffer) => Promise<boolean>,
  write: (value: WindowsCredential) => Promise<void>
): Promise<Prepared> {
  const before = await read()
  if (!before) throw new Error('Missing Windows credential')
  const cache = await Promise.all(cacheFiles.map(async file => [file, await readOptional(file)] as const))
  let attempted = false
  const removed: Array<readonly [string, Buffer]> = []
  return {
    original: before.blob,
    async apply() {
      attempted = true
      if (!await compareWrite(before.blob, target)) {
        attempted = false
        throw new Error('Windows credential changed')
      }
      for (const [file, bytes] of cache) {
        if (!bytes) continue
        if (!(await readOptional(file))?.equals(bytes)) throw new Error('Project cache changed')
        await rm(file)
        removed.push([file, bytes])
      }
    },
    async restore() {
      const results = await Promise.allSettled([
        (async () => {
          if (!attempted) return
          const seen = await read()
          if (seen?.blob.equals(before.blob)) return
          if (seen && !seen.blob.equals(target)) throw new Error('Windows credential changed')
          await write(before)
        })(),
        ...removed.map(([file, bytes]) => writeFileAtomic(file, bytes))
      ])
      if (results.some(result => result.status === 'rejected')) throw new Error('Rollback incomplete')
    }
  }
}

export async function readSwitchTarget(
  source: DiscoveredAccount, readCredential: (file: string) => Promise<unknown>,
  tokenCache?: Pick<AntigravityTokenCache, 'getEntry'>
): Promise<Buffer> {
  const file = source.credentialPaths?.[0]
  if (!file) throw new Error('找不到可用于切换的凭证。')
  // This may read T3 credentials, but never writes or launches a CLI there.
  const parsed = await readCredential(file)
  const tokens = field(parsed, 'tokens')
  const codex = source.provider === 'codex' && ['access_token', 'refresh_token'].some(key => {
    const value = field(tokens, key)
    return typeof value === 'string' && !!value.trim()
  })
  const antigravity = source.provider === 'antigravity' ? cliToken.safeParse(parsed) : undefined
  if (codex || antigravity?.success) {
    let target = parsed
    const original = antigravity?.success ? antigravity.data.token : undefined
    if (antigravity?.success && original?.refresh_token && tokenCache) {
      const latest = await tokenCache.getEntry(await antigravityTokenKey(file, original.refresh_token))
      const expiry = Date.parse(original.expiry ?? '')
      if (latest && ((latest.refreshToken && latest.refreshToken !== original.refresh_token)
        || !Number.isFinite(expiry) || Date.parse(latest.expiry) > expiry)) {
        target = { ...antigravity.data, token: {
          ...original, access_token: latest.accessToken, refresh_token: latest.refreshToken ?? original.refresh_token,
          expiry: latest.expiry
        } }
      }
    }
    const bytes = Buffer.from(JSON.stringify(target), 'utf8')
    if (bytes.byteLength <= 512 * 1024) return bytes
  }
  throw new Error('目标凭证格式无效。')
}

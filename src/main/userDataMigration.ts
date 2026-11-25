import { copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'

const skipped = new Set(['cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache',
  'dawnwebgpucache', 'grshadercache', 'shadercache', 'blob_storage', 'crashpad',
  'lockfile', 'singletonlock', 'singletoncookie', 'singletonsocket', 'lock'])

function stat(path: string) {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function atomicCopy(source: string, destination: string, data?: string): void {
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    if (data === undefined) copyFileSync(source, temporary)
    else writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function copyDirectory(oldDir: string, newDir: string, root = true): void {
  const target = stat(newDir)
  if (target && !target.isDirectory()) throw new Error('Invalid userData migration destination')
  mkdirSync(newDir, { recursive: true })
  for (const entry of readdirSync(oldDir, { withFileTypes: true })) {
    if (skipped.has(entry.name.toLowerCase()) || (root && entry.name.toLowerCase() === 'config.json')) continue
    const from = join(oldDir, entry.name)
    const to = join(newDir, entry.name)
    if (entry.isDirectory()) copyDirectory(from, to, false)
    else if (entry.isFile()) atomicCopy(from, to)
  }
}

function migratedConfig(source: string, oldDir: string, newDir: string): string | undefined {
  let config: { accounts?: unknown }
  try { config = JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
    if (error instanceof SyntaxError) return undefined // Copy malformed legacy data unchanged.
    throw error
  }
  if (!config || !Array.isArray(config.accounts)) return undefined
  let changed = false
  for (const account of config.accounts) {
    if (!account || typeof account !== 'object') continue
    for (const key of ['dataDir', 'credentialPath']) {
      const path: unknown = account[key]
      if (typeof path !== 'string' || !isAbsolute(path)) continue
      const suffix = relative(oldDir, path)
      if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) continue
      account[key] = join(newDir, suffix)
      changed = true
    }
  }
  return changed ? JSON.stringify(config) : undefined
}

/** Run synchronously before Chromium or safeStorage opens the new profile. */
export function migrateUserData(oldDir: string, newDir: string): boolean {
  const config = join(newDir, 'config.json')
  const marker = join(newDir, '.legacy-profile-copied')
  if (stat(config) || stat(marker) || !stat(oldDir)?.isDirectory()) return false
  copyDirectory(oldDir, newDir)
  const source = join(oldDir, 'config.json')
  if (stat(source)?.isFile()) atomicCopy(source, config, migratedConfig(source, oldDir, newDir))
  else writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
  return true
}

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UsageProviderKind } from '../../shared/types'

export const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const email = value.trim().toLowerCase()
  return email.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email) ? email : undefined
}

export function credentialEmail(provider: UsageProviderKind, value: unknown): string | undefined {
  if (provider === 'antigravity') return normalizeEmail(field(value, 'id_token_email'))
  if (provider === 'claude') return normalizeEmail(field(field(value, 'oauthAccount'), 'emailAddress'))
    ?? normalizeEmail(field(field(value, 'claudeAiOauth'), 'emailAddress'))
  if (provider !== 'codex') return undefined
  const jwt = field(field(value, 'tokens'), 'id_token')
  if (typeof jwt !== 'string') return undefined
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as unknown
    return normalizeEmail(field(payload, 'email')) ?? normalizeEmail(field(field(payload, 'https://api.openai.com/profile'), 'email'))
  } catch { return undefined }
}

export const identityKey = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

export function createIdentityStore(userData: string) {
  const path = join(userData, 'identities.json')
  const records = readFile(path, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined)
  const values = records.then(data => new Map(
    data && typeof data === 'object' ? Object.entries(data).flatMap(([key, value]) => {
      const email = normalizeEmail(value)
      return /^[a-f0-9]{64}$/.test(key) && email ? [[key, email] as const] : []
    }) : []
  ))
  let queue = Promise.resolve()
  return {
    get: async (key: string) => (await values).get(key),
    set(key: string, email: string): Promise<void> {
      const task = queue.then(async () => {
        const current = await values
        if (current.get(key) === email) return
        const next = new Map(current).set(key, email)
        const tmp = `${path}.${randomUUID()}.tmp`
        await mkdir(userData, { recursive: true })
        try {
          await writeFile(tmp, JSON.stringify(Object.fromEntries(next)), { mode: 0o600, flag: 'wx' })
          await rename(tmp, path)
          current.set(key, email)
        } finally { await rm(tmp, { force: true }).catch(() => undefined) }
      })
      queue = task.catch(() => undefined)
      return task
    }
  }
}

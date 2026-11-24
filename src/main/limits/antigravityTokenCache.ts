import { createHash } from 'node:crypto'
import { realpath, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { pathKey } from '../accounts/discovery'
import { writeFileAtomic } from '../jsonFile'

const token = z.object({
  accessToken: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1).optional(),
  expiry: z.string().refine(value => Number.isFinite(Date.parse(value))),
  updatedAt: z.number().nonnegative()
})
const keySchema = z.string().regex(/^[a-f0-9]{64}$/)
const store = z.record(keySchema, token)
const retentionMs = 30 * 86_400_000
export type CachedAntigravityToken = z.infer<typeof token>

export interface AntigravityTokenCache {
  getEntry(key: string): Promise<CachedAntigravityToken | undefined>
  getValid(key: string, now?: number): Promise<CachedAntigravityToken | undefined>
  set(key: string, entry: CachedAntigravityToken): Promise<void>
  invalidate(key: string): Promise<void>
}

export async function antigravityTokenKey(path: string | undefined, refreshToken: string): Promise<string> {
  const source = path ? pathKey(await realpath(path).catch(() => resolve(path))) : 'mem'
  return createHash('sha256').update(`${source}\0${refreshToken}`).digest('hex')
}

export function createAntigravityTokenCache({
  userData, encrypt, decrypt
}: {
  userData?: string
  encrypt?: (text: string) => Buffer | Promise<Buffer>
  decrypt?: (bytes: Buffer) => string | Promise<string>
} = {}): AntigravityTokenCache {
  const entries = new Map<string, CachedAntigravityToken>()
  const file = userData && encrypt && decrypt ? join(userData, 'antigravity-tokens.bin') : undefined
  const ready = (async () => {
    if (!file || !decrypt) return
    try {
      const parsed = store.safeParse(JSON.parse(await decrypt(await readFile(file))))
      if (parsed.success) for (const [key, value] of Object.entries(parsed.data)) entries.set(key, value)
    } catch { /* A missing, unreadable or undecryptable file leaves the cache in memory. */ }
  })()
  let writes = ready

  function update(apply: () => void): Promise<void> {
    writes = writes.then(async () => {
      apply()
      if (!file || !encrypt) return
      try {
        await writeFileAtomic(file, await encrypt(JSON.stringify(Object.fromEntries(entries))))
      } catch { /* Encryption or disk failures must not interrupt quota checks. */ }
    })
    return writes
  }

  async function getEntry(key: string): Promise<CachedAntigravityToken | undefined> {
    await ready
    const value = entries.get(key)
    return value && value.updatedAt >= Date.now() - retentionMs ? { ...value } : undefined
  }

  return {
    getEntry,
    async getValid(key, now = Date.now()) {
      const value = await getEntry(key)
      return value && Date.parse(value.expiry) > now + 60_000 ? value : undefined
    },
    async set(key, entry) {
      const parsed = token.safeParse(entry)
      if (!keySchema.safeParse(key).success || !parsed.success) return
      await update(() => {
        for (const [oldKey, value] of entries) if (value.updatedAt < Date.now() - retentionMs) entries.delete(oldKey)
        entries.set(key, parsed.data)
      })
    },
    invalidate: key => update(() => { entries.delete(key) })
  }
}

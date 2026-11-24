import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { antigravityTokenKey, createAntigravityTokenCache } from '../src/main/limits/antigravityTokenCache'

test('serializes encrypted writes and isolates a replaced source credential', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'usage-cache-test-'))
  const secret = randomBytes(32)
  const encrypt = (text: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secret, iv)
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }
  const decrypt = (bytes: Buffer) => {
    const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()
  }
  try {
    const options = { userData, encrypt, decrypt }
    const cache = createAntigravityTokenCache(options)
    const path = join(userData, 'fixture')
    const key = await antigravityTokenKey(path, 'fixture-source')
    const changed = await antigravityTokenKey(path, 'fixture-replacement')
    const second = await antigravityTokenKey(undefined, 'fixture-source')
    const now = Date.now()
    const entry = {
      accessToken: 'fixture-access', refreshToken: 'fixture-rotated',
      expiry: new Date(now + 180_000).toISOString(), updatedAt: now
    }
    await Promise.all([cache.set(key, entry), cache.set(second, { ...entry, accessToken: 'other-fixture' })])
    const raw = await readFile(join(userData, 'antigravity-tokens.bin'))
    expect(raw.includes(Buffer.from(entry.accessToken))).toBe(false)
    const restarted = createAntigravityTokenCache(options)
    expect(await restarted.getValid(key, now)).toEqual(entry)
    expect(await restarted.getValid(second, now)).toMatchObject({ accessToken: 'other-fixture' })
    expect(await restarted.getValid(changed, now)).toBeUndefined()
    expect(await restarted.getValid(key, now + 120_000)).toBeUndefined()
    expect(await restarted.getEntry(key)).toEqual(entry)
    await restarted.invalidate(key)
    expect(await createAntigravityTokenCache(options).getEntry(key)).toBeUndefined()
  } finally { await rm(userData, { recursive: true, force: true }) }
})

test('encryption failure retains only the in-memory entry', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'usage-cache-fallback-'))
  try {
    const cache = createAntigravityTokenCache({
      userData, encrypt: () => { throw new Error('unavailable') }, decrypt: () => ''
    })
    const key = await antigravityTokenKey(undefined, 'fixture')
    const now = Date.now()
    await cache.set(key, { accessToken: 'fixture', expiry: new Date(now + 120_000).toISOString(), updatedAt: now })
    expect(await cache.getValid(key)).toMatchObject({ accessToken: 'fixture' })
    await expect(readFile(join(userData, 'antigravity-tokens.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(userData, { recursive: true, force: true }) }
})

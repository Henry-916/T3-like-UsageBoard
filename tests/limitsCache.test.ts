import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLimitsCache } from '../src/main/limits/limitsCache'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const reading = (id: string, origin: string) => ({
  id, identity: `codex:${id}`, data: {
    id, provider: 'codex', displayName: `${id}@example.com`, origin,
    windows: [{ id: 'primary', kind: 'session', label: '5-Hour', usedPercent: 20 }],
    checkedAt: '2026-11-24T12:00:00.000Z'
  }
})

describe('limits cache compatibility', () => {
  it('drops legacy T3 entries but keeps native and manual readings', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'limits-cache-'))
    dirs.push(userData)
    await writeFile(join(userData, 'limits-cache.json'), JSON.stringify([
      reading('legacy', 't3'), reading('native', 'native'), reading('manual', 'manual')
    ]))
    const entries = await createLimitsCache(userData).load()
    expect(entries.map(({ id }) => id)).toEqual(['native', 'manual'])
  })
})

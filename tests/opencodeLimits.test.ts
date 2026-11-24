import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { probeOpenCode } from '../src/main/limits/probes/opencode'
import type { DiscoveredAccount } from '../src/shared/types'

const account: DiscoveredAccount = {
  id: 'fake-oc', provider: 'opencode', origin: 'manual', enabled: true, displayName: 'Fake'
}
const resetsAt = '2099-01-01T00:00:00.000Z'

it('uses active SQLite keys before auth.json, without trying inactive or self-hosted keys', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'usage-opencode-fixture-'))
  try {
    const db = new DatabaseSync(join(dataDir, 'opencode.db'))
    try {
      db.exec('CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)')
      const insert = db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)')
      insert.run('1', 'opencode', '{"type":"key","key":"fake-inactive"}', 0, 1)
      insert.run('2', 'opencode', '{"type":"key","key":"fake-self-hosted","metadata":{"server":"https://example.invalid/console"}}', 1, 2)
      insert.run('3', 'opencode-go', '{"type":"key","key":"fake-older"}', null, 3)
      insert.run('4', 'opencode-go', '{"type":"key","key":"fake-stored","metadata":null}', 1, 4)
    } finally {
      db.close()
    }
    const signal = new AbortController().signal
    const attempted: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe('https://opencode.ai/zen/go/v1/usage')
      expect(init).toMatchObject({ signal, redirect: 'error' })
      const auth = new Headers(init?.headers).get('authorization')!
      attempted.push(auth)
      if (auth === 'Bearer fake-stored') return new Response(null, { status: 403 })
      return Response.json({ usage: {
        rolling: { percent: -4, resetsAt },
        weekly: { percent: 25, resetsAt },
        monthly: { percent: 105, resetsAt }
      } })
    })
    const result = await probeOpenCode({ ...account, dataDir, credentialPaths: ['auth.json'] }, {
      fetch, signal,
      readCredential: async () => ({ 'opencode-go': { type: 'api', key: 'fake-auth' } }),
      manualApiKey: 'fake-manual'
    })
    expect(attempted).toEqual(['Bearer fake-stored', 'Bearer fake-auth'])
    expect(result).toEqual({
      kind: 'ok', fingerprint: createHash('sha256').update('opencode-go\0fake-auth').digest('hex'),
      windows: [
        { id: 'go_rolling', kind: 'session', label: 'Go · Session', windowDurationMins: 300, usedPercent: 0, resetsAt },
        { id: 'go_weekly', kind: 'weekly', label: 'Go · Weekly', windowDurationMins: 10080, usedPercent: 25, resetsAt },
        { id: 'go_monthly', kind: 'monthly', label: 'Go · Monthly', windowDurationMins: 43200, usedPercent: 100, resetsAt }
      ]
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

it('distinguishes a non-Go key from failed responses and works with a missing auth.json', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://example.invalid' } }))
    .mockResolvedValueOnce(Response.json({ usage: {} }))
  const readCredential = async (): Promise<unknown> => {
    throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
  }
  const ctx = { fetch, readCredential, signal: new AbortController().signal, manualApiKey: 'fake-manual' }
  const target = { ...account, credentialPaths: ['auth.json'] }
  expect(await probeOpenCode(target, ctx)).toEqual({ kind: 'unsupported' })
  expect(await probeOpenCode(target, ctx)).toEqual({ kind: 'failed' })
  expect(await probeOpenCode(target, ctx)).toEqual({ kind: 'failed' })
  expect(await probeOpenCode(target, ctx)).toEqual({ kind: 'failed' })
  expect(fetch).toHaveBeenCalledTimes(4)
  expect(await probeOpenCode(target, { ...ctx, signal: AbortSignal.abort() })).toEqual({ kind: 'failed' })
  expect(fetch).toHaveBeenCalledTimes(4)
})

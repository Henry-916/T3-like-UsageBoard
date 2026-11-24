import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createLimitsService } from '../src/main/limits/service'
import type { LimitsProbeResult, LimitsReport } from '../src/shared/limitsTypes'
import type { DiscoveredAccount } from '../src/shared/types'

test('deduplicates identities, keeps last-good on failure and removes disabled accounts immediately', async () => {
  const native: DiscoveredAccount = { id: 'native', provider: 'antigravity', displayName: 'Native', enabled: true, origin: 'native' }
  const t3: DiscoveredAccount = { ...native, id: 't3', origin: 't3', displayName: 'T3' }
  const codex: DiscoveredAccount = { ...native, id: 'codex', provider: 'codex', displayName: 'Codex' }
  let discovered = [native, t3, codex]
  let now = Date.parse('2026-11-24T02:00:00Z')
  let offline = false
  let nativeExpired = false
  const ok: LimitsProbeResult = {
    kind: 'ok', fingerprint: 'same-sha256', windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 42 }]
  }
  const probe = async (account: DiscoveredAccount): Promise<LimitsProbeResult> =>
    nativeExpired && account.id === 'native' ? { kind: 'failed', reason: 'expired' } : offline ? { kind: 'failed' } : ok
  const updates: LimitsReport[] = []
  const service = createLimitsService({
    discover: async () => discovered,
    probes: { antigravity: probe, codex: probe, claude: probe, opencode: probe },
    readCredential: async () => undefined, getManualApiKey: async () => undefined,
    onUpdate: data => updates.push(data), now: () => now
  })
  const first = await service.refresh()
  expect(first.accounts.map(a => a.id)).toEqual(['t3', 'codex'])
  expect(updates[0].refreshing).toBe(true)
  nativeExpired = true
  expect((await service.refresh()).issues).toBeUndefined()
  offline = true
  now += 10_000
  const recovered = await service.refresh()
  expect(recovered.accounts).toMatchObject(first.accounts.map(item => ({ id: item.id, stale: true })))
  expect(recovered.checkedAt).not.toEqual(first.checkedAt)
  expect(recovered.issues).toEqual([
    { id: 'native', displayName: 'Native', provider: 'antigravity', origin: 'native', cached: true, reason: 'expired' },
    { id: 't3', displayName: 'T3', provider: 'antigravity', origin: 't3', cached: true, reason: 'failed' },
    { id: 'codex', displayName: 'Codex', provider: 'codex', origin: 'native', cached: true, reason: 'failed' }
  ])
  discovered = [native]
  service.accountsChanged([{ ...native, hasCredential: true }])
  expect(service.get().accounts.map(a => a.id)).toEqual(['native'])
  expect(service.get().issues?.map(issue => issue.id)).toEqual(['native'])
  await service.refresh()
  service.stop()
})

const native: DiscoveredAccount = { id: 'native', provider: 'antigravity', displayName: 'Google', origin: 'native', enabled: true }
const t3: DiscoveredAccount = { ...native, id: 't3', origin: 't3', displayName: 'T3' }
const ok: LimitsProbeResult = {
  kind: 'ok', fingerprint: 'same-account', resetCredits: 1,
  windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 42 }]
}
const unsupported = async () => ({ kind: 'unsupported' } as const)

test('suppresses only issues with a healthy same-provider name or known identity', async () => {
  const sameName: DiscoveredAccount = { ...native, id: 'manual', origin: 'manual' }
  const otherProvider: DiscoveredAccount = { ...native, id: 'codex', provider: 'codex' }
  let fail = false
  let fallback: LimitsProbeResult = { kind: 'failed', reason: 'expired' }
  const service = createLimitsService({
    discover: async () => [native, t3, sameName, otherProvider],
    readCredential: async () => undefined, getManualApiKey: async () => undefined, onUpdate: () => undefined,
    probes: {
      antigravity: async account => account.id === 'manual' ? fallback : account.id === 't3' && fail ? fallback : ok,
      codex: async () => ({ kind: 'failed', reason: 'cli_missing' }), claude: unsupported, opencode: unsupported
    }
  })
  expect((await service.refresh()).issues?.map(issue => issue.id)).toEqual(['codex'])
  fail = true
  expect((await service.refresh()).issues).toEqual([
    { id: 'codex', provider: 'codex', displayName: 'Google', origin: 'native', cached: false, reason: 'cli_missing' }
  ])
  fallback = { kind: 'unsupported' }
  const report = await service.refresh()
  expect(report.issues?.map(issue => issue.id)).toEqual(['codex'])
  expect(report.accounts.map(account => account.id)).toEqual(['native'])
})

test('restores stale readings before probing and persists disabled or removed rows being pruned', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'limits-service-'))
  try {
    const path = join(userData, 'limits-cache.json')
    let discovered = [native, t3]
    let result: LimitsProbeResult = ok
    let now = Date.parse('2026-11-24T02:00:00Z')
    const options = {
      userData, discover: async () => discovered,
      readCredential: async () => undefined, getManualApiKey: async () => undefined,
      onUpdate: () => undefined, now: () => now,
      probes: { antigravity: async () => result, codex: unsupported, claude: unsupported, opencode: unsupported }
    }
    const original = createLimitsService(options)
    await original.refresh()
    now += 10_000
    await original.refresh()
    original.stop()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([
      expect.objectContaining({ id: 'native', identity: 'antigravity:fp:same-account' }),
      expect.objectContaining({ id: 't3', identity: 'antigravity:fp:same-account' })
    ])

    discovered = [native, { ...t3, enabled: false }]
    result = { kind: 'failed', reason: 'expired' }
    const restored = createLimitsService(options)
    await restored.ready
    const account = expect.objectContaining({
      id: 'native', checkedAt: new Date(now).toISOString(), stale: true,
      resetCredits: 1, previous: { checkedAt: new Date(now - 10_000).toISOString(), windows: ok.windows }
    })
    expect(restored.get().accounts).toEqual([account])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([
      { id: 'native', identity: 'antigravity:fp:same-account', data: expect.not.objectContaining({ stale: expect.anything() }) }
    ])
    expect((await restored.refresh()).issues).toEqual([
      { id: 'native', provider: 'antigravity', displayName: 'Google', origin: 'native', cached: true, reason: 'expired' }
    ])
    discovered = []
    restored.accountsChanged([])
    expect(restored.get().accounts).toEqual([])
    expect(restored.get().issues).toBeUndefined()
    await restored.refresh()
    restored.stop()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('a hung probe times out without dropping the other provider', async () => {
  const service = createLimitsService({
    discover: async () => [
      { id: 'slow', displayName: 'Slow', provider: 'claude', enabled: true, origin: 'native' },
      { id: 'okay', displayName: 'Okay', provider: 'opencode', enabled: true, origin: 'native' }
    ],
    readCredential: async () => undefined, getManualApiKey: async () => undefined,
    onUpdate: () => undefined, timeoutMs: 25,
    probes: {
      claude: async () => new Promise(() => undefined),
      antigravity: async () => ({ kind: 'unsupported' }),
      codex: async () => ({ kind: 'unsupported' }),
      opencode: async () => ({ kind: 'ok', windows: [{ id: 'rolling', kind: 'session', label: '5h', usedPercent: 22 }] })
    }
  })
  const report = await service.refresh()
  expect(report.accounts.map(a => a.id)).toEqual(['okay'])
  expect(report.issues).toMatchObject([{ id: 'slow', reason: 'failed', cached: false }])
  service.stop()
})

test('restores stale display-only cache and persists removal across hydration and account changes', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'limits-service-'))
  const path = join(userData, 'limits-cache.json')
  const native: DiscoveredAccount = { id: 'native', provider: 'antigravity', displayName: 'Native', enabled: true, origin: 'native' }
  const second: DiscoveredAccount = { ...native, id: 'second', displayName: 'Second' }
  let discovered = [native, second]
  const probe = async (): Promise<LimitsProbeResult> => ({
    kind: 'ok', windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 42 }]
  })
  const create = (onUpdate: (report: LimitsReport) => void = () => undefined) => createLimitsService({
    userData, onUpdate, discover: async () => discovered,
    probes: { antigravity: probe, claude: probe, codex: probe, opencode: probe },
    readCredential: async () => undefined, getManualApiKey: async () => undefined
  })
  try {
    const initial = create()
    await initial.refresh()
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    expect(persisted).toHaveLength(2)
    expect(persisted[0].data).not.toHaveProperty('stale')
    persisted[0].data.credentialPath = 'do-not-retain'
    await writeFile(path, JSON.stringify([...persisted, { id: 'invalid' }]))

    discovered = [{ ...native, displayName: 'Renamed' }, { ...second, enabled: false }]
    const updates: LimitsReport[] = []
    const restored = create(report => updates.push(report))
    await restored.ready
    expect(restored.get().accounts).toMatchObject([{ id: 'native', displayName: 'Renamed', stale: true }])
    expect(updates.flatMap(report => report.accounts.map(account => account.id))).toEqual(['native'])
    const pruned = JSON.parse(await readFile(path, 'utf8'))
    expect(pruned).toHaveLength(1)
    expect(pruned[0].data).not.toHaveProperty('credentialPath')

    discovered = []
    restored.accountsChanged([])
    expect(restored.get().accounts).toEqual([])
    await restored.refresh()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

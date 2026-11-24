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
  const ok: LimitsProbeResult = {
    kind: 'ok', fingerprint: 'same-sha256', windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 42 }]
  }
  const probe = async (): Promise<LimitsProbeResult> => offline ? { kind: 'failed' } : ok
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
  offline = true
  now += 10_000
  const recovered = await service.refresh()
  expect(recovered.accounts).toMatchObject(first.accounts.map(item => ({ ...item, stale: true })))
  expect(recovered.checkedAt).not.toEqual(first.checkedAt)
  discovered = [native]
  service.accountsChanged([{ ...native, hasCredential: true }])
  expect(service.get().accounts.map(a => a.id)).toEqual(['native'])
  await service.refresh()
  service.stop()
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
  expect((await service.refresh()).accounts.map(a => a.id)).toEqual(['okay'])
  service.stop()
})

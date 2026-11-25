import { describe, expect, it } from 'vitest'
import type { LimitAccountReading } from '../src/shared/limitsTypes'
import { trayGroups, trayWindowLabel } from '../src/renderer/trayPresentation'

const now = Date.parse('2025-01-01T12:00:00Z')
const session = { kind: 'session', id: 'primary', label: 'Session', usedPercent: 41,
  resetsAt: '2025-01-01T14:52:00Z', windowDurationMins: 300 } as const
const weekly = { kind: 'weekly', id: 'secondary', label: 'Weekly', usedPercent: 100,
  resetsAt: '2025-01-03T12:00:00Z', windowDurationMins: 10080 } as const
const codex: LimitAccountReading = { provider: 'codex', id: 'codex-a', displayName: 'codex@example.com',
  current: true, origin: 'native', windows: [session, weekly], stale: false, checkedAt: new Date(now).toISOString() }

describe('tray quota presentation', () => {
  it('retains the account email and current marker, and hides excluded providers', () => {
    const claude: LimitAccountReading = { ...codex, id: 'claude-a', provider: 'claude', displayName: 'claude@example.com' }
    const [group, ...other] = trayGroups([codex, claude], new Set(['claude']), now)
    expect(other).toEqual([])
    expect(group.provider).toBe('codex')
    expect(group.accounts[0].account).toMatchObject({ displayName: 'codex@example.com', current: true })
  })

  it('uses the same effective exhausted weekly gate as the main panel', () => {
    const [group] = trayGroups([codex], new Set(), now)
    const { window, reading } = group.accounts[0].windows[0]
    expect(window.kind).toBe('session')
    expect(reading).toMatchObject({ remainingPercent: 0, resetsAt: weekly.resetsAt })
  })

  it('shortens known tray labels without discarding family distinctions', () => {
    expect(trayWindowLabel({ provider: 'antigravity', kind: 'session', label: 'Gemini · 5-hour' })).toBe('Gemini 5h')
    expect(trayWindowLabel({ provider: 'antigravity', kind: 'weekly', label: 'Gemini Carbon · Weekly' })).toBe('Gemini Carbon 周')
    expect(trayWindowLabel({ provider: 'antigravity', kind: 'weekly', label: 'Claude & GPT (shared) · Weekly' })).toBe('Claude&GPT 周')
    expect(trayWindowLabel({ provider: 'opencode', kind: 'session', label: 'Go · Session' })).toBe('Go Session')
  })
})

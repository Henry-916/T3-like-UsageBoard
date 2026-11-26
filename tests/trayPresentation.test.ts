import { describe, expect, it } from 'vitest'
import type { LimitAccountReading } from '../src/shared/limitsTypes'
import { trayGroups, trayQuotaTooltip, trayResetTime, trayWindowLabel } from '../src/renderer/trayPresentation'

const now = Date.parse('2025-01-01T12:00:00Z')
const session = { kind: 'session', id: 'primary', label: '5-Hour', usedPercent: 41,
  resetsAt: '2025-01-01T14:52:00Z', windowDurationMins: 300 } as const
const weekly = { kind: 'weekly', id: 'secondary', label: 'Weekly', usedPercent: 100,
  resetsAt: '2025-01-03T12:00:00Z', windowDurationMins: 10080 } as const
const codex: LimitAccountReading = { provider: 'codex', id: 'codex-a', displayName: 'codex@example.com',
  current: true, origin: 'native', windows: [session, weekly], stale: false, checkedAt: new Date(now).toISOString() }

const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month, day, hour, minute).toISOString()

describe('tray quota presentation', () => {
  it('retains the account email and current marker, and hides excluded providers', () => {
    const claude: LimitAccountReading = { ...codex, id: 'claude-a', provider: 'claude', displayName: 'claude@example.com' }
    const [group, ...other] = trayGroups([codex, claude], new Set(['claude']), now)
    expect(other).toEqual([])
    expect(group.provider).toBe('codex')
    expect(group.accounts[0].account).toMatchObject({ displayName: 'codex@example.com', current: true })
  })

  it('puts the current account first inside its provider group', () => {
    const other: LimitAccountReading = { ...codex, id: 'codex-b', displayName: 'a@example.com', current: false }
    const [group] = trayGroups([other, codex], new Set(), now)
    expect(group.accounts.map(({ account }) => account.id)).toEqual(['codex-a', 'codex-b'])
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

describe('tray reset times', () => {
  const base = new Date(2025, 0, 1, 12, 0).getTime()

  it('uses an absolute local clock, weekday or date depending on distance', () => {
    expect(trayResetTime(undefined, base)).toBeNull()
    expect(trayResetTime('not-a-date', base)).toBeNull()
    expect(trayResetTime(local(2025, 0, 1, 11, 0), base)).toBe('即将重置')
    expect(trayResetTime(local(2025, 0, 1, 17, 23), base)).toBe('17:23')
    expect(trayResetTime(local(2025, 0, 3, 17, 23), base)).toBe('周五17:23')
    expect(trayResetTime(local(2025, 0, 11, 17, 23), base)).toBe('1/11 17:23')
  })

  it('builds a single-line remaining and pace hint, appending a cache marker', () => {
    const at = local(2025, 0, 1, 13, 34)
    expect(trayQuotaTooltip({ resetsAt: at, stale: false }, base, 68)).toBe('还需 1 小时 34 分 · 匀速应剩 68%')
    expect(trayQuotaTooltip({ resetsAt: at, stale: true }, base, 68)).toBe('还需 1 小时 34 分 · 匀速应剩 68% · 缓存')
    expect(trayQuotaTooltip({ resetsAt: local(2025, 0, 4, 4, 0), stale: false }, base)).toBe('还需 2 天 16 小时')
    expect(trayQuotaTooltip({ resetsAt: local(2025, 0, 1, 11, 0), stale: false }, base, 40)).toBe('即将重置')
    expect(trayQuotaTooltip({ resetsAt: undefined, stale: false }, base, 40)).toBeNull()
  })
})

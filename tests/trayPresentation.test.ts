import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LimitAccountReading } from '../src/shared/limitsTypes'
import {
  trayCreditTooltip, trayGroups, trayPercentTooltip, trayQuotaTooltip, trayResetTime, trayResetTooltip, trayWindowLabel
} from '../src/renderer/trayPresentation'
import { TrayPanel } from '../src/renderer/components/TrayPanel'

const trayState = vi.hoisted(() => ({ seedPreferences: false }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useState(initial: unknown) {
      // SSR skips preference loading; seed the first null state with no hidden providers.
      if (trayState.seedPreferences && initial === null) {
        trayState.seedPreferences = false
        return react.useState([])
      }
      return react.useState(initial)
    }
  }
})

vi.mock('../src/renderer/hooks/useLimitsData', () => ({
  useLimitsData: () => ({
    loading: false,
    refreshing: false,
    failed: false,
    refresh: vi.fn(),
    report: {
      checkedAt: new Date(now).toISOString(),
      refreshing: false,
      accounts: [
        { ...codex, windows: [{ ...session, usedPercent: 9 }], resetCredits: 2 },
        {
          ...codex, provider: 'opencode', id: 'opencode-a', displayName: 'opencode@example.com',
          windows: [{ kind: 'session', id: 'go-session', label: 'Go · Session', usedPercent: 0 }]
        }
      ]
    }
  })
}))

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

describe('tray reset times and per-element tooltips', () => {
  const base = new Date(2025, 0, 1, 12, 0).getTime()

  it('uses an absolute local clock, weekday or date depending on distance', () => {
    expect(trayResetTime(undefined, base)).toBeNull()
    expect(trayResetTime('not-a-date', base)).toBeNull()
    expect(trayResetTime(local(2025, 0, 1, 11, 0), base)).toBe('即将重置')
    expect(trayResetTime(local(2025, 0, 1, 17, 23), base)).toBe('17:23')
    expect(trayResetTime(local(2025, 0, 3, 17, 23), base)).toBe('周五17:23')
    expect(trayResetTime(local(2025, 0, 8, 17, 23), base)).toBe('周三17:23')
    expect(trayResetTime(local(2025, 0, 11, 17, 23), base)).toBe('1/11 17:23')
  })

  it('shows MM月DD日 周XHH:MM tooltip only when reset text is in weekday range', () => {
    expect(trayResetTooltip(local(2025, 0, 3, 17, 23), base)).toBe('01月03日 周五17:23')
    expect(trayResetTooltip(local(2025, 0, 8, 17, 23), base)).toBe('01月08日 周三17:23')
    expect(trayResetTooltip(local(2026, 10, 28, 15, 34), new Date(2026, 10, 26, 11, 0).getTime()))
      .toBe('11月28日 周六15:34')
    expect(trayResetTooltip(local(2025, 0, 1, 17, 23), base)).toBeNull()
    expect(trayResetTooltip(local(2025, 0, 1, 11, 0), base)).toBeNull()
    expect(trayResetTooltip(local(2025, 0, 11, 17, 23), base)).toBeNull()
    expect(trayResetTooltip(undefined, base)).toBeNull()
    expect(trayResetTooltip('invalid', base)).toBeNull()
  })

  it('builds track, percent and credit tooltips including unstarted 100% windows', () => {
    const at = local(2025, 0, 1, 13, 34)
    expect(trayQuotaTooltip({ remainingPercent: 59, resetsAt: at, stale: false }, base, 68))
      .toBe('匀速应剩 68% · 还需 1 小时 34 分')
    expect(trayQuotaTooltip({ remainingPercent: 59, resetsAt: at, stale: true }, base, 68))
      .toBe('匀速应剩 68% · 还需 1 小时 34 分 · 缓存')
    expect(trayQuotaTooltip({ remainingPercent: 40, resetsAt: local(2025, 0, 4, 4, 0), stale: false }, base))
      .toBe('还需 2 天 16 小时')
    expect(trayQuotaTooltip({ remainingPercent: 40, resetsAt: local(2025, 0, 1, 11, 0), stale: false }, base, 40))
      .toBe('即将重置')
    expect(trayQuotaTooltip({ remainingPercent: 100, resetsAt: undefined, stale: false }, base, null))
      .toBe('剩余 100% · 尚未开始计时')
    expect(trayQuotaTooltip({ remainingPercent: 100, resetsAt: undefined, stale: true }, base, null))
      .toBe('剩余 100% · 尚未开始计时 · 缓存')

    expect(trayPercentTooltip({ remainingPercent: 91.4, stale: false })).toBe('剩余 91.4%')
    expect(trayPercentTooltip({ remainingPercent: 100, stale: true })).toBe('剩余 100% · 缓存')
    expect(trayCreditTooltip(2)).toBe('2 张重置券 · 可在主面板使用')
    expect(trayCreditTooltip(0)).toBeNull()
  })

  it('exposes tray quota details and full labels without adding focus stops', () => {
    trayState.seedPreferences = true
    const html = renderToStaticMarkup(createElement(TrayPanel))

    expect(html).toContain('<span class="tray-ellipsis tray-quota-label">5-Hour</span>')
    expect(html).toContain('<span class="sr-only">Go · Session</span><span aria-hidden="true">Go Session</span>')
    expect(html).toMatch(/<span class="tray-track"[^>]*><span class="sr-only">剩余 100% · 尚未开始计时<\/span>/)
    expect(html).not.toContain(' title="')
    expect(html).not.toMatch(/class="(?:tray-quota|tray-ellipsis tray-quota-label|tray-track)"[^>]*(?:aria-label|tabindex)=/i)
  })
})

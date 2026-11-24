import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LimitsView } from '../src/renderer/components/LimitsView'
import {
  limitIssueText, limitTimeLeft, resetBadgeDuration, resetCreditText, resetDetailTime, visibleLimitIssues
} from '../src/renderer/limitsPresentation'
import type { LimitAccountIssue, LimitsReport } from '../src/shared/limitsTypes'
import type { UsageProviderKind } from '../src/shared/types'

const expired: LimitAccountIssue = {
  id: 'agy-1', provider: 'antigravity', displayName: '工作账号', origin: 't3',
  reason: 'expired', cached: false
}
const missingCli: LimitAccountIssue = {
  ...expired, id: 'agy-2', displayName: '备用账号', reason: 'cli_missing'
}
const failed: LimitAccountIssue = {
  id: 'codex-1', provider: 'codex', displayName: '本地账号', origin: 'native',
  reason: 'failed', cached: false
}
const report: LimitsReport = {
  accounts: [], issues: [expired, missingCli, failed], checkedAt: null, refreshing: false
}

function renderView(props: Partial<ComponentProps<typeof LimitsView>> = {}) {
  return renderToStaticMarkup(createElement(LimitsView, {
    report, hiddenProviders: new Set<UsageProviderKind>(), loading: false, refreshing: false, failed: false,
    onRefresh: () => {}, onReport: () => {}, ...props
  }))
}

const hide = (...providers: UsageProviderKind[]) => new Set(providers)
const fixedNow = new Date(2026, 10, 24, 10, 57).getTime()
const after = (minutes: number, now = fixedNow) => new Date(now + minutes * 60_000).toISOString()

describe('limit issue presentation', () => {
  it('keeps report order while filtering all hidden providers', () => {
    expect(visibleLimitIssues(report.issues, hide())).toEqual([expired, missingCli, failed])
    expect(visibleLimitIssues(report.issues, hide('codex', 'claude'))).toEqual([expired, missingCli])
    expect(visibleLimitIssues(report.issues, hide('codex', 'claude', 'antigravity', 'opencode'))).toEqual([])
    expect(visibleLimitIssues(undefined, hide())).toEqual([])
  })

  it('explains expired credentials, the missing CLI and whether a failed read has cached data', () => {
    expect(limitIssueText(expired)).toBe('「工作账号」登录凭证已过期，请在 Antigravity 中重新登录后重试')
    expect(limitIssueText(missingCli)).toBe('「备用账号」登录凭证已过期，未找到可用的 agy CLI')
    expect(limitIssueText(failed)).toBe('「本地账号」无法读取额度')
    expect(limitIssueText({ ...failed, cached: true })).toBe('「本地账号」刷新失败，当前显示缓存数据')
  })
})

describe('limit timing presentation', () => {
  it('formats badges, clamps positive sub-minute values and handles missing or elapsed times', () => {
    expect(resetBadgeDuration(after(5 * 1440 + 23 * 60), fixedNow)).toBe('↻ 5 天 23 小时')
    expect(resetBadgeDuration(after(3 * 60 + 19), fixedNow)).toBe('↻ 3 小时 19 分钟')
    expect(resetBadgeDuration(after(60), fixedNow)).toBe('↻ 1 小时 0 分钟')
    expect(resetBadgeDuration(after(2), fixedNow)).toBe('↻ 2 分钟')
    expect(resetBadgeDuration(after(0.5), fixedNow)).toBe('↻ 1 分钟')
    expect(resetBadgeDuration(after(0), fixedNow)).toBe('即将重置')
    expect(resetBadgeDuration(undefined, fixedNow)).toBeNull()
    expect(resetBadgeDuration('invalid', fixedNow)).toBeNull()
  })

  it('uses local dates and clock times, including cross-day and elapsed resets', () => {
    expect(resetDetailTime(after(199), fixedNow)).toBe('14:16 · 还需 3 小时 19 分钟')
    expect(resetDetailTime(after(1440), fixedNow)).toBe('11月25日 10:57 · 还需 1 天 0 小时')
    expect(resetDetailTime(after(-1), fixedNow)).toBe('10:56 · 即将重置')
    expect(resetDetailTime(undefined, fixedNow)).toBeNull()
  })

  it('formats the first credit expiry without a reset icon', () => {
    expect(resetCreditText(2, after(7 * 1440 + 19 * 60), fixedNow)).toBe('已存 2 个 · 7 天 19 小时后过期')
    expect(resetCreditText(2, undefined, fixedNow)).toBe('已存 2 个')
    expect(resetCreditText(2, 'invalid', fixedNow)).toBe('已存 2 个')
    expect(resetCreditText(1, after(-20), fixedNow)).toBe('已存 1 个 · 已到期')
  })

  it('computes remaining time as a percent of duration only for valid upcoming resets', () => {
    const window = { resetStatus: 'upcoming', resetsAt: after(199), windowDurationMins: 300 } as const
    expect(limitTimeLeft(window, fixedNow)).toBeCloseTo(66.33)
    expect(limitTimeLeft({ ...window, resetsAt: after(400) }, fixedNow)).toBe(100)
    expect(limitTimeLeft({ ...window, resetsAt: after(-1) }, fixedNow)).toBe(0)
    expect(limitTimeLeft({ ...window, resetStatus: 'passed' }, fixedNow)).toBeNull()
    expect(limitTimeLeft({ ...window, windowDurationMins: 0 }, fixedNow)).toBeNull()
    expect(limitTimeLeft({ ...window, windowDurationMins: Infinity }, fixedNow)).toBeNull()
    expect(limitTimeLeft({ ...window, resetsAt: 'invalid' }, fixedNow)).toBeNull()
  })
})

describe('LimitsView account notices', () => {
  it('shows filtered issue messages in one polite status with a shared retry, not an empty state', () => {
    const html = renderView({ hiddenProviders: hide('codex', 'claude') })
    expect(html).toContain('limit-warning-alert')
    expect(html).toMatch(/role="status"[^>]*><ul/)
    expect(html).toContain(limitIssueText(expired))
    expect(html).toContain(limitIssueText(missingCli))
    expect(html).not.toContain(limitIssueText(failed))
    expect(html.match(/>重试<\/button>/g)).toHaveLength(1)
    expect(html).not.toContain('暂无可用额度')
  })

  it('shows only the common failure notice when the IPC request fails', () => {
    const html = renderView({ failed: true })
    expect(html).toContain('role="alert"')
    expect(html).toContain('无法读取额度。')
    expect(html).not.toContain(limitIssueText(expired))
    expect(html.match(/>重试<\/button>/g)).toHaveLength(1)
    expect(html).not.toContain('暂无可用额度')
  })

  it('shows an empty state only if there is no visible data or issue and no pending refresh', () => {
    expect(renderView({ hiddenProviders: hide('codex', 'antigravity') })).toContain('暂无可用额度')
    expect(renderView({ report: { ...report, issues: undefined } })).toContain('暂无可用额度')
    expect(renderView({ hiddenProviders: hide('codex', 'antigravity'), loading: true })).not.toContain('暂无可用额度')
    expect(renderView({ refreshing: true })).toMatch(/<button[^>]+disabled=""[^>]*>重试<\/button>/)
  })

  it('keeps quota cards visible alongside notices', () => {
    const html = renderView({
      report: {
        ...report,
        accounts: [{
          id: failed.id, provider: failed.provider, displayName: failed.displayName, origin: failed.origin,
          windows: [{ id: 'session', label: '5 小时额度', kind: 'session', usedPercent: 30 }],
          checkedAt: '2026-11-24T12:00:00Z', stale: true
        }],
        issues: [{ ...failed, cached: true }]
      }
    })
    expect(html).toContain('刷新失败，当前显示缓存数据')
    expect(html).toContain('5 小时额度')
    expect(html).toContain('70%')
    expect(html.indexOf('limit-window')).toBeLessThan(html.indexOf('limit-warning-alert'))
  })
})

describe('LimitsView segments', () => {
  const window = {
    id: 'session', label: 'Session', kind: 'session', usedPercent: 45,
    windowDurationMins: 300, resetsAt: after(199)
  } as const
  const codex = {
    id: 'codex-1', displayName: '原生 Codex', provider: 'codex', origin: 'native',
    stale: true, checkedAt: after(0), resetCredits: 2, windows: [window]
  } as const
  const agy = { ...codex, id: 'agy-1', displayName: '工作 Antigravity', provider: 'antigravity' } as const

  it('keeps one shared layer, hides repeated single-account text and shows only Codex credits', () => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    try {
      const html = renderView({ report: { ...report, accounts: [
        { ...codex, windows: [window] }, { ...agy, windows: [window] },
        { ...agy, id: 'agy-2', displayName: '备用 Antigravity', windows: [{ ...window, usedPercent: 0 }] }
      ] } })
      expect(html.match(/popover="auto"/g)).toHaveLength(1)
      expect(html.match(/class="limit-account-name"/g)).toHaveLength(2)
      expect(html).not.toContain('class="limit-account-name">原生 Codex')
      expect(html).toContain('class="limit-account-name">工作 Antigravity')
      expect(html.match(/class="limit-recovery"/g)).toHaveLength(1)
      expect(html.match(/class="limit-badge-credit"/g)).toHaveLength(1)
      expect(html).toContain('↻ 3 小时 19 分钟')
      expect(html).toContain('grid-template-columns:repeat(2, minmax(0, 1fr))')
      expect(html).not.toContain('确认使用')
    } finally {
      vi.useRealTimers()
    }
  })
})

import { createElement, createRef, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LimitDetails, LimitIssueGuide, LimitsView } from '../src/renderer/components/LimitsView'
import {
  agyCliInstallReason, agyCliInstallUrl, limitIssueGuidance, limitTimeLeft, resetBadgeDuration,
  resetCreditText, resetDetailTime, visibleLimitIssues
} from '../src/renderer/limitsPresentation'
import type { LimitAccountIssue, LimitsReport } from '../src/shared/limitsTypes'
import type { UsageProviderKind } from '../src/shared/types'

const expired: LimitAccountIssue = {
  id: 'agy-1', provider: 'antigravity', displayName: 'work@example.com', origin: 'manual',
  reason: 'expired', cached: false
}
const missingCli: LimitAccountIssue = {
  ...expired, id: 'agy-2', displayName: 'backup@example.com', reason: 'cli_missing'
}
const failed: LimitAccountIssue = {
  id: 'codex-1', provider: 'codex', displayName: 'local@example.com', origin: 'native',
  reason: 'failed', cached: false
}
const report: LimitsReport = {
  accounts: [], issues: [expired, missingCli, failed], checkedAt: null, refreshing: false
}

function renderView(props: Partial<ComponentProps<typeof LimitsView>> = {}) {
  return renderToStaticMarkup(createElement(LimitsView, {
    report, hiddenProviders: new Set<UsageProviderKind>(), loading: false, refreshing: false, failed: false,
    onRefresh: () => {}, onReport: () => {}, onOpenAccounts: () => {}, ...props
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
    expect(limitIssueGuidance(expired, false)).toEqual({
      message: '登录已失效，请在「账号管理」重新登录。',
      accountManagement: true
    })
    expect(limitIssueGuidance(expired, true)).toEqual({
      message: '登录已过期，请在客户端重新登录后重试。', accountManagement: false
    })
    expect(limitIssueGuidance({ ...expired, origin: 'native' }, false)).toEqual({
      message: '登录已过期，请在客户端重新登录后重试。', accountManagement: false
    })
    expect(limitIssueGuidance(missingCli, true)).toEqual({
      message: '未装 agy CLI，无法更新该账号的登录凭证，请安装 agy CLI：',
      installUrl: agyCliInstallUrl,
      installReason: agyCliInstallReason,
      accountManagement: false
    })
    expect(limitIssueGuidance(missingCli, false)).toEqual({
      message: '未装 agy CLI，无法更新该账号的登录凭证，请安装 agy CLI：',
      installUrl: agyCliInstallUrl,
      installReason: agyCliInstallReason,
      accountManagement: false
    })
    expect(limitIssueGuidance(failed, false).message).toBe('无法读取额度，请稍后重试。')
    expect(limitIssueGuidance({ ...failed, cached: true }, false).message).toBe('刷新失败，当前显示缓存额度。')
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
  it('keeps issue-only accounts in the provider pill row without a page-level warning', () => {
    const html = renderView({ hiddenProviders: hide('codex', 'claude') })
    expect(html).not.toContain('limit-warning-alert')
    expect(html).toContain('Antigravity')
    expect(html).toContain('class="limit-pill-name">work@example.com')
    expect(html).toContain('class="limit-pill-name">backup@example.com')
    expect(html.match(/data-issue="true"/g)).toHaveLength(2)
    expect(html.match(/data-switchable="true"/g)).toBeNull()
    expect(html).not.toContain('切换')
    expect(html.match(/class="[^"]*limit-pill-warning/g)).toHaveLength(2)
    const pill = html.match(/<button[^>]*data-issue="true"[^>]*>.*?<\/button>/)?.[0]
    expect(pill).toContain('<span class="sr-only">，额度读取异常</span>')
    expect(pill).not.toContain('title=')
    expect(html).not.toContain('class="limit-window"')
    expect(html).not.toContain('暂无可用额度')
  })

  it('shows only the common failure notice when the IPC request fails', () => {
    const html = renderView({ report: { ...report, issues: undefined }, failed: true })
    expect(html).toContain('role="alert"')
    expect(html).toContain('无法读取额度。')
    expect(html).not.toContain('limit-warning-alert')
    expect(html.match(/>重试<\/button>/g)).toHaveLength(1)
    expect(html).not.toContain('暂无可用额度')
  })

  it('shows an empty state only if there is no visible data or issue and no pending refresh', () => {
    expect(renderView({ hiddenProviders: hide('codex', 'antigravity') })).toContain('暂无可用额度')
    expect(renderView({ report: { ...report, issues: undefined } })).toContain('暂无可用额度')
    expect(renderView({ hiddenProviders: hide('codex', 'antigravity'), loading: true })).not.toContain('暂无可用额度')
    expect(renderView({ report: { ...report, issues: undefined }, refreshing: true })).not.toContain('暂无可用额度')
  })

  it('keeps quota cards visible alongside an issue pill', () => {
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
    expect(html).toContain('5 小时额度')
    expect(html).toContain('70%')
    expect(html).toMatch(/class="limit-segment"[^>]*data-issue="true"/)
    expect(html).not.toContain('limit-warning-alert')
  })

  it('keeps the current marker and puts the warning icon right beside it', () => {
    const html = renderView({
      report: {
        ...report,
        accounts: [{
          id: missingCli.id, provider: missingCli.provider, displayName: missingCli.displayName,
          origin: missingCli.origin, current: true, canSwitch: true, windows: [],
          checkedAt: '2026-11-24T12:00:00Z', stale: true
        }],
        issues: [missingCli]
      }
    })
    expect(html).toContain('data-issue="true" data-current="true"')
    expect(html).toMatch(/当前<\/span><svg[^>]*class="[^"]*limit-pill-warning/)
    expect(html).not.toContain('data-switchable="true"')
  })
})

describe('LimitIssueGuide', () => {
  const renderGuide = (
    issue: LimitAccountIssue,
    props: { refreshing?: boolean; current?: boolean } = {}
  ) => renderToStaticMarkup(createElement(LimitIssueGuide, {
    id: 'guide', issue, account: props.current === undefined ? undefined : {
      id: issue.id, displayName: issue.displayName, origin: issue.origin, current: props.current
    },
    refreshing: props.refreshing ?? false, onRefresh: () => {}, onOpenAccounts: () => {}
  }))

  it('renders the CLI recovery guidance, install link, help icon and retry action', () => {
    const html = renderGuide(missingCli)
    expect(html).toContain('未装 agy CLI，无法更新该账号的登录凭证，请安装 agy CLI：')
    expect(html).toContain(`<span>${agyCliInstallUrl}</span>`)
    expect(html).toContain(`aria-label="${agyCliInstallReason.title}"`)
    expect(html).toContain('>重试</button>')
    expect(html).not.toContain('账号管理')
    expect(renderGuide(missingCli, { current: true })).toContain('未装 agy CLI，无法更新该账号的登录凭证，请安装 agy CLI：')
  })

  it('spins the pill and popover warning icons and marks segments refreshing during retry', () => {
    const html = renderView({
      refreshing: true,
      report: {
        ...report,
        accounts: [{
          id: missingCli.id, provider: missingCli.provider, displayName: missingCli.displayName,
          origin: missingCli.origin, windows: [{ id: 'session', label: '5-hour', kind: 'session', usedPercent: 30 }],
          checkedAt: '2026-11-24T12:00:00Z', stale: true
        }],
        issues: [missingCli]
      }
    })
    expect(html).toMatch(/class="[^"]*limit-pill-warning[^"]*animate-spin/)
    expect(html).toMatch(/class="limit-segment"[^>]*data-issue="true" data-refreshing="true"/)
    expect(renderGuide(missingCli, { refreshing: true })).toMatch(/class="[^"]*limit-pill-warning[^"]*animate-spin/)
  })

  it('offers account management for a manual expired non-current account', () => {
    const manual = { ...expired, origin: 'manual' as const }
    const html = renderGuide(manual)
    expect(html).toContain('登录已失效，请在「账号管理」重新登录。')
    expect(html).toContain('>账号管理</button>')
    expect(renderGuide(manual, { current: true })).not.toContain('>账号管理</button>')
  })

  it('keeps retry focusable with aria-disabled while refreshing', () => {
    const html = renderGuide(failed, { refreshing: true })
    expect(html).toContain('重试中…')
    expect(html).toMatch(/aria-disabled="true"[^>]*aria-busy="true"/)
    expect(html).not.toMatch(/<button[^>]+disabled=""/)
  })
})

describe('LimitsView segments', () => {
  const window = {
    id: 'session', label: 'Session', kind: 'session', usedPercent: 45,
    windowDurationMins: 300, resetsAt: after(199)
  } as const
  const codex = {
    id: 'codex-1', displayName: 'codex@example.com', provider: 'codex', origin: 'native',
    stale: true, checkedAt: after(0), resetCredits: 2, windows: [window]
  } as const
  const agy = { ...codex, id: 'agy-1', displayName: 'work@example.com', provider: 'antigravity' } as const

  it('keeps one shared layer, shows every account email, and shows only Codex credits', () => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    try {
      const html = renderView({ report: { ...report, issues: undefined, accounts: [
        { ...codex, windows: [window] }, { ...agy, windows: [window] },
        { ...agy, id: 'agy-2', displayName: 'backup@example.com', windows: [{ ...window, usedPercent: 0 }] }
      ] } })
      expect(html).toContain('aria-label="账号"')
      expect(html.match(/popover="auto"/g)).toHaveLength(1)
      // Emails live in the header pills; the segment strips themselves stay clean.
      expect(html.match(/class="limit-account-name"/g)).toBeNull()
      expect(html.match(/class="limit-account-pill"/g)).toHaveLength(3)
      expect(html).toContain('class="limit-pill-name">codex@example.com')
      expect(html).toContain('class="limit-pill-name">work@example.com')
      expect(html.match(/class="limit-recovery"/g)).toHaveLength(1)
      expect(html.match(/class="limit-badge-credit"/g)).toHaveLength(1)
      expect(html).toContain('↻ 3 小时 19 分钟')
      expect(html).toContain('grid-template-columns:repeat(2, minmax(0, 1fr))')
      expect(html).not.toContain('确认使用')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders a switchable pill and leaves an empty column for a missing quota window', () => {
    const html = renderView({ report: { ...report, issues: undefined, accounts: [
      { ...agy, current: true, canSwitch: true, windows: [window, {
        ...window, id: 'weekly', label: 'Weekly', kind: 'weekly', windowDurationMins: 10080
      }] },
      { ...agy, id: 'agy-2', displayName: 'backup@example.com', canSwitch: true, windows: [window] }
    ] } })
    expect(html.match(/data-switchable="true"/g)).toHaveLength(1)
    expect(html).toContain('<button type="button" class="limit-account-pill" data-switchable="true" title="切换到 backup@example.com">')
    expect(html.match(/<span class="limit-account-slot" aria-hidden="true"><\/span>/g)).toHaveLength(1)
  })

  it('puts quota metrics directly after the email header, without a source row or divider', () => {
    const html = renderToStaticMarkup(createElement(LimitDetails, {
      id: 'details', provider: 'antigravity', now: fixedNow, redeeming: false,
      creditButton: createRef<HTMLButtonElement>(), onReset: vi.fn(),
      account: {
        id: 'work', displayName: agy.displayName, origin: 'native', checkedAt: after(0), stale: false,
        capacitySharePercent: 50, remainingPercent: 55, recoveryPercent: 8, resetStatus: 'upcoming',
        resetsAt: window.resetsAt, windowDurationMins: window.windowDurationMins
      }
    }))
    expect(html).toContain('title="work@example.com">work@example.com</span></h4><dl class="limit-metrics"><div><dt>剩余')
    expect(html).toContain('<dt>重置时间</dt>')
    expect(html).toContain('<dt>匀速进度</dt>')
    expect(html).toContain('<dt>恢复</dt>')
    expect(html).not.toMatch(/来源|limit-detail-group/)

    const staleHtml = renderToStaticMarkup(createElement(LimitDetails, {
      id: 'details-stale', provider: 'antigravity', now: fixedNow, redeeming: false,
      creditButton: createRef<HTMLButtonElement>(), onReset: vi.fn(),
      account: {
        id: 'work', displayName: agy.displayName, origin: 'native', checkedAt: after(0), stale: true,
        capacitySharePercent: 50, remainingPercent: 55, recoveryPercent: 8, resetStatus: 'upcoming',
        resetsAt: window.resetsAt, windowDurationMins: window.windowDurationMins
      }
    }))
    expect(staleHtml).toContain('<dt>刷新时间</dt>')
    expect(staleHtml).not.toContain('缓存数据')
  })
})

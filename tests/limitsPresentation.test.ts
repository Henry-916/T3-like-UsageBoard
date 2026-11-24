import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LimitsView } from '../src/renderer/components/LimitsView'
import { limitIssueText, visibleLimitIssues } from '../src/renderer/limitsPresentation'
import type { LimitAccountIssue, LimitsReport } from '../src/shared/limitsTypes'

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
    report, provider: 'all', loading: false, refreshing: false, failed: false,
    onRefresh: () => {}, ...props
  }))
}

describe('limit issue presentation', () => {
  it('keeps the report order and follows the active provider filter', () => {
    expect(visibleLimitIssues(report.issues, 'all')).toEqual([expired, missingCli, failed])
    expect(visibleLimitIssues(report.issues, 'antigravity')).toEqual([expired, missingCli])
    expect(visibleLimitIssues(undefined, 'all')).toEqual([])
  })

  it('explains expired credentials, the missing CLI and whether a failed read has cached data', () => {
    expect(limitIssueText(expired)).toBe('「工作账号」登录凭证已过期，请在 Antigravity 中重新登录后重试')
    expect(limitIssueText(missingCli)).toBe('「备用账号」登录凭证已过期，未找到可用的 agy CLI')
    expect(limitIssueText(failed)).toBe('「本地账号」无法读取额度')
    expect(limitIssueText({ ...failed, cached: true })).toBe('「本地账号」刷新失败，当前显示缓存数据')
  })
})

describe('LimitsView account notices', () => {
  it('shows filtered issue messages in one polite status with a shared retry, not an empty state', () => {
    const html = renderView({ provider: 'antigravity' })
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
    expect(renderView({ provider: 'claude' })).toContain('暂无可用额度')
    expect(renderView({ report: { ...report, issues: undefined } })).toContain('暂无可用额度')
    expect(renderView({ provider: 'claude', loading: true })).not.toContain('暂无可用额度')
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
  })
})

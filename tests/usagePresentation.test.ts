import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EMPTY_TOTALS, type UsageBucket, type UsageSummary } from '../src/shared/types'
import { timeBreakdown } from '../src/renderer/components/BreakdownTable'
import { UsageShareBar } from '../src/renderer/components/UsageShareBar'
import { trendTitle, usageDayFormat, usageFigures, usageSegments, visibleUsageSummary } from '../src/renderer/usagePresentation'

const bucket = (patch: Partial<UsageBucket> = {}): UsageBucket => ({
  day: '2026-11-24', provider: 'codex', model: 'gpt', costUsd: 0.6, cacheSavingsUsd: 0,
  costSource: 'modelPriced', totals: { ...EMPTY_TOTALS, uncachedInputTokens: 30 },
  unpricedRecords: 0, records: 1, sessions: 1,
  categoryCostUsd: { input: 0.1, cacheRead: 0.2, cacheWrite: 0.3, output: 0 },
  ...patch
})

describe('usage overview presentation', () => {
  it('filters both buckets and source-based distinct sessions, including all hidden', () => {
    const summary: UsageSummary = {
      readAt: '', timeZone: 'UTC', sinceDay: '2026-11-24', untilDay: '2026-11-24', scanDurationMs: 0,
      pricing: { status: 'fresh', source: 'test', fetchedAt: null, knownModels: 0 },
      buckets: [bucket(), bucket({ provider: 'opencode' }), bucket({ provider: 'claude' })],
      sources: [
        { provider: 'codex', status: 'ok', distinctSessions: 4, scannedFiles: 0, skippedFiles: 0 },
        { provider: 'opencode', status: 'partial', distinctSessions: 2, scannedFiles: 0, skippedFiles: 0 },
        { provider: 'claude', status: 'ok', distinctSessions: 1, scannedFiles: 0, skippedFiles: 0 },
        { provider: 'antigravity', status: 'ok', distinctSessions: 2, scannedFiles: 0, skippedFiles: 0 }
      ]
    }
    const visible = visibleUsageSummary(summary, new Set(['codex', 'opencode']))
    expect(visible.sessions).toBe(3)
    expect(visible.buckets.map(({ provider }) => provider)).toEqual(['claude'])
    expect(visible.sources.map(({ provider }) => provider)).toEqual(['claude', 'antigravity'])
    expect(visibleUsageSummary(summary, new Set(['codex', 'opencode', 'claude', 'antigravity'])))
      .toEqual({ buckets: [], sources: [], sessions: 0 })
  })

  it('shows cache writes without counting them as other or keeping zero-value legend entries', () => {
    const segments = usageSegments(usageFigures([bucket()]), 'cost')
    expect(segments.find(({ label }) => label === '缓存写入')?.value).toBe(0.3)
    expect(segments.find(({ label }) => label === '其他')?.value).toBe(0)
    const html = renderToStaticMarkup(createElement(UsageShareBar, { label: '按类型统计的费用', segments, metric: 'cost' }))
    expect(html).toContain('US$0.30')
    expect(html).toContain('缓存写入')
    expect(html).not.toContain('输出')
    expect(html).not.toContain('其他')
    expect(html).not.toContain('US$0.00')
  })

  it('groups the newest hour first, combining the same slot across local midnight', () => {
    const hourStart = '2026-11-23T23:30:00.000Z'
    const next = '2026-11-24T00:30:00.000Z'
    const buckets = [
      bucket({ day: '2026-11-23', hourStart }),
      bucket({ hourStart, provider: 'claude' }),
      bucket({ hourStart: next })
    ]
    const hours = timeBreakdown(buckets, true)
    expect(hours.map(({ period, values }) => [period, values.tokens])).toEqual([[next, 30], [hourStart, 60]])
    expect([...hours[1].byProvider.keys()]).toEqual(['codex', 'claude'])
    expect(timeBreakdown(buckets, false).map(({ period, values }) => [period, values.tokens]))
      .toEqual([['2026-11-24', 60], ['2026-11-23', 30]])
    expect(usageDayFormat.format(new Date('2026-11-24'))).toBe('11月24日')
    expect(trendTitle({ timeZone: 'UTC', sinceDay: '2026-11-24', untilDay: '2026-11-24', resolution: 'hour' }, 'tokens'))
      .toBe('每小时处理的 token')
  })
})

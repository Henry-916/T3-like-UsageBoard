import { describe, expect, it } from 'vitest'
import { buildUsageChartColumns, smoothCurve } from '../src/renderer/components/UsageProviderChart'
import { aggregateUsage } from '../src/main/usage/aggregation'
import { EMPTY_TOTALS, totalTokens, type UsageRecord, type UsageSummaryInput } from '../src/shared/types'

const pricing = {
  rates: new Map(),
  status: { status: 'unavailable', source: 'test', fetchedAt: null, knownModels: 0 }
} as const

const record = (timestamp: string, data: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: 'codex', model: 'test', timestampMs: Date.parse(timestamp),
  sessionId: 'test', speed: 'standard', dedupeKey: null, reportedCostUsd: 0.00123,
  totals: { ...EMPTY_TOTALS, uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 30,
    outputTokens: 40, reasoningTokens: 5 },
  ...data
})

describe('usage chart columns', () => {
  it('uses exact start-anchored hours, combines local midnight splits, and zero-fills gaps', () => {
    const query: UsageSummaryInput = {
      resolution: 'hour', sinceDay: '2026-10-31', untilDay: '2026-11-01', timeZone: 'America/New_York',
      sinceTime: '2026-10-31T23:30:15-04:00', untilTime: '2026-11-01T02:30:15-05:00'
    }
    const buckets = aggregateUsage([
      record('2026-11-01T03:30:14.999Z'),
      record('2026-11-01T03:30:15Z'),
      record('2026-11-01T04:10:00Z', { model: 'second' }),
      record('2026-11-01T05:45:00Z', { provider: 'claude' }),
      record('2026-11-01T06:45:00Z'),
      record('2026-11-01T07:30:15Z')
    ], query, pricing, {}, {})
    expect(buckets.slice(0, 2).map(({ day }) => day)).toEqual(['2026-10-31', '2026-11-01'])
    const { columns, providers } = buildUsageChartColumns(buckets, query, 'tokens')
    expect(providers.map(({ id }) => id)).toEqual(['codex', 'claude'])
    expect(columns.map(({ period, total }) => [period, total])).toEqual([
      ['2026-11-01T03:30:15.000Z', 200],
      ['2026-11-01T04:30:15.000Z', 0],
      ['2026-11-01T05:30:15.000Z', 100],
      ['2026-11-01T06:30:15.000Z', 100]
    ])
    expect(columns[2].values).toEqual({ antigravity: 0, opencode: 0, codex: 0, claude: 100 })
    expect(columns.reduce((sum, col) => sum + col.total, 0)).toBe(
      buckets.reduce((sum, row) => sum + totalTokens(row.totals), 0)
    )
    const cost = buildUsageChartColumns(buckets, query, 'cost').columns
    expect(cost[0].values.codex).toBeCloseTo(0.00246, 10)
    expect(cost.reduce((sum, col) => sum + col.total, 0)).toBeCloseTo(
      buckets.reduce((sum, row) => sum + row.costUsd, 0), 10
    )
  })

  it('includes a final partial hour without inventing a slot at the upper bound', () => {
    const sinceTime = '2026-07-01T16:17:00Z'
    const query: UsageSummaryInput = {
      resolution: 'hour', sinceDay: '2026-07-01', untilDay: '2026-07-01', timeZone: 'Asia/Kathmandu',
      sinceTime, untilTime: '2026-07-01T17:33:00Z'
    }
    const buckets = aggregateUsage([
      record('2026-07-01T17:32:59.999Z'), record(query.untilTime!)
    ], query, pricing, {}, {})
    expect(buildUsageChartColumns(buckets, query, 'tokens').columns.map(({ period, total }) => [period, total]))
      .toEqual([['2026-07-01T16:17:00.000Z', 0], ['2026-07-01T17:17:00.000Z', 100]])
  })

  it('fills inclusive IANA-local calendar keys across DST, independent of UTC date and day length', () => {
    const query: UsageSummaryInput = {
      sinceDay: '2026-03-07', untilDay: '2026-03-10', timeZone: 'America/New_York'
    }
    const buckets = aggregateUsage([
      record('2026-03-07T04:59:59.999Z'),
      record('2026-03-07T05:00:00Z'),
      record('2026-03-09T03:59:59.999Z', { provider: 'opencode' }),
      record('2026-03-11T03:59:59.999Z'),
      record('2026-03-11T04:00:00Z')
    ], query, pricing, {}, {})
    expect(buildUsageChartColumns(buckets, query, 'tokens').columns.map(({ period, total }) => [period, total]))
      .toEqual([['2026-03-07', 100], ['2026-03-08', 100], ['2026-03-09', 0], ['2026-03-10', 100]])
  })
})

describe('usage chart monotone cubic curve', () => {
  it('passes through every observed period without overshooting, including flat gaps', () => {
    const points = [0, 100, 101, 0, 0, 15, 16].map((y, x) => ({ x, y }))
    const segments = smoothCurve(points)
    expect(segments).toHaveLength(points.length - 1)
    segments.forEach(({ from, c1, c2, to }, i) => {
      expect(from).toBe(points[i])
      expect(to).toBe(points[i + 1])
      for (let sample = 1; sample < 40; sample++) {
        const t = sample / 40
        const u = 1 - t
        const y = u ** 3 * from.y + 3 * u ** 2 * t * c1.y + 3 * u * t ** 2 * c2.y + t ** 3 * to.y
        expect(y).toBeGreaterThanOrEqual(Math.min(from.y, to.y) - 1e-9)
        expect(y).toBeLessThanOrEqual(Math.max(from.y, to.y) + 1e-9)
      }
    })
    expect(smoothCurve([points[0]])).toEqual([])
  })
})

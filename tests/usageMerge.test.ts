import { describe, expect, it } from 'vitest'
import { EMPTY_TOTALS, totalTokens, type UsageBucket } from '../src/shared/types'
import { groupUsageBuckets, sumUsageBuckets } from '../src/shared/usageMerge'

const priced: UsageBucket = {
  day: '2026-11-24',
  provider: 'claude',
  model: 'test-model',
  totals: {
    uncachedInputTokens: 20,
    cachedInputTokens: 40,
    cacheCreationTokens: 10,
    outputTokens: 30,
    reasoningTokens: 8
  },
  costUsd: 3,
  cacheSavingsUsd: 0.5,
  categoryCostUsd: { input: 0.5, cacheRead: 0.25, cacheWrite: 0.25, output: 2 },
  costSource: 'modelPriced',
  records: 3,
  unpricedRecords: 0,
  sessions: 1
}
const reported: UsageBucket = {
  ...priced,
  provider: 'opencode',
  costUsd: 1,
  cacheSavingsUsd: 0,
  categoryCostUsd: undefined,
  costSource: 'providerReported',
  records: 1
}
const unpriced: UsageBucket = {
  ...reported,
  provider: 'antigravity',
  costUsd: 0,
  costSource: 'unpriced',
  unpricedRecords: 1
}

describe('usage bucket aggregation', () => {
  it('sums costs, token categories and record counts without mutating buckets', () => {
    const sum = sumUsageBuckets([priced, reported, unpriced, { ...priced, provider: 'codex' }])
    expect(sum).toEqual({
      totals: {
        uncachedInputTokens: 80,
        cachedInputTokens: 160,
        cacheCreationTokens: 40,
        outputTokens: 120,
        reasoningTokens: 32
      },
      costUsd: 7,
      cacheSavingsUsd: 1,
      categoryCostUsd: { input: 1, cacheRead: 0.5, cacheWrite: 0.5, output: 4 },
      unpricedRecords: 1,
      records: 8
    })
    expect(totalTokens(sum.totals)).toBe(400)
    expect(priced.totals.outputTokens).toBe(30)
    expect(priced.categoryCostUsd?.output).toBe(2)
  })

  it('returns fresh, zero-filled totals for empty input', () => {
    const result = sumUsageBuckets([])
    expect(result).toEqual({
      totals: EMPTY_TOTALS,
      costUsd: 0,
      cacheSavingsUsd: 0,
      categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      unpricedRecords: 0,
      records: 0
    })
    expect(result.totals).not.toBe(EMPTY_TOTALS)
  })

  it('groups buckets by caller-selected key in input order', () => {
    const secondDay = { ...priced, day: '2026-11-25' }
    expect([...groupUsageBuckets([priced, reported, secondDay], (bucket) => bucket.provider)])
      .toEqual([['claude', [priced, secondDay]], ['opencode', [reported]]])
    expect(groupUsageBuckets([], (bucket) => bucket.day).size).toBe(0)
  })
})

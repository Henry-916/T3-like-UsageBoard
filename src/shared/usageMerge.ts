import { EMPTY_TOTALS, type UsageBucket, type UsageCategoryCost, type UsageTokenTotals } from './types'

export function sumUsageBuckets(buckets: readonly UsageBucket[]): {
  totals: UsageTokenTotals
  costUsd: number
  cacheSavingsUsd: number
  categoryCostUsd: UsageCategoryCost
  unpricedRecords: number
  records: number
} {
  const totals: UsageTokenTotals = { ...EMPTY_TOTALS }
  const categoryCostUsd: UsageCategoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let costUsd = 0
  let cacheSavingsUsd = 0
  let unpricedRecords = 0
  let records = 0

  for (const bucket of buckets) {
    totals.uncachedInputTokens += bucket.totals.uncachedInputTokens
    totals.cachedInputTokens += bucket.totals.cachedInputTokens
    totals.cacheCreationTokens += bucket.totals.cacheCreationTokens
    totals.outputTokens += bucket.totals.outputTokens
    totals.reasoningTokens += bucket.totals.reasoningTokens
    costUsd += bucket.costUsd
    cacheSavingsUsd += bucket.cacheSavingsUsd
    unpricedRecords += bucket.unpricedRecords
    records += bucket.records

    // Provider-reported cost without a category split still contributes to costUsd.
    const category = bucket.categoryCostUsd
    if (category) {
      categoryCostUsd.input += category.input
      categoryCostUsd.cacheRead += category.cacheRead
      categoryCostUsd.cacheWrite += category.cacheWrite
      categoryCostUsd.output += category.output
    }
  }

  return { totals, costUsd, cacheSavingsUsd, categoryCostUsd, unpricedRecords, records }
}

export function groupUsageBuckets(
  buckets: readonly UsageBucket[],
  keyFn: (bucket: UsageBucket) => string
): Map<string, UsageBucket[]> {
  const groups = new Map<string, UsageBucket[]>()
  for (const bucket of buckets) {
    const key = keyFn(bucket)
    const group = groups.get(key)
    if (group) group.push(bucket)
    else groups.set(key, [bucket])
  }
  return groups
}

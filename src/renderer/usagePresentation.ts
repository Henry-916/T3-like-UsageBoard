import { totalTokens, type UsageBucket, type UsageProviderKind, type UsageSummary, type UsageSummaryInput } from '../shared/types'
import { formatTokens, formatUsd } from '../shared/usageFormat'
import { sumUsageBuckets } from '../shared/usageMerge'

export type UsageMetric = 'cost' | 'tokens'
export type UsageView = UsageMetric | 'limits'
export type UsageRange = '24h' | '7d' | '30d' | '90d'

export const providers = ['antigravity', 'opencode', 'codex', 'claude'] as const
export const providerInfo = {
  antigravity: { label: 'Antigravity', color: '#8c7bd1' },
  opencode: { label: 'OpenCode', color: '#5b9bbd' },
  codex: { label: 'Codex', color: '#e4e4e7' },
  claude: { label: 'Claude Code', color: '#d97757' }
} satisfies Record<UsageProviderKind, { label: string; color: string }>

export const ranges = [
  { value: '24h', label: '过去 24 小时', shortcut: 'Ctrl+Shift+1' },
  { value: '7d', label: '7 天', shortcut: 'Ctrl+Shift+2' },
  { value: '30d', label: '30 天', shortcut: 'Ctrl+Shift+3' },
  { value: '90d', label: '90 天', shortcut: 'Ctrl+Shift+4' }
] as const

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function makeUsageQuery(range: UsageRange, now = new Date()): UsageSummaryInput {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (range === '24h') {
    const start = new Date(now.getTime() - 86_400_000)
    return {
      sinceDay: localDay(start), untilDay: localDay(new Date(now.getTime() - 1)),
      timeZone, resolution: 'hour', sinceTime: start.toISOString(), untilTime: now.toISOString()
    }
  }
  const days = Number.parseInt(range, 10)
  // Work in a local calendar, not in 24-hour increments (daylight saving changes day length).
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
  return { sinceDay: localDay(start), untilDay: localDay(now), timeZone, resolution: 'day' }
}

export function groupBuckets<K>(buckets: readonly UsageBucket[], keyFor: (bucket: UsageBucket) => K) {
  const map = new Map<K, UsageBucket[]>()
  for (const bucket of buckets) {
    const group = map.get(keyFor(bucket))
    if (group) group.push(bucket)
    else map.set(keyFor(bucket), [bucket])
  }
  return map
}

export function visibleUsage<K extends { provider: UsageProviderKind }>(
  items: readonly K[], hiddenProviders: ReadonlySet<UsageProviderKind>
): readonly K[] {
  return hiddenProviders.size ? items.filter(({ provider }) => !hiddenProviders.has(provider)) : items
}

export function visibleUsageSummary(summary: UsageSummary, hiddenProviders: ReadonlySet<UsageProviderKind>) {
  const sources = visibleUsage(summary.sources, hiddenProviders)
  return {
    buckets: visibleUsage(summary.buckets, hiddenProviders),
    sources,
    sessions: sources.reduce((total, source) => total + source.distinctSessions, 0)
  }
}

export function trendTitle(query: UsageSummaryInput, metric: UsageMetric): string {
  return `${query.resolution === 'hour' ? '每小时' : '每天'}${metric === 'cost' ? '费用' : '处理的 token'}`
}

export const usageDayFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'short', day: 'numeric', timeZone: 'UTC'
})

export function usageFigures(buckets: readonly UsageBucket[]) {
  const sum = sumUsageBuckets(buckets)
  return {
    ...sum,
    tokens: totalTokens(sum.totals),
    unpricedTokens: buckets.reduce((n, bucket) => n + (bucket.unpricedTokens ??
      (bucket.costSource === 'unpriced' ? totalTokens(bucket.totals) : 0)), 0),
    costUnknown: sum.records > 0 && sum.unpricedRecords === sum.records
  }
}

export type UsageFigures = ReturnType<typeof usageFigures>

export interface UsageModel {
  provider: UsageProviderKind
  model: string
}

export const formatCount = (value: number) => value.toLocaleString('zh-CN')
export const metricValue = (values: UsageFigures, metric: UsageMetric) => metric === 'cost' ? values.costUsd : values.tokens
export const formatMetric = (value: number, metric: UsageMetric) => metric === 'cost' ? formatUsd(value) : formatTokens(value)
export const formatUsageCost = (values: UsageFigures) => values.costUnknown ? '未定价' : formatUsd(values.costUsd)

export interface ShareSegment { label: string; value: number; intensity: number }

export function usageSegments(values: UsageFigures, metric: UsageMetric): ShareSegment[] {
  const { totals, categoryCostUsd: cost } = values
  return metric === 'cost'
    ? [
        { label: '输入框', value: cost.input, intensity: 60 },
        { label: '缓存读取', value: cost.cacheRead, intensity: 30 },
        { label: '缓存写入', value: cost.cacheWrite, intensity: 72 },
        { label: '输出', value: cost.output, intensity: 100 },
        // Ignore floating-point noise when all costs are already allocated.
        { label: '其他', value: Math.max(0, Number((values.costUsd - cost.input - cost.cacheRead - cost.cacheWrite - cost.output).toFixed(8))), intensity: 44 }
      ]
    : [
        { label: '输入框', value: totals.uncachedInputTokens, intensity: 60 },
        { label: '缓存读取', value: totals.cachedInputTokens, intensity: 30 },
        { label: '缓存写入', value: totals.cacheCreationTokens, intensity: 72 },
        { label: '输出', value: totals.outputTokens, intensity: 100 }
      ]
}

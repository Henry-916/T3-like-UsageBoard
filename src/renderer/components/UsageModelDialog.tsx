import { useMemo } from 'react'
import type { UsageBucket, UsageProviderKind, UsageSummaryInput } from '../../shared/types'
import { formatPercent, formatTokens, formatUsd } from '../../shared/usageFormat'
import { formatUsageCost, providerInfo, trendTitle, usageFigures, usageSegments, visibleUsage, type UsageMetric, type UsageModel } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import { UsageDialog } from './UsageDialog'
import { UsageProviderChart } from './UsageProviderChart'
import { UsageShareBar } from './UsageShareBar'

export function UsageModelDialog({ model, buckets, query, metric, hiddenProviders, onPrice, onClose }: {
  model: UsageModel; buckets: readonly UsageBucket[]; query: UsageSummaryInput; metric: UsageMetric
  hiddenProviders: ReadonlySet<UsageProviderKind>; onPrice: () => void; onClose: () => void
}) {
  const filteredBuckets = useMemo(() => visibleUsage(buckets, hiddenProviders), [buckets, hiddenProviders])
  const modelBuckets = useMemo(() => filteredBuckets.filter((bucket) => bucket.provider === model.provider &&
    bucket.model === model.model), [filteredBuckets, model])
  const values = useMemo(() => usageFigures(modelBuckets), [modelBuckets])
  const total = useMemo(() => usageFigures(filteredBuckets).costUsd, [filteredBuckets])
  if (hiddenProviders.has(model.provider)) return null
  const { totals } = values
  const input = totals.cachedInputTokens + totals.uncachedInputTokens + totals.cacheCreationTokens
  const pricedTokens = values.tokens - values.unpricedTokens
  const stats = [
    ['费用', formatUsageCost(values)],
    ['token', formatTokens(values.tokens)],
    ['每百万 token', values.costUnknown || pricedTokens <= 0 ? '—' : formatUsd(values.costUsd / pricedTokens * 1_000_000)],
    ['缓存命中率', input > 0 ? formatPercent(totals.cachedInputTokens / input) : '—']
  ]
  const chartMetric = values.costUnknown ? 'tokens' : metric
  return (
    <UsageDialog onClose={onClose}
      title={<><ProviderMark provider={model.provider} className="size-5" />{model.model}</>}
      subtitle={`${providerInfo[model.provider].label}${!values.costUnknown && total > 0
        ? ` · ${formatPercent(values.costUsd / total)} 费用占比` : ''}`}>
      <div className="dialog-body model-dialog-body">
        <dl className="model-stats">
          {stats.map(([label, value]) => <div className="stat" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <section className="flex min-w-0 flex-col gap-3">
          <h3 className="section-title">{trendTitle(query, chartMetric)}</h3>
          <UsageProviderChart buckets={modelBuckets} query={query} metric={chartMetric} />
        </section>
        <div className="model-share-grid">
          {!values.costUnknown && <UsageShareBar label="按费用类型统计" segments={usageSegments(values, 'cost')} metric="cost" />}
          <UsageShareBar label="按 token 类型统计" segments={usageSegments(values, 'tokens')} metric="tokens" />
        </div>
      </div>
      {values.unpricedRecords > 0 && (
        <footer className="dialog-footer model-dialog-footer">
          <span>{values.unpricedTokens > 0 ? `${formatTokens(values.unpricedTokens)} token 未定价` : '部分记录未定价'}</span>
          <button className="action-button primary-action" type="button" onClick={onPrice}>设置价格</button>
        </footer>
      )}
    </UsageDialog>
  )
}

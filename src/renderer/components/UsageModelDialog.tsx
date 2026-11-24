import { useMemo } from 'react'
import type { UsageBucket, UsageSummaryInput } from '../../shared/types'
import { formatPercent, formatTokens, formatUsd } from '../../shared/usageFormat'
import { formatUsageCost, providerInfo, usageFigures, usageSegments, type UsageMetric, type UsageModel } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import { UsageDialog } from './UsageDialog'
import { UsageProviderChart } from './UsageProviderChart'
import { UsageShareBar } from './UsageShareBar'

export function UsageModelDialog({ model, buckets, query, metric, provider, onPrice, onClose }: {
  model: UsageModel; buckets: readonly UsageBucket[]; query: UsageSummaryInput; metric: UsageMetric
  provider: 'all' | UsageModel['provider']; onPrice: () => void; onClose: () => void
}) {
  const modelBuckets = useMemo(() => buckets.filter((bucket) => bucket.provider === model.provider &&
    bucket.model === model.model), [buckets, model])
  const values = useMemo(() => usageFigures(modelBuckets), [modelBuckets])
  const filteredBuckets = useMemo(() => provider === 'all' ? buckets :
    buckets.filter((bucket) => bucket.provider === provider), [buckets, provider])
  const total = useMemo(() => usageFigures(filteredBuckets).costUsd, [filteredBuckets])
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
          <h3 className="section-title">{query.resolution === 'hour' ? '每小时' : '每日'}{chartMetric === 'cost' ? '费用' : ' token'}</h3>
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

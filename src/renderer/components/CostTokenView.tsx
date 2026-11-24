import { useMemo } from 'react'
import type { UsageSource, UsageSummary, UsageSummaryInput } from '../../shared/types'
import { formatPercent } from '../../shared/usageFormat'
import {
  formatCount, formatMetric, formatUsageCost, groupBuckets, metricValue, providerInfo, providers, usageFigures,
  usageSegments, type ProviderFilter, type UsageMetric, type UsageModel
} from '../usagePresentation'
import { BreakdownTable } from './BreakdownTable'
import { ProviderMark } from './ProviderMark'
import { TotalsStrip } from './TotalsStrip'
import { UsageProviderChart } from './UsageProviderChart'
import { UsageShareBar } from './UsageShareBar'

export function CostTokenView({ summary, query, provider, metric, pending, onModel }: {
  summary: UsageSummary; query: UsageSummaryInput; provider: ProviderFilter; metric: UsageMetric
  pending: boolean; onModel: (model: UsageModel) => void
}) {
  const buckets = useMemo(() => provider === 'all' ? summary.buckets :
    summary.buckets.filter((bucket) => bucket.provider === provider), [summary, provider])
  const sourceMap = new Map(summary.sources.filter((source) => provider === 'all' || source.provider === provider)
    .map((source) => [source.provider, source] as const))
  const values = useMemo(() => usageFigures(buckets), [buckets])
  const byProvider = useMemo(() => new Map(Array.from(groupBuckets(buckets, (bucket) => bucket.provider),
    ([kind, group]) => [kind, usageFigures(group)] as const)), [buckets])
  const active = providers.filter((kind) => byProvider.has(kind))
  const currentTotal = metricValue(values, metric)
  const ranked = active.map((kind) => ({
    kind, figures: byProvider.get(kind)!, sessions: sourceMap.get(kind)?.distinctSessions ?? 0
  })).sort((a, b) => metricValue(b.figures, metric) - metricValue(a.figures, metric) || b.figures.tokens - a.figures.tokens)
  const sessions = [...sourceMap.values()].reduce((n: number, source: UsageSource) => n + source.distinctSessions, 0)
  const incomplete = [...sourceMap.values()].filter((source) => source.status === 'failed' || source.status === 'partial')
  const timeLabel = query.resolution === 'hour' ? '每小时' : '每日'
  return (
    <div className="usage-overview" aria-busy={pending}>
      {(summary.pricing.status === 'unavailable' || incomplete.length > 0) && (
        <div className="inline-notice">
          {summary.pricing.status === 'unavailable' && <p>价格表不可用，部分用量可能未定价。</p>}
          {incomplete.length > 0 && <p>{incomplete.map(({ provider }) => providerInfo[provider].label).join('、')} 的用量读取不完整。</p>}
        </div>
      )}
      <section className="usage-hero">
        <div className="usage-overview-side">
          <div>
            <p className={`usage-figure tabular-nums${metric === 'cost' && values.costUnknown ? ' unknown-figure' : ''}`}>
              <span className="sr-only">{metric === 'cost' ? '总费用：' : '总 token：'}</span>
              {metric === 'cost' ? formatUsageCost(values) : formatMetric(values.tokens, metric)}
            </p>
            <p className="usage-caption">
              {formatCount(sessions)} 个会话
              {metric === 'cost' && !values.costUnknown && ' · API 估算'}
              {metric === 'cost' && values.unpricedRecords > 0 && !values.costUnknown && ' · 不含未定价用量'}
            </p>
          </div>
          {ranked.length > 0 && <ul className="provider-rank" aria-label="提供方用量">
            {ranked.map(({ kind, figures, sessions }) => {
              const { label, color } = providerInfo[kind]
              const share = currentTotal > 0 ? metricValue(figures, metric) / currentTotal : 0
              const other = metric === 'cost' ? `${formatMetric(figures.tokens, 'tokens')} token` : formatUsageCost(figures)
              return (
                <li key={kind}>
                  <div className="provider-rank-line">
                    <div className="provider-rank-label">
                      <span className="provider-dot" style={{ backgroundColor: color }} aria-hidden="true" />
                      <ProviderMark provider={kind} />
                      <span className="truncate" title={label}>{label}</span>
                      <span className="provider-sessions">{formatCount(sessions)} 个会话</span>
                    </div>
                    <strong>{metric === 'cost' ? formatUsageCost(figures) : formatMetric(figures.tokens, metric)}</strong>
                  </div>
                  <p className="usage-caption">{metric === 'cost' && figures.costUnknown ? other :
                    `${formatPercent(share)} ${metric === 'cost' ? '费用' : 'token'}占比 · ${other}`}</p>
                </li>
              )
            })}
          </ul>}
        </div>
        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="section-title">{timeLabel}{metric === 'cost' ? '费用' : ' token'}</h2>
          <UsageProviderChart buckets={buckets} query={query} metric={metric} />
        </section>
      </section>
      <TotalsStrip values={values} />
      <div className="overview-share">
        <UsageShareBar label="按类型统计" segments={usageSegments(values, metric)} metric={metric} />
      </div>
      <BreakdownTable buckets={buckets} values={values} metric={metric} activeProviders={active} onModel={onModel} />
    </div>
  )
}

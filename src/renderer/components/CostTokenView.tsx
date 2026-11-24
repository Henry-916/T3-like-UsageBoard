import { Info } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import type { UsageProviderKind, UsageSummary, UsageSummaryInput } from '../../shared/types'
import { formatPercent } from '../../shared/usageFormat'
import {
  formatCount, formatMetric, formatUsageCost, groupBuckets, metricValue, providerInfo, providers, usageFigures,
  trendTitle, usageSegments, visibleUsageSummary, type UsageMetric, type UsageModel
} from '../usagePresentation'
import { BreakdownTable } from './BreakdownTable'
import { ProviderMark } from './ProviderMark'
import { TotalsStrip } from './TotalsStrip'
import { UsageProviderChart } from './UsageProviderChart'
import { UsageShareBar } from './UsageShareBar'

export function CostTokenView({ summary, query, hiddenProviders, metric, pending, onModel }: {
  summary: UsageSummary; query: UsageSummaryInput; hiddenProviders: ReadonlySet<UsageProviderKind>; metric: UsageMetric
  pending: boolean; onModel: (model: UsageModel) => void
}) {
  const { buckets, sources, sessions } = useMemo(() => visibleUsageSummary(summary, hiddenProviders), [summary, hiddenProviders])
  const sourceMap = new Map(sources.map((source) => [source.provider, source] as const))
  const values = useMemo(() => usageFigures(buckets), [buckets])
  const byProvider = useMemo(() => new Map(Array.from(groupBuckets(buckets, (bucket) => bucket.provider),
    ([kind, group]) => [kind, usageFigures(group)] as const)), [buckets])
  const active = providers.filter((kind) => byProvider.has(kind))
  const currentTotal = metricValue(values, metric)
  const ranked = active.map((kind) => ({
    kind, figures: byProvider.get(kind)!, sessions: sourceMap.get(kind)?.distinctSessions ?? 0
  })).sort((a, b) => metricValue(b.figures, metric) - metricValue(a.figures, metric) || b.figures.tokens - a.figures.tokens)
  const incomplete = sources.filter((source) => source.status === 'failed' || source.status === 'partial')
  const missingPriceTable = metric === 'cost' && buckets.length > 0 && summary.pricing.status === 'unavailable'
  return (
    <div className="usage-overview" aria-busy={pending}>
      {(missingPriceTable || incomplete.length > 0) && (
        <div className="inline-notice">
          {missingPriceTable && <p>价格表不可用，部分用量可能未定价。</p>}
          {incomplete.length > 0 && <p>{incomplete.map(({ provider }) => providerInfo[provider].label).join('、')} 的用量读取不完整。</p>}
        </div>
      )}
      <section className="usage-hero">
        <div className="usage-overview-side">
          <div>
            <p className="usage-figure">
              <span className="sr-only">{metric === 'cost' ? '总费用：' : '总 token：'}</span>
              {metric === 'cost' ? formatUsageCost(values) : formatMetric(values.tokens, metric)}
            </p>
            <div className="usage-caption usage-summary-caption">
              <span>{formatCount(sessions)} 个会话{metric === 'cost' && ' · API 估算'}</span>
              {metric === 'cost' && values.unpricedRecords > 0 && !values.costUnknown && (
                <PricingNote share={values.unpricedRecords / values.records} />
              )}
            </div>
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
                      <ProviderMark provider={kind} className="size-4" />
                      <span className="truncate" title={label}>{label}</span>
                      <span className="provider-sessions">{formatCount(sessions)} 个会话</span>
                    </div>
                    <strong>{metric === 'cost' ? formatUsageCost(figures) : formatMetric(figures.tokens, metric)}</strong>
                  </div>
                  <p className="usage-caption">{metric === 'cost' && figures.costUnknown ? other :
                    `${metric === 'cost' ? '占费用的' : '占 token 的'} ${formatPercent(share)} · ${other}`}</p>
                </li>
              )
            })}
          </ul>}
        </div>
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="section-title">{trendTitle(query, metric)}</h2>
          <UsageProviderChart buckets={buckets} query={query} metric={metric} />
        </section>
      </section>
      <TotalsStrip values={values} />
      <div className="overview-share">
        <UsageShareBar label={metric === 'cost' ? '按类型统计的费用' : '按类型统计的 token'} segments={usageSegments(values, metric)} metric={metric} />
      </div>
      <BreakdownTable buckets={buckets} query={query} values={values} metric={metric} activeProviders={active} onModel={onModel} />
    </div>
  )
}

function PricingNote({ share }: { share: number }) {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  return (
    <span className="usage-pricing-note" data-dismissed={dismissed}
      onPointerEnter={() => setDismissed(false)}>
      <button type="button" aria-label="API 估算说明" aria-describedby={id}
        onFocus={() => setDismissed(false)} onClick={() => setDismissed(false)}
        onKeyDown={(event) => { if (event.key === 'Escape') setDismissed(true) }}>
        <Info size={12} aria-hidden="true" />
      </button>
      <span id={id} role="tooltip" className="usage-pricing-tip">API 估算不含未定价记录（{formatPercent(share)}）</span>
    </span>
  )
}

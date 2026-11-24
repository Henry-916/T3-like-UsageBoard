import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { UsageBucket, UsageProviderKind } from '../../shared/types'
import { formatPercent, formatTokens } from '../../shared/usageFormat'
import {
  formatMetric, formatUsageCost, groupBuckets, metricValue, providerInfo, usageFigures,
  type UsageFigures, type UsageMetric, type UsageModel
} from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import { Segmented } from './TopBar'

type Sort = { key: UsageMetric; direction: 'ascending' | 'descending' }
const breakdownOptions = [{ value: 'model', label: '模型' }, { value: 'day', label: '天' }] as const
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' })

export function BreakdownTable({ buckets, values, metric, activeProviders, onModel }: {
  buckets: readonly UsageBucket[]
  values: UsageFigures
  metric: UsageMetric
  activeProviders: readonly UsageProviderKind[]
  onModel: (model: UsageModel) => void
}) {
  const [breakdown, setBreakdown] = useState<'model' | 'day'>('model')
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-title">明细</h2>
        <Segmented label="明细分组" value={breakdown} options={breakdownOptions} onChange={setBreakdown} />
      </div>
      {breakdown === 'model'
        ? <ModelTable key={metric} buckets={buckets} values={values} metric={metric} onModel={onModel} />
        : <DayTable buckets={buckets} activeProviders={activeProviders} metric={metric} />}
    </section>
  )
}

function ModelTable({ buckets, values, metric, onModel }: {
  buckets: readonly UsageBucket[]; values: UsageFigures; metric: UsageMetric; onModel: (model: UsageModel) => void
}) {
  const [sort, setSort] = useState<Sort>({ key: metric, direction: 'descending' })
  const models = useMemo(() => Array.from(
    groupBuckets(buckets, (bucket) => JSON.stringify([bucket.provider, bucket.model])).values(),
    (group) => ({ ...usageFigures(group), provider: group[0].provider, model: group[0].model })
  ), [buckets])
  const sorted = [...models].sort((a, b) => {
    if (sort.key === 'cost' && a.costUnknown !== b.costUnknown) return a.costUnknown ? 1 : -1
    const diff = metricValue(b, sort.key) - metricValue(a, sort.key)
    return (sort.direction === 'ascending' ? -diff : diff) || b.tokens - a.tokens || a.model.localeCompare(b.model)
  })
  const peak = models.reduce((max, model) => Math.max(max, metricValue(model, metric)), 0)
  const total = metricValue(values, metric)

  function sortColumn(key: UsageMetric, label: string) {
    const active = sort.key === key
    const next = active && sort.direction === 'descending' ? 'ascending' : 'descending'
    const Arrow = !active ? ChevronsUpDown : sort.direction === 'descending' ? ArrowDown : ArrowUp
    return (
      <th scope="col" aria-sort={active ? sort.direction : undefined}>
        <button type="button" className="column-sort"
          aria-label={`按${label}${next === 'ascending' ? '升序' : '降序'}排列`}
          onClick={() => setSort({ key, direction: next })}>
          {label}<Arrow size={12} aria-hidden="true" />
        </button>
      </th>
    )
  }
  return (
    <table className="breakdown-table model-table" aria-label="按模型统计">
      <thead><tr>
        <th scope="col"><span aria-hidden="true">#</span><span className="sr-only">序号</span></th>
        <th scope="col">模型</th>
        {sortColumn('cost', '费用')}
        <th scope="col" title={metric === 'cost' ? '费用占比' : 'token 占比'}>占比</th>
        {sortColumn('tokens', 'token')}
      </tr></thead>
      <tbody>
        {sorted.length === 0 ? <tr><td colSpan={5} className="empty-cell">这段时间暂无用量</td></tr> :
          sorted.map((model, index) => {
            const key = `${model.provider}:${model.model}`
            const value = metricValue(model, metric)
            const share = metric === 'cost' && model.costUnknown ? null : total > 0 ? value / total : 0
            return (
              <tr className="model-row" key={key}>
                <td className="text-xs">{index + 1}</td>
                <th scope="row">
                  <button type="button" className="model-row-button" aria-haspopup="dialog" onClick={() => onModel(model)}>
                    <ProviderMark provider={model.provider} className="size-3.5" />
                    <span className="sr-only">{providerInfo[model.provider].label}：</span>
                    <span className="min-w-0 wrap-anywhere">{model.model}</span>
                  </button>
                  {value > 0 && peak > 0 && (
                    <div className="model-share-track" aria-hidden="true">
                      <div style={{ width: `max(5px, ${value / peak * 100}%)`, backgroundColor: providerInfo[model.provider].color }} />
                    </div>
                  )}
                </th>
                <td className={model.costUnknown ? undefined : 'text-ink'}>{formatUsageCost(model)}</td>
                <td>{share === null ? '—' : formatPercent(share)}</td>
                <td>{formatTokens(model.tokens)}</td>
              </tr>
            )
          })}
      </tbody>
    </table>
  )
}

function DayTable({ buckets, activeProviders, metric }: {
  buckets: readonly UsageBucket[]; activeProviders: readonly UsageProviderKind[]; metric: UsageMetric
}) {
  const days = useMemo(() => [...groupBuckets(buckets, (bucket) => bucket.day)]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, group]) => ({
      day, values: usageFigures(group),
      byProvider: new Map(Array.from(groupBuckets(group, (bucket) => bucket.provider), ([provider, list]) => [
        provider, usageFigures(list)
      ] as const))
    })), [buckets])
  return (
    <div className="breakdown-scroll" tabIndex={0} role="region" aria-label="按天统计">
      <table className="breakdown-table day-table" aria-label={`按天统计，提供方列显示${metric === 'cost' ? '费用' : 'token'}`}>
        <thead><tr>
          <th scope="col">日期</th>
          {activeProviders.map((provider) => <th scope="col" key={provider}>{providerInfo[provider].label}</th>)}
          <th scope="col">费用</th>
          <th scope="col">token</th>
        </tr></thead>
        <tbody>
          {days.length === 0 ? <tr><td colSpan={activeProviders.length + 3} className="empty-cell">这段时间暂无用量</td></tr> :
            days.map(({ day, values, byProvider }) => (
              <tr key={day}>
                <th scope="row">{dateFormat.format(new Date(`${day}T00:00:00Z`))}</th>
                {activeProviders.map((provider) => {
                  const value = byProvider.get(provider)
                  return <td key={provider}>{!value ? '—' : metric === 'cost' ? formatUsageCost(value) : formatMetric(value.tokens, metric)}</td>
                })}
                <td className={metric === 'cost' ? 'text-ink' : undefined}>{formatUsageCost(values)}</td>
                <td className={metric === 'tokens' ? 'text-ink' : undefined}>{formatTokens(values.tokens)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}

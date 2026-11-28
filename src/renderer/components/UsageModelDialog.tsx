import { CircleHelp, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UsageBucket, UsageModelPrice, UsageProviderKind, UsageSummaryInput } from '../../shared/types'
import { describePeakSchedules, peakPeriodLabel } from '../../shared/pricingMultipliers'
import { formatPercent, formatTokens, formatUsd } from '../../shared/usageFormat'
import { formatUsageCost, providerInfo, trendTitle, usageFigures, usageSegments, visibleUsage, type UsageMetric, type UsageModel } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import { UsageDialog } from './UsageDialog'
import { UsageProviderChart } from './UsageProviderChart'
import { UsageShareBar } from './UsageShareBar'

export function UsageModelDialog({ model, buckets, query, metric, hiddenProviders, price, onRefresh, onPrice, onClose }: {
  model: UsageModel; buckets: readonly UsageBucket[]; query: UsageSummaryInput; metric: UsageMetric
  hiddenProviders: ReadonlySet<UsageProviderKind>; price?: UsageModelPrice
  onRefresh: () => Promise<void> | void
  onPrice: () => void; onClose: () => void
}) {
  const filteredBuckets = useMemo(() => visibleUsage(buckets, hiddenProviders), [buckets, hiddenProviders])
  const modelBuckets = useMemo(() => filteredBuckets.filter((bucket) => bucket.provider === model.provider &&
    bucket.model === model.model), [filteredBuckets, model])
  const values = useMemo(() => usageFigures(modelBuckets), [modelBuckets])
  const total = useMemo(() => usageFigures(filteredBuckets).costUsd, [filteredBuckets])
  const [refreshing, setRefreshing] = useState(false)

  // Stage 1 ends the spinner; the background stage 2 never re-locks the button.
  const refresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }, [onRefresh, refreshing])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat || refreshing ||
          event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'r') return
      const target = event.target
      if (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest('input, select, textarea'))) return
      event.preventDefault()
      void refresh()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [refresh, refreshing])

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
      title={<>
        <ProviderMark provider={model.provider} className="size-5" />{model.model}
        {price && <ModelPriceNote price={price} timeZone={query.timeZone} />}
      </>}
      subtitle={`${providerInfo[model.provider].label}${!values.costUnknown && total > 0
        ? ` · ${formatPercent(values.costUsd / total)} 费用占比` : ''}`}
      headerActions={(
        <button type="button" className="icon-button" aria-label="刷新用量" title="刷新用量 (R)"
          aria-busy={refreshing} disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw size={15} className={refreshing ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
        </button>
      )}>
      <div className="dialog-body model-dialog-body">
        <dl className="model-stats">
          {stats.map(([label, value]) => (
            <div className="stat" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
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

function priceText(value: number): string {
  return String(Number(value.toPrecision(6)))
}

function peakPriceParts(price: UsageModelPrice, factor: number): string[] {
  const fields: [string, number | undefined][] = [
    ['入', price.inputCostPerMillionTokens],
    ['出', price.outputCostPerMillionTokens],
    ['读', price.cacheReadCostPerMillionTokens],
    ['创', price.cacheWriteCostPerMillionTokens]
  ]
  return fields.flatMap(([label, value]) => typeof value === 'number'
    ? [`${label} ${priceText(value * factor)}`] : [])
}

const priceRows = [
  ['输入', 'inputCostPerMillionTokens'],
  ['输出', 'outputCostPerMillionTokens'],
  ['缓存读取', 'cacheReadCostPerMillionTokens'],
  ['缓存创建', 'cacheWriteCostPerMillionTokens']
] as const

function ModelPriceNote({ price, timeZone }: { price: UsageModelPrice; timeZone: string }) {
  const id = useId()
  const note = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLSpanElement>(null)
  const [dismissed, setDismissed] = useState(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const schedules = describePeakSchedules(price.multipliers, timeZone)
  const singleSchedule = schedules.length === 1 ? schedules[0] : undefined

  const place = useCallback(() => {
    const anchor = note.current
    const panel = tip.current
    if (!anchor || !panel || panel.offsetWidth === 0) return
    const rect = anchor.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      setPosition(null)
      return
    }
    const edge = 8
    const gap = 7
    const left = Math.round(Math.min(
      Math.max(edge, rect.left),
      Math.max(edge, window.innerWidth - panel.offsetWidth - edge)
    ))
    const below = rect.bottom + gap + panel.offsetHeight <= window.innerHeight - edge
    const top = Math.round(below ? rect.bottom + gap : Math.max(edge, rect.top - panel.offsetHeight - gap))
    setPosition((current) => current?.left === left && current?.top === top ? current : { left, top })
  }, [])

  useLayoutEffect(() => {
    place()
  }, [dismissed, open, place])

  useEffect(() => {
    function update() { place() }
    function hide() { setDismissed(true) }
    window.addEventListener('resize', update)
    // Capture scroll so the dialog body's own scroll also drops the stale anchor.
    window.addEventListener('scroll', update, true)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('blur', hide)
    }
  }, [place])

  return (
    <span ref={note} className="model-price-note" data-dismissed={dismissed}
      onPointerEnter={() => { setDismissed(false); setOpen(true); place() }}
      onPointerLeave={() => setOpen(false)}>
      <button type="button" aria-label="查看生效单价" aria-describedby={id}
        onFocus={() => { setDismissed(false); setOpen(true); place() }}
        onBlur={() => setOpen(false)}
        onClick={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || dismissed) return
          event.preventDefault()
          event.stopPropagation()
          setDismissed(true)
        }}>
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      <span ref={tip} id={id} role="tooltip" className="model-price-tip"
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          visibility: position ? 'visible' : 'hidden'
        }}>
        <span className={`model-price-table${singleSchedule ? ' model-price-table-peak' : ''}`}
          role="table" aria-label="生效单价">
          <span className="model-price-row model-price-head" role="row">
            <span role="columnheader">类型</span>
            {singleSchedule ? (
              <>
                <span role="columnheader">峰期（美元/M）</span>
                <span role="columnheader">谷期（美元/M）</span>
              </>
            ) : (
              <span role="columnheader">价格（美元/M）</span>
            )}
          </span>
          {priceRows.map(([label, key]) => {
            const value = price[key]
            if (singleSchedule) {
              const { factor } = singleSchedule
              const peak = value === undefined ? undefined : (factor < 1 ? value : value * factor)
              const offPeak = value === undefined ? undefined : (factor < 1 ? value * factor : value)
              return (
                <span className="model-price-row" role="row" key={key}>
                  <span role="cell">{label}</span>
                  <strong role="cell">{peak === undefined ? '—' : priceText(peak)}</strong>
                  <strong role="cell">{offPeak === undefined ? '—' : priceText(offPeak)}</strong>
                </span>
              )
            }
            return (
              <span className="model-price-row" role="row" key={key}>
                <span role="cell">{label}</span>
                <strong role="cell">{value === undefined ? '—' : priceText(value)}</strong>
              </span>
            )
          })}
        </span>
        {price.tiers?.map((tier) => (
          <span className="model-price-extra" key={tier.threshold}>
            超过 {formatTokens(tier.threshold)}：输入 {priceText(tier.inputCostPerMillionTokens)} ·
            输出 {priceText(tier.outputCostPerMillionTokens)}
            {tier.cacheReadCostPerMillionTokens === undefined ? '' : ` · 缓存读取 ${priceText(tier.cacheReadCostPerMillionTokens)}`}
            {tier.cacheWriteCostPerMillionTokens === undefined ? '' : ` · 缓存创建 ${priceText(tier.cacheWriteCostPerMillionTokens)}`}
          </span>
        ))}
        {singleSchedule ? (
          <span className="model-price-extra">
            {peakPeriodLabel(singleSchedule.factor)}：{singleSchedule.schedule}
          </span>
        ) : schedules.map(({ schedule, factor }) => {
          const prices = peakPriceParts(price, factor)
          return (
            <span className="model-price-extra" key={`${schedule}:${factor}`}>
              {peakPeriodLabel(factor)}：{schedule}{prices.length ? `（${prices.join(' · ')}）` : ''}
            </span>
          )
        })}
        {price.custom && <span className="model-price-extra model-price-custom">自定义价格</span>}
      </span>
    </span>
  )
}

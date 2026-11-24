import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { totalTokens, type UsageBucket, type UsageProviderKind, type UsageSummaryInput } from '../../shared/types'
import { formatTokens, formatUsd } from '../../shared/usageFormat'
import { providerInfo, trendTitle, usageDayFormat } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import '../styles/usageAnalytics.css'

type Metric = 'cost' | 'tokens'

const PROVIDERS = (['codex', 'claude', 'opencode', 'antigravity'] as const).map((id) => ({
  id, name: providerInfo[id].label, color: providerInfo[id].color
}))
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const WIDTH = 960
const HEIGHT = 260
const TOP = 10
const BASELINE = 260

type Column = { period: string; values: Record<UsageProviderKind, number>; total: number }

export function buildUsageChartColumns(
  buckets: readonly UsageBucket[],
  query: UsageSummaryInput,
  metric: Metric
) {
  const hourly = query.resolution === 'hour'
  const start = hourly ? Date.parse(query.sinceTime ?? '') : Date.parse(query.sinceDay)
  const end = hourly ? Date.parse(query.untilTime ?? '') : Date.parse(query.untilDay) + DAY_MS
  const columns: Column[] = []
  const byPeriod = new Map<string, Column>()
  // Hours are elapsed-time slots anchored at the exact lower bound, not at a clock hour.
  // Daily keys are already IANA-local dates: step through calendar labels, not local instants.
  for (let ms = start; ms < end; ms += hourly ? HOUR_MS : DAY_MS) {
    const iso = new Date(ms).toISOString()
    const period = hourly ? iso : iso.slice(0, 10)
    const column = { period, values: { antigravity: 0, opencode: 0, codex: 0, claude: 0 }, total: 0 }
    columns.push(column)
    byPeriod.set(period, column)
  }
  const present = new Set<UsageProviderKind>()
  for (const bucket of buckets) {
    const column = byPeriod.get((hourly ? bucket.hourStart : bucket.day) ?? '')
    if (!column) continue
    const value = metric === 'cost' ? bucket.costUsd : totalTokens(bucket.totals)
    // An anchored hour spanning midnight can contain multiple day keys.
    column.values[bucket.provider] += value
    column.total += value
    present.add(bucket.provider)
  }
  return { columns, providers: PROVIDERS.filter(({ id }) => present.has(id)) }
}

type Point = { x: number; y: number }
type CurveSegment = { from: Point; c1: Point; c2: Point; to: Point }

// Monotone cubic interpolation adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length
  if (count < 2) return [0]

  const slopes: number[] = []
  for (let index = 0; index < count - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x
    const dy = points[index + 1].y - points[index].y
    slopes.push(dx === 0 ? 0 : dy / dx)
  }

  const tangents = Array<number>(count).fill(0)
  tangents[0] = slopes[0]
  tangents[count - 1] = slopes[count - 2]
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1]
    const next = slopes[index]
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index]
    if (slope === 0) {
      tangents[index] = 0
      tangents[index + 1] = 0
      continue
    }
    const a = tangents[index] / slope
    const b = tangents[index + 1] / slope
    const magnitude = a * a + b * b
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude)
      tangents[index] = scale * a * slope
      tangents[index + 1] = scale * b * slope
    }
  }
  return tangents
}

export function smoothCurve(points: readonly Point[]): readonly CurveSegment[] {
  if (points.length < 2) return []
  const tangents = monotoneTangents(points)
  const segments: CurveSegment[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]
    const to = points[index + 1]
    const dx = to.x - from.x
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + (tangents[index] * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - (tangents[index + 1] * dx) / 3 },
      to
    })
  }
  return segments
}

function curvePath(segments: readonly CurveSegment[]): string {
  const first = segments[0]
  if (!first) return ''
  const xy = ({ x, y }: Point) => `${x.toFixed(2)},${y.toFixed(2)}`
  return `M${xy(first.from)}${segments.map(({ c1, c2, to }) => ` C${xy(c1)} ${xy(c2)} ${xy(to)}`).join('')}`
}

function scaleFor(peak: number, metric: Metric): { max: number; ticks: number[]; empty: boolean } {
  if (peak <= 0) return { max: 4, ticks: [0, 1, 2, 3, 4], empty: true }
  const rawStep = peak / 4
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const preferred = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude
  const step = Math.max(metric === 'tokens' ? 1 : 0.01, preferred)
  const count = Math.ceil(peak / step)
  return { max: count * step, ticks: Array.from({ length: count + 1 }, (_, i) => i * step), empty: false }
}

const formatValue = (value: number, metric: Metric) => metric === 'cost' ? formatUsd(value) : formatTokens(value)
const formatAxis = (value: number, metric: Metric) => value === 0 ? '0' : formatValue(value, metric)

function periodFormatters(query: UsageSummaryInput, includeSeconds: boolean) {
  const hourly = query.resolution === 'hour'
  // UTC here preserves the local date key; hourly keys are actual UTC instants.
  const timeZone = hourly ? query.timeZone : 'UTC'
  return {
    axis: hourly ? new Intl.DateTimeFormat('zh-CN', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }) : usageDayFormat,
    detail: hourly ? new Intl.DateTimeFormat('zh-CN', {
      timeZone, month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
      ...(includeSeconds ? { second: '2-digit' } : {})
    }) : usageDayFormat
  }
}

export function chartTipOffset(at: number, panelSize: number, tipSize: number): number {
  const gap = 8
  const candidate = at + gap + tipSize <= panelSize ? at + gap : at - gap - tipSize
  return Math.max(0, Math.min(panelSize - tipSize, candidate))
}

interface Props {
  buckets: readonly UsageBucket[]
  query: UsageSummaryInput
  metric: Metric
}

export function UsageProviderChart({ buckets, query, metric }: Props) {
  const chart = useMemo(() => {
    const { columns, providers } = buildUsageChartColumns(buckets, query, metric)
    const peak = columns.reduce((max, { values }) =>
      providers.reduce((inner, { id }) => Math.max(inner, values[id]), max), 0)
    const scale = scaleFor(peak, metric)
    const x = (index: number) => columns.length < 2 ? WIDTH / 2 : (index / (columns.length - 1)) * WIDTH
    const y = (value: number) => BASELINE - (value / scale.max) * (BASELINE - TOP)
    const paths = providers.map((provider) => {
      const points = columns.map(({ values }, i) => ({ x: x(i), y: y(values[provider.id]) }))
      return {
        ...provider, points,
        line: curvePath(smoothCurve(points)),
        total: columns.reduce((sum, { values }) => sum + values[provider.id], 0)
      }
    }).filter(({ total }) => total > 0).sort((a, b) => b.total - a.total)
    const includeSeconds = Boolean(query.sinceTime && Date.parse(query.sinceTime) % 60_000)
    return { columns, providers, scale, x, y, paths, ...periodFormatters(query, includeSeconds) }
  }, [buckets, metric, query])
  const { columns, providers, scale, x, y, paths, axis, detail } = chart
  const uid = useId()
  const plot = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<(Point & { period: string }) | null>(null)
  const [keyboard, setKeyboard] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const lastIndex = columns.length - 1
  const selected = columns.findIndex(({ period }) => period === (hover?.period ?? keyboard))
  const active = selected < 0 && focused ? lastIndex : selected
  const column = providers.length > 0 ? columns[active] : undefined
  const label = trendTitle(query, metric)
  const amount = (value: number) => formatValue(value, metric)
  const dateLabel = column ? detail.format(new Date(column.period)) : ''
  const axisIndices = [...new Set([0, ...(lastIndex > 2 ? [Math.floor(lastIndex / 2)] : []), lastIndex])].filter(i => columns[i])
  const activeX = x(active)
  const showTip = Boolean(column)

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(box.width, event.clientX - box.left))
    const y = Math.max(0, Math.min(box.height, event.clientY - box.top))
    const index = Math.min(lastIndex, Math.max(0, Math.round((x / box.width) * lastIndex)))
    const period = columns[index]?.period
    setHover(period ? { x, y, period } : null)
  }

  const placeTooltip = useCallback((pointer: Point | null, anchoredX: number) => {
    const plane = plot.current
    const tooltip = tip.current
    if (!plane || !tooltip) return
    const { clientWidth: width, clientHeight: height } = plane
    const { offsetWidth, offsetHeight } = tooltip
    const left = chartTipOffset(pointer?.x ?? (anchoredX / WIDTH) * width, width, offsetWidth)
    const top = chartTipOffset(pointer?.y ?? (TOP / HEIGHT) * height, height, offsetHeight)
    tooltip.style.transform = `translate(${left}px, ${top}px)`
  }, [])

  const coordinates = useRef({ hover, activeX })
  useLayoutEffect(() => {
    coordinates.current = { hover, activeX }
    placeTooltip(hover, activeX)
  }, [activeX, column, hover, placeTooltip])
  useLayoutEffect(() => {
    const plane = plot.current
    const tooltip = tip.current
    if (!showTip || !plane || !tooltip) return
    // The measured tooltip may change when narrow columns wrap or fonts load.
    const observer = new ResizeObserver(() => {
      const { hover, activeX } = coordinates.current
      placeTooltip(hover, activeX)
    })
    observer.observe(plane)
    observer.observe(tooltip)
    return () => observer.disconnect()
  }, [placeTooltip, showTip])

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (lastIndex < 0 || providers.length === 0) return
    const from = active < 0 ? lastIndex : active
    const next = ({
      ArrowLeft: Math.max(0, from - 1),
      ArrowRight: Math.min(lastIndex, from + 1),
      Home: 0,
      End: lastIndex
    } as Record<string, number>)[event.key]
    if (typeof next !== 'number') return
    event.preventDefault()
    setFocused(true)
    setHover(null)
    setKeyboard(columns[next].period)
  }

  return (
    <div className="ud-usage-chart">
      <div className="ud-usage-chart-y" aria-hidden>
        {scale.ticks.filter(tick => !scale.empty || tick === 0).map(tick => (
          <span key={tick} style={{ top: `${y(tick) / HEIGHT * 100}%` }}>{formatAxis(tick, metric)}</span>
        ))}
      </div>
      <div
        ref={plot}
        className="ud-usage-chart-plot"
        role="group"
        aria-label={label}
        aria-describedby={`${uid}-help`}
        tabIndex={0}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setFocused(true) }}
        onBlur={() => { setFocused(false); setKeyboard(null); setHover(null) }}
        onKeyDown={navigate}
        onPointerMove={event => { if (event.pointerType !== 'touch') trackPointer(event) }}
        onPointerLeave={event => { if (event.pointerType !== 'touch') setHover(null) }}
        onPointerDown={event => { if (event.pointerType === 'touch') trackPointer(event) }}
        onPointerCancel={() => setHover(null)}
      >
        <svg aria-hidden="true" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
          <defs>
            {paths.map(({ id, color }) => (
              <linearGradient key={id} id={`${uid}-${id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.14} />
                <stop offset="100%" stopColor={color} stopOpacity={0.11} />
              </linearGradient>
            ))}
          </defs>
          {scale.ticks.map(tick => (
            <line key={tick} x1="0" x2={WIDTH} y1={y(tick)} y2={y(tick)}
              stroke={tick === 0 ? 'rgb(255 255 255 / 0.14)' : 'rgb(255 255 255 / 0.08)'} vectorEffect="non-scaling-stroke" />
          ))}
          {paths.map(({ id, line }) => line && (
            <path key={id} d={`${line} L${WIDTH},${BASELINE} L0,${BASELINE} Z`} fill={`url(#${uid}-${id})`} />
          ))}
          {paths.map(({ id, color, line }) => line && (
            <path key={id} d={line} fill="none" stroke={color} strokeWidth="1.65"
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          ))}
          {columns.length === 1 && paths.map(({ id, color, points: [point] }) => (
            <line key={id} x1={point.x - 6} x2={point.x + 6} y1={point.y} y2={point.y}
              stroke={color} strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
          {column && (
            <line x1={activeX} x2={activeX} y1={TOP} y2={BASELINE} stroke="#818181" strokeWidth={1}
              vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {column && (
          <div className="ud-usage-chart-tip" ref={tip} aria-hidden="true">
            <div className="ud-usage-chart-date">{dateLabel}</div>
            {providers.map(({ id, name }) => (
              <div className="ud-usage-chart-row" key={id}>
                <span><ProviderMark provider={id} className="size-3" />{name}</span>
                <span>{amount(column.values[id])}</span>
              </div>
            ))}
            <div className="ud-usage-chart-row ud-usage-chart-total">
              <span>总计</span><span>{amount(column.total)}</span>
            </div>
          </div>
        )}
        <span id={`${uid}-help`} className="sr-only">用左右方向键查看各时段用量。</span>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {focused && !hover && column && [
            dateLabel,
            ...providers.map(({ id, name }) => `${name} ${amount(column.values[id])}`),
            `总计 ${amount(column.total)}`
          ].join('，')}
        </span>
      </div>
      <div className="ud-usage-chart-x" aria-hidden>
        {axisIndices.map(index => (
          <span key={index} style={{ left: `${x(index) / WIDTH * 100}%`, translate:
            index === lastIndex && index > 0 ? '-100%' : index === 0 && lastIndex > 0 ? '0%' : '-50%'
          }}>{axis.format(new Date(columns[index].period))}</span>
        ))}
      </div>
    </div>
  )
}

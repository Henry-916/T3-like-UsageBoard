import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { totalTokens, type UsageBucket, type UsageProviderKind, type UsageSummaryInput } from '../../shared/types'

type Metric = 'cost' | 'tokens'

const PROVIDERS = [
  { id: 'antigravity', name: 'Antigravity', color: '#8c7bd1' },
  { id: 'opencode', name: 'OpenCode', color: '#5b9bbd' },
  { id: 'codex', name: 'Codex', color: '#e4e4e7' },
  { id: 'claude', name: 'Claude Code', color: '#d97757' }
] as const
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const WIDTH = 960
const HEIGHT = 260
const TOP = 12
const BASELINE = 248

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
  const step = metric === 'tokens' ? Math.max(1, preferred) : (preferred || peak)
  const count = Math.ceil(peak / step)
  return { max: count * step, ticks: Array.from({ length: count + 1 }, (_, i) => i * step), empty: false }
}

const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 })
const usd = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 2, maximumFractionDigits: 8
})
const smallUsd = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
  notation: 'scientific', maximumFractionDigits: 3
})
const axisUsd = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol',
  notation: 'compact', maximumFractionDigits: 4
})
const formatUsd = (value: number) => (value !== 0 && Math.abs(value) < 1e-8 ? smallUsd : usd).format(value)
const formatValue = (value: number, metric: Metric) => metric === 'cost' ? formatUsd(value) : integer.format(value)
const formatAxis = (value: number, metric: Metric) =>
  value === 0 ? '0' : metric === 'tokens' ? compact.format(value) :
    (value < 0.0001 ? smallUsd : axisUsd).format(value)

function periodFormatters(query: UsageSummaryInput, includeSeconds: boolean) {
  const hourly = query.resolution === 'hour'
  // UTC here preserves the local date key; hourly keys are actual UTC instants.
  const timeZone = hourly ? query.timeZone : 'UTC'
  return {
    axis: new Intl.DateTimeFormat('zh-CN', hourly
      ? { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { timeZone, month: 'numeric', day: 'numeric' }),
    detail: new Intl.DateTimeFormat('zh-CN', {
      timeZone, year: 'numeric', month: 'long', day: 'numeric',
      ...(hourly ? {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
        ...(includeSeconds ? { second: '2-digit' } : {})
      } as const : {})
    })
  }
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
  const [hover, setHover] = useState<string | null>(null)
  const [keyboard, setKeyboard] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const lastIndex = columns.length - 1
  const selected = columns.findIndex(({ period }) => period === (hover ?? keyboard))
  const active = selected < 0 && focused ? lastIndex : selected
  const column = columns[active]
  const label = `${query.resolution === 'hour' ? '每小时' : '每日'}${metric === 'cost' ? '费用' : ' token'}趋势`
  const amount = (value: number) => formatValue(value, metric)
  const dateLabel = column ? detail.format(new Date(column.period)) : ''
  const axisIndices = [...new Set([0, Math.floor(lastIndex / 2), lastIndex])].filter(i => columns[i])
  const activeX = x(active)

  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return Math.min(lastIndex, Math.max(0, Math.round(((event.clientX - box.left) / box.width) * lastIndex)))
  }

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (lastIndex < 0) return
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
      <style>{styles}</style>
      <div className="ud-usage-chart-y" aria-hidden>
        {scale.ticks.filter(tick => !scale.empty || tick === 0).map(tick => (
          <span key={tick} style={{ top: `${y(tick) / HEIGHT * 100}%` }}>{formatAxis(tick, metric)}</span>
        ))}
      </div>
      <div
        className="ud-usage-chart-plot"
        role="group"
        aria-label={label}
        aria-describedby={`${uid}-help`}
        tabIndex={0}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setFocused(true) }}
        onBlur={() => { setFocused(false); setKeyboard(null); setHover(null) }}
        onKeyDown={navigate}
        onPointerMove={event => { if (event.pointerType !== 'touch') setHover(columns[indexAt(event)]?.period ?? null) }}
        onPointerLeave={() => setHover(null)}
        onPointerDown={event => { if (event.pointerType === 'touch') setKeyboard(columns[indexAt(event)]?.period ?? null) }}
      >
        <svg aria-hidden="true" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
          <defs>
            {paths.map(({ id, color }) => (
              <linearGradient key={id} id={`${uid}-${id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.23} />
                <stop offset="100%" stopColor={color} stopOpacity={0.025} />
              </linearGradient>
            ))}
          </defs>
          {scale.ticks.map(tick => (
            <line key={tick} x1="0" x2={WIDTH} y1={y(tick)} y2={y(tick)}
              stroke={tick === 0 ? '#ffffff24' : '#ffffff13'} vectorEffect="non-scaling-stroke" />
          ))}
          {paths.map(({ id, line }) => line && (
            <path key={id} d={`${line} L${WIDTH},${BASELINE} L0,${BASELINE} Z`} fill={`url(#${uid}-${id})`} />
          ))}
          {paths.map(({ id, color, line }) => line && (
            <path key={id} d={line} fill="none" stroke={color} strokeWidth="1.65"
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          ))}
          {column && (
            <line x1={activeX} x2={activeX} y1={TOP} y2={BASELINE} stroke="#f4f4f57a"
              vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {paths.map(({ id, color, points }) => {
          const point = points[columns.length === 1 ? 0 : active]
          if (!point || (column && column.values[id] === 0)) return null
          return <span key={id} aria-hidden className="ud-usage-chart-point" style={{
            left: `${point.x / WIDTH * 100}%`, top: `${point.y / HEIGHT * 100}%`, background: color
          }} />
        })}
        {column && (
          <div className="ud-usage-chart-tip" aria-hidden="true" style={{
            [activeX <= WIDTH / 2 ? 'left' : 'right']: `clamp(0px, calc(${(activeX <= WIDTH / 2 ? activeX : WIDTH - activeX) / WIDTH * 100}% + 10px), max(0px, calc(100% - 14rem)))`
          }}>
            <div className="ud-usage-chart-date">{dateLabel}</div>
            {providers.map(({ id, name, color }) => (
              <div className="ud-usage-chart-row" key={id}>
                <span><i style={{ background: color }} />{name}</span>
                <span>{amount(column.values[id])}</span>
              </div>
            ))}
            <div className="ud-usage-chart-row ud-usage-chart-total">
              <span>合计</span><span>{amount(column.total)}</span>
            </div>
          </div>
        )}
        <span id={`${uid}-help`} className="sr-only">用左右方向键查看各时段用量。</span>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {focused && !hover && column && [
            dateLabel,
            ...providers.map(({ id, name }) => `${name} ${amount(column.values[id])}`),
            `合计 ${amount(column.total)}`
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

const styles = `
.ud-usage-chart {
  display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); grid-template-rows: minmax(13rem, 1fr) 1.3rem;
  min-width: 0; min-height: 14.3rem; height: 100%; column-gap: .7rem;
  color: var(--color-subtle, #a1a1aa); font-size: .8125rem; font-variant-numeric: tabular-nums;
}
.ud-usage-chart-y, .ud-usage-chart-x, .ud-usage-chart-plot { position: relative; min-width: 0; }
.ud-usage-chart-y span { position: absolute; right: 0; translate: 0 -50%; white-space: nowrap; }
.ud-usage-chart-x { grid-column: 2; }
.ud-usage-chart-x span { position: absolute; bottom: 0; white-space: nowrap; }
.ud-usage-chart-plot { outline: none; }
.ud-usage-chart-plot:focus-visible { outline: 1px solid #a1a1aa; outline-offset: 4px; border-radius: 3px; }
.ud-usage-chart-plot > svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; overflow: visible; }
.ud-usage-chart-point {
  position: absolute; width: 7px; height: 7px; border-radius: 50%; translate: -50% -50%;
  border: 1px solid var(--color-canvas, #09090b); pointer-events: none;
}
.ud-usage-chart-tip {
  position: absolute; z-index: 2; top: .7rem; width: min(14rem, 100%); box-sizing: border-box;
  padding: .6rem .7rem; pointer-events: none; border: 1px solid #ffffff18; border-radius: .55rem;
  background: #17171a; color: var(--color-ink, #e4e4e7); box-shadow: 0 6px 22px #0007;
}
.ud-usage-chart-date { color: var(--color-subtle, #a1a1aa); margin-bottom: .3rem; }
.ud-usage-chart-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 .5rem; }
.ud-usage-chart-row > span:first-child { display: inline-flex; align-items: center; gap: .4rem; }
.ud-usage-chart-row > span:last-child { margin-left: auto; }
.ud-usage-chart-row i { width: .45rem; height: .45rem; border-radius: 50%; }
.ud-usage-chart-total { border-top: 1px solid #ffffff18; margin-top: .35rem; padding-top: .35rem; font-weight: 600; }
`

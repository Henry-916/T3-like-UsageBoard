import { formatPercent } from '../../shared/usageFormat'
import { formatMetric, type ShareSegment, type UsageMetric } from '../usagePresentation'

const color = (intensity: number) => `color-mix(in oklab, var(--color-ink) ${intensity}%, var(--color-canvas))`

export function UsageShareBar({ label, segments, metric }: {
  label: string; segments: readonly ShareSegment[]; metric: UsageMetric
}) {
  const visible = segments.filter(({ value }) => value > 0)
  const total = visible.reduce((sum, { value }) => sum + value, 0)
  return (
    <section className="share-section">
      <h2 className="section-title">{label}</h2>
      <div className="share-bar" aria-hidden="true">
        {visible.map((segment) => (
          <span key={segment.label}
            style={{ flex: `${segment.value} 1 0`, backgroundColor: color(segment.intensity) }}
            title={`${segment.label} · ${formatMetric(segment.value, metric)} · ${formatPercent(segment.value / total)}`} />
        ))}
      </div>
      <ul className="share-legend" aria-label={label}>
        {segments.map((segment) => (
          <li key={segment.label}>
            <span className="share-swatch" style={{ backgroundColor: color(segment.intensity) }} aria-hidden="true" />
            <span>{segment.label}</span>
            <strong>{formatMetric(segment.value, metric)}</strong>
            <span className="sr-only">，{formatPercent(total > 0 ? segment.value / total : 0)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

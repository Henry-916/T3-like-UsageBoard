import { formatPercent } from '../../shared/usageFormat'
import { formatMetric, type ShareSegment, type UsageMetric } from '../usagePresentation'

export function UsageShareBar({ label, segments, metric }: {
  label: string; segments: readonly ShareSegment[]; metric: UsageMetric
}) {
  const visible = segments.filter(({ value }) => value > 0)
  const total = visible.reduce((sum, { value }) => sum + value, 0)
  return (
    <section className="share-section">
      <h2 className="section-title">{label}</h2>
      {visible.length > 0 && <div className="share-bar" aria-hidden="true">
        {visible.map((segment) => (
          <span key={segment.label}
            style={{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }}
            title={`${segment.label} · ${formatMetric(segment.value, metric)} · ${formatPercent(segment.value / total)}`} />
        ))}
      </div>}
      {visible.length > 0 && <ul className="share-legend" aria-label={label}>
        {visible.map((segment) => (
          <li key={segment.label}>
            <span className="share-swatch" style={{ backgroundColor: segment.color }} aria-hidden="true" />
            <span>{segment.label}</span>
            <strong>{formatMetric(segment.value, metric)}</strong>
            <span className="sr-only">，{formatPercent(segment.value / total)}</span>
          </li>
        ))}
      </ul>}
    </section>
  )
}

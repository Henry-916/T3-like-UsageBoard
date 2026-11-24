import { formatTokens, formatUsd } from '../../shared/usageFormat'
import type { UsageFigures } from '../usagePresentation'

export function TotalsStrip({ values }: { values: UsageFigures }) {
  const stats = [
    ['处理的 token', formatTokens(values.tokens)],
    ['缓存的输入', formatTokens(values.totals.cachedInputTokens)],
    ['未缓存的输入', formatTokens(values.totals.uncachedInputTokens)],
    ['输出', formatTokens(values.totals.outputTokens)],
    ['缓存节省', formatUsd(values.cacheSavingsUsd)]
  ]
  return (
    <section className="flex flex-col gap-2">
      <h2 className="section-title">总计</h2>
      <dl className="totals-grid">
        {stats.map(([label, value]) => (
          <div key={label} className="stat">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

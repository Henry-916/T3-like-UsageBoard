import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { UsageModelDialog } from '../src/renderer/components/UsageModelDialog'
import { EMPTY_TOTALS, type UsageProviderKind } from '../src/shared/types'

vi.mock('../src/renderer/components/UsageDialog', () => ({
  UsageDialog: ({ title, subtitle, children, headerActions }: any) =>
    createElement('section', null, title, subtitle, headerActions, children)
}))

it('renders the model price tooltip and refresh action', () => {
  const html = renderToStaticMarkup(createElement(UsageModelDialog, {
    model: { provider: 'opencode', model: 'alibaba-cn/deepseek-v4.1-flash-1017' },
    buckets: [{
      day: '2026-11-24', provider: 'opencode', model: 'alibaba-cn/deepseek-v4.1-flash-1017',
      costUsd: 1, cacheSavingsUsd: 0, costSource: 'modelPriced',
      totals: { ...EMPTY_TOTALS, uncachedInputTokens: 1000, outputTokens: 100 },
      unpricedRecords: 0, records: 1, sessions: 1,
      categoryCostUsd: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0.5 }
    }],
    query: { sinceDay: '2026-11-01', untilDay: '2026-11-24', timeZone: 'Asia/Shanghai' },
    metric: 'cost',
    hiddenProviders: new Set<UsageProviderKind>(),
    price: {
      inputCostPerMillionTokens: 0.28, outputCostPerMillionTokens: 1.13,
      cacheReadCostPerMillionTokens: 0.028, cacheWriteCostPerMillionTokens: 0.28,
      multipliers: [{ when: { utc_hours: { gte: '14:00' } }, factor: 0.5 }]
    },
    onRefresh: async () => undefined,
    onPrice: () => undefined, onClose: () => undefined
  }))
  expect(html).toContain('每百万 token')
  expect(html).toContain('查看生效单价')
  expect(html).toContain('价格（美元/M）')
  expect(html).toContain('类型')
  expect(html).toContain('0.28')
  expect(html).toContain('1.13')
  expect(html).toContain('0.028')
  expect(html).not.toContain('美元 / 百万 token')
  expect(html).toContain('峰谷计价')
  expect(html).toContain('22:00–08:00 ×0.5')
  expect(html).toContain('峰谷单价')
  expect(html).toContain('入 0.14')
  expect(html).toContain('刷新用量 (R)')
  // The help button now sits in the title, before the stat grid.
  expect(html.indexOf('查看生效单价')).toBeLessThan(html.indexOf('每百万 token'))
})

it('does not render a peak row for service-tier or date multipliers', () => {
  const html = renderToStaticMarkup(createElement(UsageModelDialog, {
    model: { provider: 'opencode', model: 'openai/gpt-6.2-sol' },
    buckets: [{
      day: '2026-11-24', provider: 'opencode', model: 'openai/gpt-6.2-sol',
      costUsd: 1, cacheSavingsUsd: 0, costSource: 'modelPriced',
      totals: { ...EMPTY_TOTALS, uncachedInputTokens: 1000, outputTokens: 100 },
      unpricedRecords: 0, records: 1, sessions: 1,
      categoryCostUsd: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0.5 }
    }],
    query: { sinceDay: '2026-11-01', untilDay: '2026-11-24', timeZone: 'Asia/Shanghai' },
    metric: 'cost',
    hiddenProviders: new Set<UsageProviderKind>(),
    price: {
      inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2,
      multipliers: [
        { when: { service_tier: { equals: 'priority' } }, factor: 2 },
        { when: { date: { gte: '2026-01-01' } }, factor: 1.1 }
      ]
    },
    onRefresh: async () => undefined,
    onPrice: () => undefined, onClose: () => undefined
  }))
  expect(html).toContain('查看生效单价')
  expect(html).not.toContain('峰谷计价')
  expect(html).not.toContain('峰谷单价')
})

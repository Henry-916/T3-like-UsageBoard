import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { UsageModelDialog } from '../src/renderer/components/UsageModelDialog'
import { EMPTY_TOTALS, type UsageProviderKind } from '../src/shared/types'

vi.mock('../src/renderer/components/UsageDialog', () => ({
  UsageDialog: ({ title, subtitle, children, headerActions }: any) =>
    createElement('section', null, title, subtitle, headerActions, children)
}))

it('renders a 3-column peak/off-peak table for off-peak discount models and refresh action', () => {
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
      inputCostPerMillionTokens: 0.283, outputCostPerMillionTokens: 1.131,
      cacheReadCostPerMillionTokens: 0.0283, cacheWriteCostPerMillionTokens: 0.283,
      multipliers: [{ when: { utc_hours: { gte: '14:00' } }, factor: 0.5 }]
    },
    onRefresh: async () => undefined,
    onPrice: () => undefined, onClose: () => undefined
  }))
  expect(html).toContain('每百万 token')
  expect(html).toContain('查看生效单价')
  expect(html).toContain('类型')
  expect(html).toContain('峰期（美元/M）')
  expect(html).toContain('谷期（美元/M）')
  expect(html).not.toContain('价格（美元/M）')
  expect(html.indexOf('0.283')).toBeLessThan(html.indexOf('0.1415'))
  expect(html.indexOf('1.131')).toBeLessThan(html.indexOf('0.5655'))
  expect(html).toContain('谷期：22:00–8:00')
  expect(html).not.toContain('低谷期')
  expect(html).not.toContain('0.5x')
  expect(html).not.toContain('×0.5')
  expect(html).not.toContain('峰谷单价')
  expect(html).toContain('刷新用量 (R)')
  // The help button now sits in the title, before the stat grid.
  expect(html.indexOf('查看生效单价')).toBeLessThan(html.indexOf('每百万 token'))
})

it('places peak rate in the peak column even when base rate is off-peak (factor > 1)', () => {
  const html = renderToStaticMarkup(createElement(UsageModelDialog, {
    model: { provider: 'opencode', model: 'deepseek/deepseek-v4.1-flash-1017' },
    buckets: [{
      day: '2026-11-24', provider: 'opencode', model: 'deepseek/deepseek-v4.1-flash-1017',
      costUsd: 1, cacheSavingsUsd: 0, costSource: 'modelPriced',
      totals: { ...EMPTY_TOTALS, uncachedInputTokens: 1000, outputTokens: 100 },
      unpricedRecords: 0, records: 1, sessions: 1,
      categoryCostUsd: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0.5 }
    }],
    query: { sinceDay: '2026-11-01', untilDay: '2026-11-24', timeZone: 'Asia/Shanghai' },
    metric: 'cost',
    hiddenProviders: new Set<UsageProviderKind>(),
    price: {
      inputCostPerMillionTokens: 0.15, outputCostPerMillionTokens: 0.6,
      multipliers: [{
        when: {
          utc_days: { in: ['mon', 'tue', 'wed', 'thu', 'fri'] },
          any: [
            { all: [{ utc_hours: { gte: '01:00' } }, { utc_hours: { lt: '04:00' } }] },
            { all: [{ utc_hours: { gte: '06:00' } }, { utc_hours: { lt: '10:00' } }] }
          ]
        },
        factor: 2
      }]
    },
    onRefresh: async () => undefined,
    onPrice: () => undefined, onClose: () => undefined
  }))
  expect(html).toContain('峰期（美元/M）')
  expect(html).toContain('谷期（美元/M）')
  expect(html.indexOf('>0.3<')).toBeLessThan(html.indexOf('>0.15<'))
  expect(html.indexOf('>1.2<')).toBeLessThan(html.indexOf('>0.6<'))
  expect(html).toContain('峰期：工作日 9:00–12:00、14:00–18:00')
  expect(html).not.toContain('高峰期')
  expect(html).not.toContain('2x')
})

it('keeps the 2-column table and omits peak rows for service-tier or date multipliers', () => {
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
  expect(html).toContain('价格（美元/M）')
  expect(html).not.toContain('峰期（美元/M）')
  expect(html).not.toContain('峰期：')
  expect(html).not.toContain('谷期：')
})

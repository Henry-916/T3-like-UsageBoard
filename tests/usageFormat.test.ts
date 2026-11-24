import { describe, expect, it } from 'vitest'
import { formatPercent, formatTokens, formatUsd } from '../src/shared/usageFormat'

describe('usage formatting', () => {
  it('formats USD with separators and two decimal places', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1234.567)).toBe('$1,234.57')
  })

  it('formats whole and compact token counts, promoting units after rounding', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1250)).toBe('1.25K')
    expect(formatTokens(999_999)).toBe('1M')
    expect(formatTokens(2e9)).toBe('2B')
    expect(formatTokens(3e12)).toBe('3T')
  })

  it('formats fractional shares without rounding tiny nonzero shares to zero', () => {
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(0.0009)).toBe('<0.1%')
    expect(formatPercent(0.001)).toBe('0.1%')
    expect(formatPercent(0.125)).toBe('12.5%')
  })
})

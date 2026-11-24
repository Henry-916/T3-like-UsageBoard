const CURRENCY = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'symbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})
const INTEGER = new Intl.NumberFormat('en-US')
const TOKEN_SUFFIXES = ['K', 'M', 'B', 'T'] as const

export function formatUsd(value: number): string {
  return CURRENCY.format(value)
}

export function formatTokens(value: number): string {
  if (Math.abs(Math.round(value)) < 1e3) return INTEGER.format(Math.round(value))
  let scaled = value / 1e3
  let unit = 0
  // Choose the unit after rounding, so 999,999 reads 1M rather than 1000K.
  while (Math.abs(Number(trim(scaled))) >= 1e3 && unit < TOKEN_SUFFIXES.length - 1) {
    scaled /= 1e3
    unit += 1
  }
  return `${trim(scaled)}${TOKEN_SUFFIXES[unit]}`
}

function trim(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return value.toFixed(digits).replace(/\.0+$/, '')
}

export function formatPercent(fraction: number): string {
  const percent = fraction * 100
  if (percent > 0 && percent < 0.1) return '<0.1%'
  return `${percent.toFixed(1)}%`
}

import type { AccountOrigin } from '../shared/limitsTypes'

export const accountOriginLabels: Record<AccountOrigin, string> = {
  native: '原生',
  t3: 'T3',
  manual: '手动'
}

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

export function limitDateTime(value?: string | null) {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? dateTimeFormat.format(timestamp) : null
}

export function resetCountdown(value: string | undefined, now: number) {
  if (!value) return null
  const remaining = Date.parse(value) - now
  if (!Number.isFinite(remaining)) return null
  if (remaining <= 0) return '等待更新'
  const minutes = Math.ceil(remaining / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}天${hours % 24 ? `${hours % 24}小时` : ''}`
  if (hours > 0) return `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ''}`
  return `${minutes}分`
}

export const formatLimitPercent = (value: number) =>
  `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`

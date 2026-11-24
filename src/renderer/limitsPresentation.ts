import type { AccountOrigin, LimitAccountIssue } from '../shared/limitsTypes'
import { providerInfo, type ProviderFilter } from './usagePresentation'

export const accountOriginLabels: Record<AccountOrigin, string> = {
  native: '原生',
  t3: 'T3',
  manual: '手动'
}

export function visibleLimitIssues(issues: readonly LimitAccountIssue[] | undefined, provider: ProviderFilter) {
  if (!issues) return []
  return provider === 'all' ? issues : issues.filter((issue) => issue.provider === provider)
}

export function limitIssueText(issue: LimitAccountIssue) {
  const account = `「${issue.displayName}」`
  switch (issue.reason) {
    case 'expired':
      return `${account}登录凭证已过期，请在 ${providerInfo[issue.provider].label} 中重新登录后重试`
    case 'cli_missing':
      return `${account}登录凭证已过期，未找到可用的 agy CLI`
    case 'failed':
      return `${account}${issue.cached ? '刷新失败，当前显示缓存数据' : '无法读取额度'}`
  }
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

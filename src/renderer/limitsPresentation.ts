import type { AccountOrigin, LimitAccountIssue } from '../shared/limitsTypes'
import type { UsageProviderKind } from '../shared/types'
import type { PooledLimitAccount } from '../shared/usageLimits'

export const accountOriginLabels: Record<AccountOrigin, string> = {
  native: '原生',
  manual: '应用内'
}

export function visibleLimitIssues(
  issues: readonly LimitAccountIssue[] | undefined,
  hiddenProviders: ReadonlySet<UsageProviderKind>
) {
  return issues?.filter((issue) => !hiddenProviders.has(issue.provider)) ?? []
}

export const agyCliInstallUrl = 'https://antigravity.google/product/antigravity-cli'

export interface LimitIssueReason {
  title: string
  body: string
}

export const agyCliInstallReason: LimitIssueReason = {
  title: '为什么一定要安装 Antigravity CLI？',
  body: 'Antigravity 桌面端的登录令牌每 1 小时过期，且刷新密钥仅内置于官方程序中；安装官方 agy CLI 后，看板才能在后台安全调用官方通道自动续期。'
}

export interface LimitIssueGuidance {
  message: string
  installUrl?: string
  installReason?: LimitIssueReason
  accountManagement: boolean
}

export function limitIssueGuidance(issue: LimitAccountIssue, current: boolean): LimitIssueGuidance {
  if (issue.reason === 'cli_missing') {
    return {
      message: '未装 agy CLI，无法更新该账号的登录凭证，请安装 agy CLI：',
      installUrl: agyCliInstallUrl,
      installReason: agyCliInstallReason,
      accountManagement: false
    }
  }
  if (issue.reason === 'expired') {
    return issue.origin === 'manual' && !current
      ? { message: '登录已失效，请在「账号管理」重新登录。', accountManagement: true }
      : { message: '登录已过期，请在客户端重新登录后重试。', accountManagement: false }
  }
  return {
    message: issue.cached ? '刷新失败，当前显示缓存额度。' : '无法读取额度，请稍后重试。',
    accountManagement: false
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

function remainingTime(value: string | undefined, now: number) {
  if (!value) return null
  const remaining = Date.parse(value) - now
  return Number.isFinite(remaining) ? remaining : null
}

function durationText(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} 天 ${hours % 24} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.max(1, minutes)} 分钟`
}

export function resetBadgeDuration(value: string | undefined, now: number) {
  const remaining = remainingTime(value, now)
  if (remaining === null) return null
  return remaining <= 0 ? '即将重置' : `↻ ${durationText(remaining)}`
}

export function resetDetailTime(value: string | undefined, now: number) {
  const remaining = remainingTime(value, now)
  if (remaining === null) return null
  const local = new Date(now)
  const reset = new Date(now + remaining)
  const clock = [reset.getHours(), reset.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':')
  const date = local.toDateString() === reset.toDateString()
    ? clock
    : `${reset.getMonth() + 1}月${reset.getDate()}日 ${clock}`
  return `${date} · ${remaining <= 0 ? '即将重置' : `还需 ${durationText(remaining)}`}`
}

export function resetCreditText(credits: number, value: string | undefined, now: number) {
  const count = `已存 ${credits} 个`
  const remaining = remainingTime(value, now)
  if (remaining === null) return count
  return `${count} · ${remaining <= 0 ? '已到期' : `${durationText(remaining)}后过期`}`
}

export function limitTimeLeft(account: Pick<PooledLimitAccount, 'resetStatus' | 'resetsAt' | 'windowDurationMins'>, now: number) {
  const duration = (account.windowDurationMins ?? 0) * 60_000
  if (account.resetStatus !== 'upcoming' || !Number.isFinite(duration) || duration <= 0) return null
  const remaining = remainingTime(account.resetsAt, now)
  return remaining === null ? null : Math.min(100, Math.max(0, (remaining / duration) * 100))
}

export const formatLimitPercent = (value: number) =>
  `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`

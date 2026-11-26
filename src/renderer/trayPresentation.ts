import type { LimitAccountReading } from '../shared/limitsTypes'
import type { UsageProviderKind } from '../shared/types'
import { poolUsageLimits, type PooledLimitAccount, type PooledLimitWindow } from '../shared/usageLimits'
import { formatLimitPercent } from './limitsPresentation'

const providers = ['codex', 'claude', 'opencode', 'antigravity'] as const

interface TrayAccount {
  account: LimitAccountReading
  windows: { window: PooledLimitWindow; reading: PooledLimitAccount }[]
}

export function trayGroups(
  accounts: readonly LimitAccountReading[], hidden: ReadonlySet<UsageProviderKind>, now: number
) {
  // The limits service has already removed disabled accounts and reconciled cache entries.
  const visible = accounts.filter(account => !hidden.has(account.provider))
  const groups = new Map<UsageProviderKind, Map<string, TrayAccount>>()
  for (const account of visible) {
    const group = groups.get(account.provider) ?? new Map<string, TrayAccount>()
    group.set(account.id, { account, windows: [] })
    groups.set(account.provider, group)
  }

  // Keep the same effective session/weekly allowances and ordering as the main panel.
  for (const window of poolUsageLimits(visible, now)) {
    const group = groups.get(window.provider)
    for (const reading of window.accounts) group?.get(reading.id)?.windows.push({ window, reading })
  }

  return providers.flatMap(provider => {
    const accounts = [...(groups.get(provider)?.values() ?? [])].filter(entry => entry.windows.length > 0)
      .sort((a, b) =>
        Number(Boolean(b.account.current)) - Number(Boolean(a.account.current)) ||
        a.account.displayName.localeCompare(b.account.displayName, 'zh-CN') || a.account.id.localeCompare(b.account.id))
    return accounts.length ? [{ provider, accounts }] : []
  })
}

export function trayWindowLabel({ provider, label, kind }: Pick<PooledLimitWindow, 'provider' | 'label' | 'kind'>) {
  if (provider === 'opencode') return label.replace(/\s*·\s*/, ' ')
  if (provider !== 'antigravity') return label
  const [family, period] = label.split(' · ')
  if (!period) return label
  const compactFamily = family === 'Claude & GPT (shared)' ? 'Claude&GPT' : family
  const compactPeriod = kind === 'weekly' ? '周' : period === '5-hour' ? '5h' : period === 'Reported quota' ? '额度' : period
  return `${compactFamily} ${compactPeriod}`
}

const pad = (value: number) => String(value).padStart(2, '0')
const weekdays = ['日', '一', '二', '三', '四', '五', '六'] as const

function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

export function trayResetTime(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return null
  if (at <= now) return '即将重置'
  const reset = new Date(at)
  const clock = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`
  const days = Math.round((calendarDay(reset) - calendarDay(new Date(now))) / 86_400_000)
  if (days === 0) return clock
  if (days >= 1 && days <= 7) return `周${weekdays[reset.getDay()]}${clock}`
  return `${reset.getMonth() + 1}/${reset.getDate()} ${clock}`
}

export function trayResetTooltip(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at) || at <= now) return null
  const reset = new Date(at)
  const days = Math.round((calendarDay(reset) - calendarDay(new Date(now))) / 86_400_000)
  if (days < 1 || days > 7) return null
  return `${pad(reset.getMonth() + 1)}月${pad(reset.getDate())}日 周${weekdays[reset.getDay()]}${pad(reset.getHours())}:${pad(reset.getMinutes())}`
}

export function trayCreditTooltip(credits: number): string | null {
  return credits > 0 ? `${credits} 张重置券 · 可在主面板使用` : null
}

export function trayPercentTooltip(
  reading: Pick<PooledLimitAccount, 'remainingPercent' | 'stale'>
): string {
  const parts = [`剩余 ${formatLimitPercent(reading.remainingPercent)}`]
  if (reading.stale) parts.push('缓存')
  return parts.join(' · ')
}

function remainingText(milliseconds: number): string {
  const minutes = Math.max(1, Math.floor(milliseconds / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
  return `${rest} 分`
}

export function trayQuotaTooltip(
  reading: Pick<PooledLimitAccount, 'remainingPercent' | 'resetsAt' | 'stale'>,
  now: number,
  expectedRemainingPercent?: number | null
): string {
  const at = reading.resetsAt ? Date.parse(reading.resetsAt) : NaN
  const parts: string[] = []
  if (!Number.isFinite(at)) {
    parts.push(`剩余 ${formatLimitPercent(reading.remainingPercent)}`, '尚未开始计时')
  } else if (at <= now) {
    parts.push('即将重置')
  } else {
    if (expectedRemainingPercent !== null && expectedRemainingPercent !== undefined) {
      parts.push(`匀速应剩 ${Math.round(expectedRemainingPercent)}%`)
    }
    parts.push(`还需 ${remainingText(at - now)}`)
  }
  if (reading.stale) parts.push('缓存')
  return parts.join(' · ')
}

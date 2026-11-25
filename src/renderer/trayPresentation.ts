import type { LimitAccountReading } from '../shared/limitsTypes'
import type { UsageProviderKind } from '../shared/types'
import { poolUsageLimits, type PooledLimitAccount, type PooledLimitWindow } from '../shared/usageLimits'

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

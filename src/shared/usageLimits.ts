import type { LimitAccountReading, LimitWindow } from './limitsTypes'

export interface PooledLimitAccount {
  id: string
  current?: boolean
  canSwitch?: boolean
  displayName: string
  origin: LimitAccountReading['origin']
  plan?: string
  checkedAt: string
  stale: boolean
  resetCredits?: number
  resetCreditsExpiresAt?: string
  nextResetCreditId?: string
  remainingPercent: number
  capacitySharePercent: number
  resetsAt?: string
  resetStatus: 'upcoming' | 'passed' | 'unknown'
  windowDurationMins?: number
  modelIds?: string[]
  recoveryPercent?: number
}

export interface PooledLimitWindow {
  provider: LimitAccountReading['provider']
  windowId: string
  kind: LimitWindow['kind']
  label: string
  meanRemainingPercent: number
  accounts: PooledLimitAccount[]
  nextReset?: {
    at: string
    recoveryPercent: number
    shares: { accountId: string; recoveryPercent: number }[]
  }
  trend?: { pace: 'ahead' | 'on' | 'under'; expectedRemainingPercent: number }
}

const MINUTE = 60_000
const KIND_ORDER = { session: 0, weekly: 1, monthly: 2, other: 3 }
const clampPercent = (value: number) => Math.max(0, Math.min(100, value))
const clock = (timestamp?: string) => Date.parse(timestamp ?? '')

type Member = { account: LimitAccountReading; window: LimitWindow; refill: number }

// Adapted from T3 Code's poolMember: a spent overall weekly quota gates session quota.
function memberFor(account: LimitAccountReading, window: LimitWindow, nowMs: number): Member {
  const spentWeekly = window.kind === 'session' && account.windows.find((candidate) =>
    candidate.usedPercent >= 100 &&
    (account.provider === 'codex' && candidate.kind === 'weekly' ||
      account.provider === 'claude' && candidate.id === 'seven_day'))
  if (!spentWeekly) return { account, window, refill: clampPercent(window.usedPercent) }

  const weeklyAt = clock(spentWeekly.resetsAt)
  const sessionAt = clock(window.resetsAt)
  const cutoff = Math.max(nowMs, clock(account.checkedAt))
  let resetsAt: string | undefined
  let refill = 0
  if (weeklyAt > cutoff && sessionAt > cutoff) {
    if (sessionAt <= weeklyAt) {
      resetsAt = spentWeekly.resetsAt
      refill = 100
    } else if (window.usedPercent >= 100) {
      resetsAt = window.resetsAt
      refill = 100
    } else {
      resetsAt = spentWeekly.resetsAt
      refill = 100 - clampPercent(window.usedPercent)
    }
  }
  return { account, window: { ...window, usedPercent: 100, resetsAt, windowDurationMins: undefined }, refill }
}

export function poolUsageLimits(
  accounts: readonly LimitAccountReading[],
  nowMs: number
): PooledLimitWindow[] {
  const groups = new Map<string, { windowId: string; members: Member[] }>()
  for (const account of accounts) {
    const slotKinds = new Set<LimitWindow['kind']>()
    for (const window of account.windows) {
      if (!Number.isFinite(window.usedPercent)) continue
      // Codex window IDs can name API response slots rather than durations.
      const byKind = account.provider === 'codex' &&
        (window.kind === 'session' || window.kind === 'weekly') &&
        !window.modelIds?.length && !slotKinds.has(window.kind)
      if (byKind) slotKinds.add(window.kind)
      const windowId = byKind ? window.kind
        : account.provider === 'codex' && window.id === window.kind ? `${window.kind}:${window.id}`
        : window.id
      const key = JSON.stringify([account.provider, window.kind, byKind, windowId])
      const group = groups.get(key) ?? { windowId, members: [] }
      group.members.push(memberFor(account, window, nowMs))
      groups.set(key, group)
    }
  }

  const pools = [...groups.values()].map(({ windowId, members }): PooledLimitWindow => {
    const first = members[0]
    const share = 1 / members.length
    let meanRemainingPercent = 0
    let timedCount = 0
    let timedUsed = 0
    let timedElapsed = 0
    const resets: { at: number; accountId: string; recoveryPercent: number }[] = []
    const pooledAccounts = members.map(({ account, window, refill }): PooledLimitAccount => {
      const used = clampPercent(window.usedPercent)
      const at = clock(window.resetsAt)
      const resetStatus = !Number.isFinite(at) ? 'unknown' : at > nowMs ? 'upcoming' : 'passed'
      const duration = (window.windowDurationMins ?? 0) * MINUTE
      const recoveryPercent = resetStatus === 'upcoming' ? refill * share : undefined
      meanRemainingPercent += (100 - used) * share
      if (recoveryPercent !== undefined && recoveryPercent > 0) {
        resets.push({ at, accountId: account.id, recoveryPercent })
      }
      if (resetStatus === 'upcoming' && duration > 0 && Number.isFinite(duration)) {
        timedCount++
        timedUsed += used
        timedElapsed += clampPercent(100 * (1 - (at - nowMs) / duration))
      }
      const { id, displayName, origin, plan, checkedAt, stale, resetCredits, resetCreditsExpiresAt, nextResetCreditId, current, canSwitch } = account
      return {
        id, current, canSwitch, displayName, origin, plan, checkedAt, stale, resetCredits, resetCreditsExpiresAt, nextResetCreditId,
        remainingPercent: 100 - used,
        capacitySharePercent: share * 100,
        resetsAt: resetStatus === 'unknown' ? undefined : window.resetsAt,
        resetStatus,
        recoveryPercent,
        windowDurationMins: window.windowDurationMins,
        modelIds: window.modelIds?.slice()
      }
    })
    resets.sort((a, b) => a.at - b.at)
    pooledAccounts.sort((a, b) =>
      Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
      a.displayName.localeCompare(b.displayName, 'zh-CN') || a.id.localeCompare(b.id))
    const next = resets[0]
    const shares = next && resets
      .filter((reset) => reset.at - next.at < MINUTE)
      .map(({ accountId, recoveryPercent }) => ({ accountId, recoveryPercent }))
    const gap = timedCount > 0 ? (timedUsed - timedElapsed) / timedCount : 0

    return {
      provider: first.account.provider,
      windowId,
      kind: first.window.kind,
      label: first.window.label,
      meanRemainingPercent: clampPercent(meanRemainingPercent),
      accounts: pooledAccounts,
      nextReset: next && shares && {
        at: new Date(next.at).toISOString(),
        recoveryPercent: shares.reduce((sum, share) => sum + share.recoveryPercent, 0),
        shares
      },
      trend: timedCount > 0 ? {
        pace: gap > 5 ? 'ahead' : gap < -5 ? 'under' : 'on',
        expectedRemainingPercent: 100 - timedElapsed / timedCount
      } : undefined
    }
  }).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  const isAntigravity = (pool: PooledLimitWindow) => pool.provider === 'antigravity'
  const firstAntigravity = pools.findIndex(isAntigravity)
  if (firstAntigravity === -1) return pools

  const family = (id: string) => id.replace(/-(?:5h|weekly|quota)$/, '')
  const antigravity = pools.filter(isAntigravity).sort((a, b) =>
    Number(!a.windowId.startsWith('gemini-')) - Number(!b.windowId.startsWith('gemini-')) ||
    family(a.windowId).localeCompare(family(b.windowId)) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  )
  // Keep the first Antigravity position and the relative order of all other providers.
  const ordered = pools.filter((pool) => !isAntigravity(pool))
  ordered.splice(firstAntigravity, 0, ...antigravity)
  return ordered
}

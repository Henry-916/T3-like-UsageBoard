import { pathKey } from '../accounts/discovery'
import type { AccountView, LimitAccountIssue, LimitAccountReading, LimitsProbeContext, LimitsProbeResult, LimitsReport } from '../../shared/limitsTypes'
import type { DiscoveredAccount, UsageProviderKind } from '../../shared/types'
import { createLimitsCache } from './limitsCache'

type Probe = (account: DiscoveredAccount, context: LimitsProbeContext) => Promise<LimitsProbeResult>
interface Options {
  discover: () => Promise<DiscoveredAccount[]>
  probes: Record<UsageProviderKind, Probe>
  readCredential: LimitsProbeContext['readCredential']
  getManualApiKey: (account: DiscoveredAccount) => Promise<string | undefined>
  onUpdate: (report: LimitsReport) => void
  fetch?: typeof globalThis.fetch
  now?: () => number
  timeoutMs?: number
  intervalMs?: number
  userData?: string
}

const rank = { native: 0, t3: 1, manual: 2 }
type Reading = {
  data: LimitAccountReading
  identity: string
}

async function deadline<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    run().then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

export function createLimitsService({
  discover, probes, readCredential, getManualApiKey, onUpdate,
  fetch = globalThis.fetch, now = Date.now, timeoutMs = 60_000, intervalMs = 300_000, userData
}: Options) {
  const readings = new Map<string, Reading>()
  const issues = new Map<string, LimitAccountIssue>()
  const cache = userData === undefined ? undefined : createLimitsCache(userData)
  let report: LimitsReport = { accounts: [], checkedAt: null, refreshing: false }
  let inFlight: { controller: AbortController; result: Promise<LimitsReport> } | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let accountViews: Map<string, AccountView> | undefined

  function publish(refreshing: boolean, checkedAt = report.checkedAt): LimitsReport {
    const groups = new Map<string, Reading>()
    for (const reading of readings.values()) {
      const prev = groups.get(reading.identity)
      if (!prev || Number(prev.data.stale) > Number(reading.data.stale)
        || (prev.data.stale === reading.data.stale && rank[prev.data.origin] < rank[reading.data.origin])) {
        groups.set(reading.identity, reading)
      }
    }
    const fresh = [...readings.values()].filter(({ data }) => !data.stale)
    const visibleIssues = [...issues.values()].filter(issue => !fresh.some(({ data, identity }) =>
      data.id !== issue.id && data.provider === issue.provider
      && (data.displayName === issue.displayName || identity === readings.get(issue.id)?.identity)))
    report = {
      accounts: [...groups.values()].map(({ data }) => data),
      ...(visibleIssues.length ? { issues: visibleIssues } : {}),
      refreshing, checkedAt
    }
    onUpdate(report)
    return report
  }

  async function hydrate(): Promise<void> {
    if (!cache) return
    const entries = await cache.load()
    if (!entries.length) return
    let active: ReadonlyMap<string, Pick<AccountView, 'provider' | 'origin' | 'displayName'>> | undefined = accountViews
    if (!active) {
      try {
        const discovered = await discover()
        active = accountViews ?? new Map(discovered.filter(account => account.enabled).map(account => [account.id, account]))
      } catch {
        active = accountViews
      }
    }
    if (!active) return
    let checkedAt: string | null = null
    for (const { id, identity, data } of entries) {
      const account = active.get(id)
      if (!account || account.provider !== data.provider || account.origin !== data.origin) continue
      readings.set(id, { identity, data: { ...data, displayName: account.displayName, stale: true } })
      if (checkedAt === null || data.checkedAt > checkedAt) checkedAt = data.checkedAt
    }
    if (readings.size) publish(false, checkedAt)
    await cache.save(readings)
  }

  const ready = hydrate()

  async function run(controller: AbortController): Promise<LimitsReport> {
    const signal = controller.signal
    publish(true)
    try {
      const accounts = (await discover()).filter(account => account.enabled)
      const activeIds = new Set(accounts.map(account => account.id))
      signal.throwIfAborted()
      let pruned = false
      for (const id of readings.keys()) if (!activeIds.has(id)) pruned = readings.delete(id) || pruned
      for (const id of issues.keys()) if (!activeIds.has(id)) pruned = issues.delete(id) || pruned
      if (pruned) {
        void cache?.save(readings)
        publish(true)
      }
      const results = await Promise.all(accounts.map(async (account): Promise<{ account: DiscoveredAccount; result: LimitsProbeResult }> => {
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        try {
          const result = await deadline(timeout, async () => probes[account.provider](account, {
            signal: timeout, fetch, readCredential, manualApiKey: await getManualApiKey(account)
          }))
          return { account, result }
        } catch {
          return { account, result: { kind: 'failed' } }
        }
      }))
      signal.throwIfAborted()
      const checkedAt = new Date(now()).toISOString()
      for (const { account, result } of results) {
        const { id, displayName, origin, provider } = account
        const prev = readings.get(id)
        if (result.kind === 'failed') {
          issues.set(id, { id, displayName, origin, provider, reason: result.reason ?? 'failed', cached: Boolean(prev) })
        } else {
          issues.delete(id)
        }
        if (result.kind === 'ok' && result.windows.length) {
          const fallback = account.dataDir ?? account.credentialPath ?? account.credentialPaths?.[0]
          const identity = result.fingerprint ? `${provider}:fp:${result.fingerprint}`
            : prev?.identity ?? `${provider}:path:${fallback ? pathKey(fallback) : id}`
          readings.set(id, {
            identity,
            data: {
              id, displayName, origin, provider, windows: result.windows, plan: result.plan, resetCredits: result.resetCredits,
              checkedAt, stale: false,
              previous: prev?.identity === identity ? { checkedAt: prev.data.checkedAt, windows: prev.data.windows } : undefined
            }
          })
        } else if (result.kind === 'failed' && prev) {
          readings.set(id, { ...prev, data: { ...prev.data, displayName, stale: true } })
        } else {
          readings.delete(id)
        }
      }
      publish(false, checkedAt)
      await cache?.save(readings)
      return report
    } catch {
      if (signal.aborted) return report
      for (const [id, prev] of readings) readings.set(id, { ...prev, data: { ...prev.data, stale: true } })
      return publish(false, new Date(now()).toISOString())
    }
  }

  function refresh(): Promise<LimitsReport> {
    if (inFlight) return inFlight.result
    const controller = new AbortController()
    const result = ready.then(() => controller.signal.aborted ? report : run(controller)).finally(() => {
      if (inFlight?.controller === controller) inFlight = undefined
    })
    inFlight = { controller, result }
    return result
  }

  return {
    ready,
    get: () => report,
    refresh,
    start(): void {
      if (timer) return
      void refresh()
      timer = setInterval(() => void refresh(), intervalMs)
      timer.unref()
    },
    accountsChanged(accounts: AccountView[]): void {
      const next = new Map(accounts.filter(account => account.enabled).map(account => [account.id, account]))
      accountViews = next
      for (const [id, entry] of readings) {
        const account = next.get(id)
        if (!account) readings.delete(id)
        else if (account.displayName !== entry.data.displayName) {
          readings.set(id, { ...entry, data: { ...entry.data, displayName: account.displayName } })
        }
      }
      for (const [id, issue] of issues) {
        const account = next.get(id)
        if (!account) issues.delete(id)
        else if (account.displayName !== issue.displayName) issues.set(id, { ...issue, displayName: account.displayName })
      }
      inFlight?.controller.abort()
      inFlight = undefined
      publish(true)
      void ready.then(() => cache?.save(readings))
      void refresh()
    },
    stop(): void {
      clearInterval(timer)
      timer = undefined
      inFlight?.controller.abort()
      inFlight = undefined
    }
  }
}

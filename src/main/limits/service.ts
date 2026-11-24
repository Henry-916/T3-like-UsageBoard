import { pathKey } from '../accounts/discovery'
import type { AccountView, LimitAccountReading, LimitsProbeContext, LimitsProbeResult, LimitsReport } from '../../shared/limitsTypes'
import type { DiscoveredAccount, UsageProviderKind } from '../../shared/types'

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
  fetch = globalThis.fetch, now = Date.now, timeoutMs = 15_000, intervalMs = 300_000
}: Options) {
  const readings = new Map<string, Reading>()
  let report: LimitsReport = { accounts: [], checkedAt: null, refreshing: false }
  let inFlight: { controller: AbortController; result: Promise<LimitsReport> } | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  function publish(refreshing: boolean, checkedAt = report.checkedAt): LimitsReport {
    const groups = new Map<string, Reading>()
    for (const reading of readings.values()) {
      const prev = groups.get(reading.identity)
      if (!prev || Number(prev.data.stale) > Number(reading.data.stale)
        || (prev.data.stale === reading.data.stale && rank[prev.data.origin] < rank[reading.data.origin])) {
        groups.set(reading.identity, reading)
      }
    }
    report = { accounts: [...groups.values()].map(({ data }) => data), refreshing, checkedAt }
    onUpdate(report)
    return report
  }

  async function run(controller: AbortController): Promise<LimitsReport> {
    const signal = controller.signal
    publish(true)
    try {
      const accounts = (await discover()).filter(account => account.enabled)
      const activeIds = new Set(accounts.map(account => account.id))
      signal.throwIfAborted()
      for (const id of readings.keys()) if (!activeIds.has(id)) readings.delete(id)
      const results = await Promise.all(accounts.map(async account => {
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        try {
          const result = await deadline(timeout, async () => probes[account.provider](account, {
            signal: timeout, fetch, readCredential, manualApiKey: await getManualApiKey(account)
          }))
          return { account, result }
        } catch {
          return { account, result: { kind: 'failed' } as const }
        }
      }))
      signal.throwIfAborted()
      const checkedAt = new Date(now()).toISOString()
      for (const { account, result } of results) {
        const { id, displayName, origin, provider } = account
        const prev = readings.get(id)
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
      return publish(false, checkedAt)
    } catch {
      if (signal.aborted) return report
      for (const [id, prev] of readings) readings.set(id, { ...prev, data: { ...prev.data, stale: true } })
      return publish(false, new Date(now()).toISOString())
    }
  }

  function refresh(): Promise<LimitsReport> {
    if (inFlight) return inFlight.result
    const controller = new AbortController()
    const result = run(controller).finally(() => {
      if (inFlight?.controller === controller) inFlight = undefined
    })
    inFlight = { controller, result }
    return result
  }

  return {
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
      for (const [id, entry] of readings) {
        const account = next.get(id)
        if (!account) readings.delete(id)
        else if (account.displayName !== entry.data.displayName) {
          readings.set(id, { ...entry, data: { ...entry.data, displayName: account.displayName } })
        }
      }
      inFlight?.controller.abort()
      inFlight = undefined
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

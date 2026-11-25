import { setTimeout as delay } from 'node:timers/promises'
import { pathKey } from '../accounts/discovery'
import { identityKey } from '../accounts/identities'
import type { AccountView, ConsumeResetCreditOutcome, ConsumeResetCreditResult, LimitAccountIssue, LimitAccountReading, LimitsProbeContext, LimitsProbeResult, LimitsReport } from '../../shared/limitsTypes'
import type { DiscoveredAccount, UsageProviderKind } from '../../shared/types'
import { createLimitsCache } from './limitsCache'
import { waitForAntigravityRenewals } from './probes/antigravity'

type Probe = (account: DiscoveredAccount, context: LimitsProbeContext) => Promise<LimitsProbeResult>
interface Options {
  discover: () => Promise<DiscoveredAccount[]>
  probes: Record<UsageProviderKind, Probe>
  readCredential: LimitsProbeContext['readCredential']
  getManualApiKey: (account: DiscoveredAccount) => Promise<string | undefined>
  recordIdentity?: (account: DiscoveredAccount, email?: string) => Promise<void>
  onUpdate: (report: LimitsReport) => void
  fetch?: typeof globalThis.fetch
  now?: () => number
  timeoutMs?: number
  intervalMs?: number
  userData?: string
  consumeCodexCredit?: (account: DiscoveredAccount, context: LimitsProbeContext, creditId?: string) => Promise<ConsumeResetCreditOutcome>
  resetRecheckDelaysMs?: readonly number[]
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
  discover, probes, readCredential, getManualApiKey, recordIdentity, onUpdate,
  fetch = globalThis.fetch, now = Date.now, timeoutMs = 60_000, intervalMs = 300_000, userData,
  consumeCodexCredit, resetRecheckDelaysMs = [0, 1000, 2000, 4000]
}: Options) {
  const readings = new Map<string, Reading>()
  const issues = new Map<string, LimitAccountIssue>()
  const cache = userData === undefined ? undefined : createLimitsCache(userData)
  let report: LimitsReport = { accounts: [], checkedAt: null, refreshing: false }
  let inFlight: { controller: AbortController; result: Promise<LimitsReport> } | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let accountViews: Map<string, AccountView> | undefined
  const resetting = new Set<string>()
  const runningProbes = new Set<Promise<LimitsProbeResult>>()
  const lifetime = new AbortController()
  let switching = false

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
      && ((data.displayName !== '未知账号' && data.displayName !== '正在识别…' && data.displayName === issue.displayName)
        || identity === readings.get(issue.id)?.identity)))
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
    let active: ReadonlyMap<string, Pick<AccountView, 'provider' | 'origin' | 'displayName' | 'current'>> | undefined = accountViews
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
      if (account.current && account.displayName !== data.displayName) continue
      readings.set(id, { identity, data: { ...data, displayName: account.displayName, current: account.current, stale: true } })
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
        const source = account.credentialSource ?? account
        try {
          const result = await deadline(timeout, () => {
            const job = (async () => {
              const manualApiKey = await getManualApiKey(source)
              timeout.throwIfAborted()
              return probes[account.provider](source, {
                signal: timeout, fetch, readCredential, manualApiKey,
                reportEmail: recordIdentity ? async email => {
                  timeout.throwIfAborted()
                  await recordIdentity(account, email)
                } : undefined
              })
            })()
            runningProbes.add(job)
            const forget = () => { runningProbes.delete(job) }
            void job.then(forget, forget)
            return job
          })
          return { account, result }
        } catch {
          return { account, result: { kind: 'failed' } }
        }
      }))
      signal.throwIfAborted()
      let reconciled: Map<string, DiscoveredAccount> | undefined
      if (recordIdentity && accounts.some(account => !account.email && account.provider !== 'opencode')) {
        await Promise.all(results.filter(({ account, result }) => !account.email && result.kind !== 'ok')
          .map(({ account }) => recordIdentity(account)))
        reconciled = new Map((await discover()).filter(account => account.enabled).map(account => [account.id, account]))
        signal.throwIfAborted()
      }
      const checkedAt = new Date(now()).toISOString()
      for (const { account, result } of results) {
        const latest = reconciled ? reconciled.get(account.id) : account
        if (!latest) {
          readings.delete(account.id)
          issues.delete(account.id)
          continue
        }
        const { id, displayName, origin, provider, current } = latest
        if (current && readings.get(id)?.data.displayName !== displayName) readings.delete(id)
        const prev = readings.get(id)
        if (result.kind === 'failed') {
          issues.set(id, { id, displayName, origin, provider, reason: result.reason ?? 'failed', cached: Boolean(prev) })
        } else {
          issues.delete(id)
        }
        if (result.kind === 'ok' && result.windows.length) {
          const fallback = account.dataDir ?? account.credentialPath ?? account.credentialPaths?.[0]
          const identity = latest.email ? `${provider}:email:${identityKey(latest.email)}`
            : result.fingerprint ? `${provider}:fp:${result.fingerprint}`
            : prev?.identity ?? `${provider}:path:${fallback ? pathKey(fallback) : id}`
          readings.set(id, {
            identity,
            data: {
              id, displayName, origin, provider, current, windows: result.windows, plan: result.plan, resetCredits: result.resetCredits,
              resetCreditsExpiresAt: result.resetCreditsExpiresAt, nextResetCreditId: result.nextResetCreditId,
              checkedAt, stale: false,
              previous: prev?.identity === identity ? { checkedAt: prev.data.checkedAt, windows: prev.data.windows } : undefined
            }
          })
        } else if (result.kind === 'failed' && prev) {
          readings.set(id, { ...prev, data: { ...prev.data, displayName, current, stale: true } })
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
    if (switching) return Promise.resolve(report)
    if (inFlight) return inFlight.result
    const controller = new AbortController()
    const result = ready.then(() => controller.signal.aborted ? report : run(controller)).finally(() => {
      if (inFlight?.controller === controller) inFlight = undefined
    })
    inFlight = { controller, result }
    return result
  }

  async function consumeResetCredit(accountId: string): Promise<ConsumeResetCreditResult> {
    await ready
    if (!consumeCodexCredit || lifetime.signal.aborted || switching) throw new Error('无法使用重置券，请重试。')
    const account = (await discover()).find(item => item.id === accountId && item.enabled && item.provider === 'codex')
    const before = readings.get(accountId)
    if (!account || !before || switching) throw new Error('此 Codex 账号不可用。')
    if (account.current && (!account.email || before.data.displayName !== account.displayName)) {
      throw new Error('当前 Codex 账号已更改，刷新额度后请重试。')
    }
    const key = before.identity
    if (resetting.has(key)) throw new Error('该账号正在重置，请稍候。')
    if ((before.data.resetCredits ?? 0) <= 0) return { outcome: 'noCredit', report }
    resetting.add(key)
    try {
      const outcome = await consumeCodexCredit(account.credentialSource ?? account, {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]), fetch, readCredential
      }, before.data.nextResetCreditId)
      if (outcome !== 'reset') {
        // Reconcile stale ticket information before the next confirmation is offered.
        if (inFlight) await inFlight.result
        if (!lifetime.signal.aborted) await refresh()
        return { outcome, report }
      }

      // An interval refresh may have started before redemption. Do not use it as confirmation.
      if (inFlight) await inFlight.result
      for (const wait of resetRecheckDelaysMs) {
        if (lifetime.signal.aborted) break
        if (wait > 0) await delay(wait, undefined, { signal: lifetime.signal }).catch(() => undefined)
        if (lifetime.signal.aborted) break
        await refresh()
        const after = readings.get(accountId)?.data
        if (!after || after.stale || after.checkedAt <= before.data.checkedAt) continue
        const oldCredits = before.data.resetCredits
        const countReduced = typeof oldCredits === 'number' && typeof after.resetCredits === 'number' && after.resetCredits < oldCredits
        const resetConfirmed = before.data.windows.some(window =>
          (window.kind === 'session' || window.kind === 'weekly') && window.usedPercent > 0 &&
          after.windows.some(next => next.id === window.id && next.usedPercent === 0))
        if (countReduced && resetConfirmed) return { outcome, report }
      }
      return { outcome, report, warning: '重置券已生效，但暂时无法确认最新额度，请稍后手动刷新。' }
    } finally {
      resetting.delete(key)
    }
  }

  return {
    ready,
    get: () => report,
    refresh,
    consumeResetCredit,
    async exclusiveSwitch<T>(operation: () => Promise<T>): Promise<T> {
      if (switching || resetting.size || lifetime.signal.aborted) throw new Error('额度操作正在进行，请稍后重试。')
      switching = true
      try {
        await inFlight?.result
        await deadline(AbortSignal.timeout(5_000), async () => {
          await Promise.allSettled(runningProbes)
          await waitForAntigravityRenewals()
        }).catch(() => { throw new Error('额度探测尚未停止，请稍后重试。') })
        lifetime.signal.throwIfAborted()
        return await operation()
      } finally {
        switching = false
        if (!lifetime.signal.aborted) void refresh()
      }
    },
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
        else if (account.current && account.displayName !== entry.data.displayName) readings.delete(id)
        else if (account.displayName !== entry.data.displayName || account.current !== entry.data.current) {
          readings.set(id, { ...entry, data: { ...entry.data, displayName: account.displayName, current: account.current } })
        }
      }
      for (const [id, issue] of issues) {
        const account = next.get(id)
        if (!account) issues.delete(id)
        else if (account.displayName !== issue.displayName) issues.set(id, { ...issue, displayName: account.displayName })
      }
      inFlight?.controller.abort()
      if (!switching) inFlight = undefined
      publish(true)
      void ready.then(() => cache?.save(readings))
      void refresh()
    },
    stop(): void {
      lifetime.abort()
      clearInterval(timer)
      timer = undefined
      inFlight?.controller.abort()
      inFlight = undefined
    }
  }
}

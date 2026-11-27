import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverAccounts, pathKey, providers } from '../accounts/discovery'
import { readConfig } from '../configStore'
import { usageSummaryInputSchema } from '../../shared/types'
import type { UsageModelPrice, UsageProviderKind, UsageRecord, UsageSource, UsageSummary, UsageSummaryInput } from '../../shared/types'
import { aggregateUsage, createUsageWindowFilter, mergeUsageCopies } from './aggregation'
import { loadOpenCodePricing } from './opencodePricing'
import { loadPricePresets } from './pricePresets'
import { loadPricing } from './pricing'
import { fileFingerprint, readScanCache, writeScanCache } from './scanCache'
import type { ScanCacheEntry } from './scanCache'
import { mergeAntigravityRecords, scanAntigravityDatabase } from './readers/antigravity'
import { readClaudeFile } from './readers/claude'
import { readCodexFile } from './readers/codex'
import { readOpenCodeDatabase, readOpenCodeDatabaseIncremental, readOpenCodeJson } from './readers/opencode'

const DAY_MS = 86_400_000
type Reader = (file: string, cutoffMs?: number) => Promise<UsageRecord[]>

/** Merge incrementally appended rows into the retained 92-day cache window. */
function mergeIncremental(
  previous: readonly UsageRecord[],
  added: readonly UsageRecord[],
  cutoff: number
): UsageRecord[] {
  const merged = new Map<string, UsageRecord>()
  const anonymous: UsageRecord[] = []
  for (const record of [...previous, ...added]) {
    if (record.timestampMs < cutoff) continue
    if (record.dedupeKey === null) anonymous.push(record)
    else merged.set(record.dedupeKey, record)
  }
  return [...merged.values(), ...anonymous]
}
interface Candidate {
  path: string
  sqlite: boolean
  read?: Reader
}

async function* walk(
  dir: string,
  matches: (name: string) => boolean,
  stats: { errors: number },
  recursive = true
): AsyncGenerator<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isFile() && matches(entry.name)) yield path
      if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) yield* walk(path, matches, stats)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stats.errors++
  }
}

async function* filesFor(
  provider: UsageProviderKind, dir: string, stats: { errors: number }, allowDirect = false
): AsyncGenerator<Candidate> {
  const jsonl = (name: string) => name.toLowerCase().endsWith('.jsonl')
  switch (provider) {
    case 'antigravity': {
      let conversations = join(dir, 'conversations')
      if (allowDirect) {
        try {
          if (!(await stat(conversations)).isDirectory()) conversations = dir
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') conversations = dir
        }
      }
      for await (const path of walk(conversations, name => name.toLowerCase().endsWith('.db'), stats)) {
        yield { path, sqlite: true }
      }
      return
    }
    case 'opencode':
      for await (const path of walk(dir, name => /^opencode(?:-[\w-]+)?\.db$/i.test(name), stats, false)) {
        yield { path, sqlite: true, read: readOpenCodeDatabase }
      }
      for await (const path of walk(join(dir, 'storage', 'message'), name => name.toLowerCase().endsWith('.json'), stats)) {
        yield { path, sqlite: false, read: readOpenCodeJson }
      }
      return
    case 'codex':
      for (const subDir of ['sessions', 'archived_sessions']) {
        for await (const path of walk(join(dir, subDir), jsonl, stats)) yield { path, sqlite: false, read: readCodexFile }
      }
      return
    case 'claude':
      for await (const path of walk(join(dir, 'projects'), jsonl, stats)) yield { path, sqlite: false, read: readClaudeFile }
  }
}

export interface UsageServiceOptions {
  userData: string
  bundledSnapshot: string
  home?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export function createUsageService({ userData, bundledSnapshot, home, env, now = Date.now }: UsageServiceOptions) {
  type ScanResult = Awaited<ReturnType<typeof scan>>
  let snapshot: ScanResult | undefined
  let fullScan: Promise<ScanResult> | undefined
  const providerScans = new Map<UsageProviderKind, Promise<ScanResult>>()
  // Incremented when a provider scan starts; a full scan preserves providers
  // whose local refresh started after it did.
  const providerEpoch = new Map<UsageProviderKind, number>()
  const providerApplied = new Map<UsageProviderKind, number>()
  let scanSequence = 0
  let lastFullApplied = 0
  let cacheWrites: Promise<void> = Promise.resolve()

  // Cache writes are serialized and per-provider writes merge into the newest
  // file, so a concurrent full scan cannot silently drop a local refresh.
  function enqueueCacheWrite(task: () => Promise<void>): Promise<void> {
    const next = cacheWrites.then(task, task).catch(() => {
      console.warn('T3-like UsageBoard: unable to save scan cache')
    })
    cacheWrites = next
    return next
  }

  async function persistProviderCache(cache: Map<string, ScanCacheEntry>, provider: UsageProviderKind) {
    const latest = await readScanCache(userData)
    for (const key of [...latest.keys()]) {
      if (latest.get(key)?.provider === provider && !cache.has(key)) latest.delete(key)
    }
    for (const [key, entry] of cache) {
      if (entry.provider === provider) latest.set(key, entry)
    }
    await writeScanCache(userData, latest)
  }

  async function scan(onlyProvider?: UsageProviderKind) {
    const started = performance.now()
    const readAt = new Date(now()).toISOString()
    const cutoff = Date.parse(readAt) - 92 * DAY_MS
    const previous = onlyProvider ? snapshot : undefined
    const [cache, config, pricing] = await Promise.all([
      readScanCache(userData), readConfig(userData), loadPricing(userData, bundledSnapshot)
    ])
    const accounts = await discoverAccounts(config, { home, env })
    const sources: UsageSource[] = []
    const byProvider = new Map<UsageProviderKind, UsageRecord[]>()
    let dirty = false

    for (const provider of providers) {
      // A single-provider refresh keeps the other three straight from memory.
      if (previous && provider !== onlyProvider) continue;
      const roots = new Map<string, { dir: string; allowDirect: boolean }>()
      for (const account of accounts) {
        if ((account.origin === 'manual' && !account.enabled) || account.provider !== provider || !account.dataDir) continue
        const dir = await realpath(account.dataDir).catch(() => account.dataDir!)
        const key = pathKey(dir)
        roots.set(key, { dir, allowDirect: account.origin === 'manual' || roots.get(key)?.allowDirect === true })
      }
      const stats = { errors: 0 }
      const seen = new Set<string>()
      let scannedFiles = 0
      let skippedFiles = 0
      const records: UsageRecord[] = []
      const deduped = new Map<string, UsageRecord>()
      const antigravityModels: [number, string | null][] = []

      function collect(items: UsageRecord[], models?: [number, string | null][]): void {
        if (models) for (const pair of models) antigravityModels.push(pair)
        for (const item of items) {
          if (provider !== 'antigravity' && item.timestampMs < cutoff) continue
          if (provider === 'antigravity' || item.dedupeKey === null) { records.push(item); continue }
          const held = deduped.get(item.dedupeKey)
          deduped.set(item.dedupeKey, held ? mergeUsageCopies(held, item) : item)
        }
      }

      for (const [root, { dir, allowDirect }] of roots) {
        for await (const file of filesFor(provider, dir, stats, allowDirect)) {
          const canonical = await realpath(file.path).catch(() => file.path)
          const key = `${provider}:${pathKey(canonical)}`
          if (seen.has(key)) continue
          seen.add(key)
          const held = cache.get(key)
          try {
            const fingerprint = await fileFingerprint(canonical, file.sqlite)
            if (held?.fingerprint === fingerprint && held.root === root) {
              skippedFiles++
              collect(held.records, held.models)
              continue
            }
            const read: { records: UsageRecord[]; cursors?: Record<string, number>; models?: [number, string | null][] } =
              file.read === readOpenCodeDatabase
                ? await readOpenCodeDatabaseIncremental(canonical, cutoff, held?.cursors)
                : file.read
                  ? { records: await file.read(canonical, cutoff), cursors: undefined }
                  : { ...await scanAntigravityDatabase(canonical), cursors: undefined }
            const fresh = read.records
            let retained = provider === 'antigravity' ? fresh : fresh.filter(item => item.timestampMs >= cutoff)
            if (read.cursors && held) retained = mergeIncremental(held.records, retained, cutoff)
            cache.set(key, {
              provider, root, fingerprint, records: retained, models: read.models,
              ...(read.cursors ? { cursors: read.cursors } : {}),
            })
            dirty = true
            scannedFiles++
            collect(retained, read.models)
          } catch {
            stats.errors++
            if (held) collect(held.records, held.models)
          }
        }
      }
      // Auto-pruned transcript files still contribute until the retention cutoff.
      // Disabled or removed data sources no longer contribute from the cache.
      for (const [key, held] of cache) {
        if (held.provider !== provider) continue
        // Older candidates in a live DB can still resolve a newer copy's real timestamp or identity.
        const retained = provider === 'antigravity' && seen.has(key)
          ? held.records : held.records.filter(record => record.timestampMs >= cutoff)
        if (retained.length !== held.records.length || (!retained.length && !seen.has(key))) {
          if (!retained.length && !seen.has(key)) cache.delete(key)
          else cache.set(key, { ...held, records: retained })
          dirty = true
        }
        if (!seen.has(key) && roots.has(held.root)) collect(retained, retained.length ? held.models : undefined)
      }
      for (const record of deduped.values()) records.push(record)
      const merged = provider === 'antigravity' ? mergeAntigravityRecords(records, cutoff, antigravityModels) : records
      byProvider.set(provider, merged)
      sources.push({
        provider, scannedFiles, skippedFiles, distinctSessions: 0,
        status: stats.errors ? (scannedFiles || skippedFiles || merged.length ? 'partial' : 'failed')
          : scannedFiles || skippedFiles || merged.length ? 'ok' : 'missing'
      })
    }
    if (previous) {
      for (const provider of providers) {
        if (provider === onlyProvider) continue
        byProvider.set(provider, previous.byProvider.get(provider) ?? [])
        const held = previous.sources.find(source => source.provider === provider)
        if (held) sources.push(held)
      }
    }
    if (dirty) {
      await enqueueCacheWrite(() => onlyProvider
        ? persistProviderCache(cache, onlyProvider)
        : writeScanCache(userData, cache))
    }
    return { byProvider, sources, pricing, readAt, elapsed: Math.round(performance.now() - started) }
  }

  function mergeProviderResult(result: ScanResult, provider: UsageProviderKind): ScanResult {
    const current = snapshot
    if (!current) return result
    const byProvider = new Map(current.byProvider)
    byProvider.set(provider, result.byProvider.get(provider) ?? [])
    const sources = [...current.sources]
    const replacement = result.sources.find((source) => source.provider === provider)
    if (replacement) {
      const index = sources.findIndex((source) => source.provider === provider)
      if (index >= 0) sources[index] = replacement
      else sources.push(replacement)
    }
    return {
      ...current, byProvider, sources,
      pricing: result.pricing, readAt: result.readAt, elapsed: result.elapsed,
    }
  }

  /** A local refresh never waits for a background full scan. */
  async function refreshProviderSnapshot(provider: UsageProviderKind): Promise<ScanResult> {
    if (!snapshot) return refreshAll()
    const start = ++scanSequence
    const epoch = (providerEpoch.get(provider) ?? 0) + 1
    providerEpoch.set(provider, epoch)
    const task = scan(provider)
    providerScans.set(provider, task)
    let result: ScanResult
    try {
      result = await task
    } finally {
      if (providerScans.get(provider) === task) providerScans.delete(provider)
    }
    // A full scan that started later and already applied is newer.
    if (lastFullApplied > start) return snapshot ?? result
    if ((providerEpoch.get(provider) ?? 0) !== epoch) return snapshot ?? result
    snapshot = mergeProviderResult(result, provider)
    providerApplied.set(provider, epoch)
    return snapshot
  }

  async function refreshAllNow(): Promise<ScanResult> {
    const start = ++scanSequence
    const startEpoch = new Map(providerEpoch)
    const result = await scan()
    const started = providers.filter(provider =>
      (providerEpoch.get(provider) ?? 0) > (startEpoch.get(provider) ?? 0))
    if (started.length) {
      // Wait for local scans that were already newer than this full pass.
      await Promise.all(started.map(provider => providerScans.get(provider)?.catch(() => undefined)))
    }
    // Only a scan that actually merged is newer; a failed one leaves the full result.
    const newer = providers.filter(provider =>
      (providerApplied.get(provider) ?? 0) > (startEpoch.get(provider) ?? 0))
    lastFullApplied = start
    let merged = result
    if (snapshot) {
      // Preserve any provider whose local scan began after this full pass.
      const byProvider = new Map(result.byProvider)
      const sources = [...result.sources]
      for (const provider of newer) {
        if (snapshot.byProvider.has(provider)) byProvider.set(provider, snapshot.byProvider.get(provider)!)
        const source = snapshot.sources.find((entry) => entry.provider === provider)
        if (source) {
          const index = sources.findIndex((entry) => entry.provider === provider)
          if (index >= 0) sources[index] = source
          else sources.push(source)
        }
      }
      merged = { ...result, byProvider, sources }
    }
    snapshot = merged
    return merged
  }

  function refreshAll(): Promise<ScanResult> {
    if (!fullScan) {
      const task = refreshAllNow()
      fullScan = task
      void task.finally(() => { if (fullScan === task) fullScan = undefined })
    }
    return fullScan
  }

  return {
    async getSummary(input: UsageSummaryInput, refresh = false, refreshProvider?: UsageProviderKind): Promise<UsageSummary> {
      const query = usageSummaryInputSchema.parse(input)
      const [result, config, opencodePricing] = await Promise.all([
        refresh
          ? (refreshProvider && snapshot ? refreshProviderSnapshot(refreshProvider) : refreshAll())
          : (snapshot ?? refreshAll()),
        readConfig(userData),
        loadOpenCodePricing({ home, env })
      ])
      const filter = createUsageWindowFilter(query)
      const records: UsageRecord[] = []
      const distinct = new Map<UsageProviderKind, number>()
      for (const source of result.sources) {
        const sessions = new Set<string>()
        for (const record of result.byProvider.get(source.provider) ?? []) {
          if (!filter(record.timestampMs)) continue
          records.push(record)
          if (record.sessionId) sessions.add(record.sessionId)
        }
        distinct.set(source.provider, sessions.size)
      }
      // Keep the canonical provider order even when one source was reused.
      const sources = providers.flatMap(provider => {
        const source = result.sources.find(entry => entry.provider === provider)
        return source ? [{ ...source, distinctSessions: distinct.get(provider) ?? 0 }] : []
      })
      const modelPriceMap = new Map<string, UsageModelPrice>()
      const buckets = aggregateUsage(records, query, result.pricing, config.priceOverrides, opencodePricing, modelPriceMap)
      return {
        readAt: result.readAt, timeZone: query.timeZone, sinceDay: query.sinceDay, untilDay: query.untilDay,
        buckets, sources, pricing: result.pricing.status, scanDurationMs: result.elapsed,
        modelPrices: Object.fromEntries(modelPriceMap)
      }
    },
    getPricePresets() {
      return loadPricePresets({ userData, bundledSnapshot })
    }
  }
}

import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverAccounts, pathKey, providers } from '../accounts/discovery'
import { readConfig } from '../configStore'
import { usageSummaryInputSchema } from '../../shared/types'
import type { UsageProviderKind, UsageRecord, UsageSource, UsageSummary, UsageSummaryInput } from '../../shared/types'
import { aggregateUsage, createUsageWindowFilter, mergeUsageCopies } from './aggregation'
import { loadOpenCodePricing } from './opencodePricing'
import { loadPricing } from './pricing'
import { fileFingerprint, readScanCache, writeScanCache } from './scanCache'
import { mergeAntigravityRecords, scanAntigravityDatabase } from './readers/antigravity'
import { readClaudeFile } from './readers/claude'
import { readCodexFile } from './readers/codex'
import { readOpenCodeDatabase, readOpenCodeJson } from './readers/opencode'

const DAY_MS = 86_400_000
type Reader = (file: string, cutoffMs?: number) => Promise<UsageRecord[]>
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
  fallbackRates: string
  home?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export function createUsageService({ userData, fallbackRates, home, env, now = Date.now }: UsageServiceOptions) {
  // Serialize writes, but let concurrent filter/tab requests share one scan.
  let scanInFlight: ReturnType<typeof scan> | undefined
  let snapshot: Awaited<ReturnType<typeof scan>> | undefined

  async function scan() {
    const started = performance.now()
    const readAt = new Date(now()).toISOString()
    const cutoff = Date.parse(readAt) - 92 * DAY_MS
    const [cache, config, pricing] = await Promise.all([
      readScanCache(userData), readConfig(userData), loadPricing(userData, fallbackRates)
    ])
    const accounts = await discoverAccounts(config, { home, env })
    const sources: UsageSource[] = []
    const byProvider = new Map<UsageProviderKind, UsageRecord[]>()
    let dirty = false

    for (const provider of providers) {
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
            const { records: fresh, models } = file.read
              ? { records: await file.read(canonical, cutoff), models: undefined }
              : await scanAntigravityDatabase(canonical)
            const retained = provider === 'antigravity' ? fresh : fresh.filter(item => item.timestampMs >= cutoff)
            cache.set(key, { provider, root, fingerprint, records: retained, models })
            dirty = true
            scannedFiles++
            collect(retained, models)
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
    if (dirty) await writeScanCache(userData, cache).catch(() => console.warn('T3-like UsageBoard: unable to save scan cache'))
    return { byProvider, sources, pricing, readAt, elapsed: Math.round(performance.now() - started) }
  }

  return {
    async getSummary(input: UsageSummaryInput, refresh = false): Promise<UsageSummary> {
      const query = usageSummaryInputSchema.parse(input)
      if ((!snapshot || refresh) && !scanInFlight) {
        scanInFlight = scan().then(result => { snapshot = result; return result })
          .finally(() => { scanInFlight = undefined })
      }
      const [result, config, opencodePricing] = await Promise.all([
        refresh ? (scanInFlight ?? snapshot!) : (snapshot ?? scanInFlight!), readConfig(userData),
        loadOpenCodePricing({ home, env })
      ])
      const filter = createUsageWindowFilter(query)
      const records: UsageRecord[] = []
      const sources = result.sources.map(source => {
        const sessions = new Set<string>()
        for (const record of result.byProvider.get(source.provider) ?? []) {
          if (!filter(record.timestampMs)) continue
          records.push(record)
          if (record.sessionId) sessions.add(record.sessionId)
        }
        return { ...source, distinctSessions: sessions.size }
      })
      return {
        readAt: result.readAt, timeZone: query.timeZone, sinceDay: query.sinceDay, untilDay: query.untilDay,
        buckets: aggregateUsage(records, query, result.pricing, config.priceOverrides, config.modelAliases, opencodePricing),
        sources, pricing: result.pricing.status, scanDurationMs: result.elapsed
      }
    }
  }
}

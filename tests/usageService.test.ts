import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createUsageService } from '../src/main/usage/service'
import { readConfig, writeConfig } from '../src/main/configStore'

test('scans a shared root once, caches unchanged files, and retains auto-pruned history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-service-'))
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
  try {
    const userData = join(home, 'app')
    const claudeHome = join(home, '.claude')
    const projects = join(claudeHome, 'projects')
    await mkdir(projects, { recursive: true })
    const transcript = join(projects, 'abc.jsonl')
    await writeFile(transcript, JSON.stringify({
      type: 'assistant', timestamp: '2026-11-22T11:00:00Z', requestId: 'req', sessionId: 'sess',
      message: { id: 'msg', model: 'claude-sonnet-4-6-high', usage: { input_tokens: 100, output_tokens: 10 } }
    }) + '\n')
    const config = await readConfig(userData)
    config.accounts = [{ id: 'shared', provider: 'claude', displayName: 'same', dataDir: claudeHome }]
    await writeConfig(userData, config)
    let clock = Date.parse('2026-11-24T00:00:00Z')
    const service = createUsageService({
      home, env: {}, userData, now: () => clock, fallbackRates: resolve('resources/fallback-rates.json')
    })
    const query = { sinceDay: '2026-11-01', untilDay: '2026-11-24', timeZone: 'UTC' }
    const first = await service.getSummary(query)
    expect(first.sources.find(s => s.provider === 'claude')).toMatchObject({ scannedFiles: 1, distinctSessions: 1 })
    expect(first.buckets).toHaveLength(1)
    expect(first.buckets[0]).toMatchObject({ model: 'claude-sonnet-4-6', records: 1, totals: { uncachedInputTokens: 100 } })
    await writeConfig(userData, {
      ...config,
      modelAliases: { 'claude-sonnet-4-6': 'example-alias' },
      priceOverrides: { 'example-alias': { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 50 } }
    })
    const repriced = await service.getSummary(query)
    expect(repriced.readAt).toBe(first.readAt)
    expect(repriced.buckets[0]).toMatchObject({ model: 'example-alias', costUsd: 0.001 })
    await writeConfig(userData, config)
    const cached = await service.getSummary(query, true)
    expect(cached.sources.find(s => s.provider === 'claude')).toMatchObject({ scannedFiles: 0, skippedFiles: 1 })
    expect(cached.buckets).toEqual(first.buckets)
    await rm(transcript)
    expect((await service.getSummary(query, true)).buckets).toEqual(first.buckets)
    clock += 93 * 86_400_000
    expect((await service.getSummary(query, true)).buckets).toEqual([])
  } finally {
    fetchMock.mockRestore()
    await rm(home, { recursive: true, force: true })
  }
})

test.skipIf(!process.env.USAGE_SMOKE_SUMMARY)('exports real local usage into an isolated smoke-test summary', async () => {
  const output = process.env.USAGE_SMOKE_SUMMARY!
  const userData = await mkdtemp(join(tmpdir(), 'usage-smoke-'))
  const now = new Date()
  const since = new Date(now.getTime() - 90 * 86_400_000)
  const isoDay = (date: Date) => date.toISOString().slice(0, 10)
  try {
    const summary = await createUsageService({ userData, fallbackRates: resolve('resources/fallback-rates.json') })
      .getSummary({ timeZone: 'UTC', sinceDay: isoDay(since), untilDay: isoDay(now) })
    await writeFile(output, JSON.stringify(summary, null, 2))
    expect(summary.buckets.length).toBeGreaterThan(0)
    expect(summary.buckets.every(bucket => Number.isFinite(bucket.costUsd) && bucket.records > 0)).toBe(true)
    console.log('UsageSummary smoke:', JSON.stringify({
      buckets: summary.buckets.length, pricing: summary.pricing.status, sources: summary.sources, scanDurationMs: summary.scanDurationMs
    }))
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
}, 180_000)

test('scans a directly selected Antigravity conversations directory and keeps anonymous OpenCode usage cached', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-direct-'))
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
  try {
    const userData = join(home, 'app')
    const profile = join(home, '.gemini', 'antigravity')
    const conversations = join(profile, 'conversations')
    const openCode = join(home, 'opencode')
    const messages = join(openCode, 'storage', 'message', 'legacy')
    await mkdir(conversations, { recursive: true })
    await mkdir(messages, { recursive: true })
    const db = new DatabaseSync(join(conversations, 'trajectory.db'))
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)')
      // Generation: model ID 1071, 15 input tokens; timestamp falls back to DB mtime.
      db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, Buffer.from('0a0718af082202100f', 'hex'))
    } finally { db.close() }
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    await writeFile(join(messages, 'msg.json'), JSON.stringify({
      role: 'assistant', modelID: 'gpt-5.4', time: { created: now }, tokens: { input: 25 }
    }))
    const config = await readConfig(userData)
    config.accounts = [{ id: 'direct', provider: 'antigravity', displayName: 'Direct', dataDir: conversations }]
    await writeConfig(userData, config)
    const options = { userData, fallbackRates: resolve('resources/fallback-rates.json'), home,
      env: { ANTIGRAVITY_DATA_DIR: join(home, 'missing'), OPENCODE_DATA_DIR: openCode } }
    const query = { sinceDay: day, untilDay: day, timeZone: 'UTC' }
    const first = await createUsageService(options).getSummary(query)
    expect(first.buckets.find(bucket => bucket.provider === 'antigravity')).toMatchObject({
      records: 1, totals: { uncachedInputTokens: 15 }
    })
    expect(first.buckets.find(bucket => bucket.provider === 'opencode')).toMatchObject({
      records: 1, sessions: 0, totals: { uncachedInputTokens: 25 }
    })
    expect(first.sources.find(source => source.provider === 'opencode')?.distinctSessions).toBe(0)
    const cached = await createUsageService(options).getSummary(query)
    expect(cached.sources.find(source => source.provider === 'opencode')).toMatchObject({
      scannedFiles: 0, skippedFiles: 1, distinctSessions: 0
    })
    expect(cached.buckets).toEqual(first.buckets)
    const withNative = await createUsageService({ ...options, env: { ...options.env, ANTIGRAVITY_DATA_DIR: profile } }).getSummary(query)
    expect(withNative.buckets.find(bucket => bucket.provider === 'antigravity')?.records).toBe(1)
  } finally {
    fetchMock.mockRestore()
    await rm(home, { recursive: true, force: true })
  }
})

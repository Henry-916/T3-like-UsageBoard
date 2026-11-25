// Adapted from T3 Code (MIT), Copyright (c) 2026 T3 Tools Inc.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { LimitsProbeContext, LimitsProbeResult, LimitWindow } from '../../../shared/limitsTypes'
import type { DiscoveredAccount } from '../../../shared/types'

const usageWindow = z.object({
  percent: z.number(),
  resetsAt: z.iso.datetime({ offset: true })
})
const usageResponse = z.object({
  usage: z.object({ rolling: usageWindow, weekly: usageWindow, monthly: usageWindow })
})
const storedKey = z.object({
  type: z.literal('key'), key: z.string(),
  metadata: z.object({ server: z.unknown() }).nullish()
})
const authFile = z.object({ 'opencode-go': z.object({ type: z.literal('api'), key: z.string() }) })

function databaseKeys(dataDir?: string): string[] {
  if (!dataDir) return []
  try {
    const db = new DatabaseSync(join(dataDir, 'opencode.db'), { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 100')
      const select = db.prepare(`
        SELECT value FROM credential WHERE integration_id = ? AND active IS NOT 0
        ORDER BY active DESC, time_created DESC, id DESC
      `)
      return ['opencode', 'opencode-go'].flatMap(id => {
        for (const row of select.iterate(id)) {
          if (typeof row.value !== 'string') continue
          const parsed = (() => {
            try { return storedKey.safeParse(JSON.parse(row.value)) } catch { return undefined }
          })()
          if (!parsed?.success) continue
          const { key, metadata } = parsed.data
          const server = metadata?.server
          if (server != null && (typeof server !== 'string'
            || (server.trim() && server.trim().replace(/\/+$/, '') !== 'https://opencode.ai/console'))) continue
          if (key.trim()) return [key]
        }
        return []
      })
    } finally {
      db.close()
    }
  } catch {
    // Older databases may not have credential storage.
    return []
  }
}

export function hasOpenCodeDbCredential(dataDir?: string): boolean {
  return databaseKeys(dataDir).length > 0
}

export async function probeOpenCode(account: DiscoveredAccount, ctx: LimitsProbeContext): Promise<LimitsProbeResult> {
  try {
    ctx.signal.throwIfAborted()
    const keys = databaseKeys(account.dataDir)
    for (const path of account.credentialPaths ?? []) {
      const stored = await ctx.readCredential(path).catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'ENOENT') throw error
      })
      ctx.signal.throwIfAborted()
      const parsed = authFile.safeParse(stored)
      if (parsed.success) keys.push(parsed.data['opencode-go'].key)
    }
    keys.push(account.origin === 'native' ? process.env.OPENCODE_API_KEY ?? '' : '', ctx.manualApiKey ?? '')
    const unique = [...new Set(keys.map(key => key.trim()).filter(Boolean))]
    let lastStatus = 403
    for (const key of unique) {
      ctx.signal.throwIfAborted()
      const response = await ctx.fetch('https://opencode.ai/zen/go/v1/usage', {
        headers: { Authorization: `Bearer ${key}` }, signal: ctx.signal, redirect: 'error'
      })
      lastStatus = response.status
      if (lastStatus === 401 || lastStatus === 403) continue
      if (!response.ok) return { kind: 'failed' }
      const { usage } = usageResponse.parse(await response.json())
      ctx.signal.throwIfAborted()
      const names = ['rolling', 'weekly', 'monthly'] as const
      const windows: LimitWindow[] = names.map((name, index) => ({
        id: `go_${name}`,
        kind: (['session', 'weekly', 'monthly'] as const)[index],
        label: `Go · ${['Session', 'Weekly', 'Monthly'][index]}`,
        windowDurationMins: [300, 10080, 43200][index],
        usedPercent: Math.max(0, Math.min(100, usage[name].percent)),
        resetsAt: new Date(usage[name].resetsAt).toISOString()
      }))
      return {
        kind: 'ok', windows,
        fingerprint: createHash('sha256').update(`opencode-go\0${key}`).digest('hex')
      }
    }
    ctx.signal.throwIfAborted()
    return { kind: lastStatus === 403 ? 'unsupported' : 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

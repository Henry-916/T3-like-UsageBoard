import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { LimitAccountReading } from '../../shared/limitsTypes'
import { providerSchema } from '../../shared/types'

const timestamp = z.iso.datetime()
const windows = z.array(z.object({
  id: z.string(), kind: z.enum(['session', 'weekly', 'monthly', 'other']),
  label: z.string(), usedPercent: z.number(), resetsAt: z.string().optional(),
  windowDurationMins: z.number().optional(), modelIds: z.array(z.string()).optional()
}))
const entry = z.object({
  id: z.string().min(1),
  identity: z.string().min(1),
  data: z.object({
    id: z.string().min(1), provider: providerSchema, displayName: z.string(),
    origin: z.enum(['native', 'manual']), plan: z.string().optional(),
    windows: windows.min(1), checkedAt: timestamp, resetCredits: z.number().optional(),
    resetCreditsExpiresAt: timestamp.optional(), nextResetCreditId: z.string().min(1).optional(),
    previous: z.object({ checkedAt: timestamp, windows }).optional()
  })
}).refine(({ id, data }) => id === data.id)

function parseEntries(input: unknown): z.infer<typeof entry>[] {
  if (!Array.isArray(input)) return []
  return input.flatMap(item => {
    const parsed = entry.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

export function createLimitsCache(userData: string) {
  const path = join(userData, 'limits-cache.json')
  let pending = Promise.resolve()
  let lastSaved = '[]'
  return {
    async load() {
      try {
        const input = await readFile(path, 'utf8')
        const entries = parseEntries(JSON.parse(input))
        lastSaved = input
        return entries
      } catch {
        return []
      }
    },
    save(readings: ReadonlyMap<string, { identity: string; data: LimitAccountReading }>) {
      const snapshot = JSON.stringify(parseEntries([...readings].map(([id, reading]) => ({ id, ...reading }))))
      pending = pending.then(async () => {
        if (snapshot === lastSaved) return
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          await mkdir(userData, { recursive: true })
          await writeFile(temp, snapshot, { mode: 0o600 })
          await rename(temp, path)
          lastSaved = snapshot
        } catch {
          await rm(temp, { force: true }).catch(() => undefined)
        }
      })
      return pending
    }
  }
}

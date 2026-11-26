import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { providerSchema, usageRecordSchema } from '../../shared/types'
import { readJson, writeJsonAtomic } from '../jsonFile'

const fileEntry = z.object({
  provider: providerSchema,
  root: z.string(),
  fingerprint: z.string(),
  models: z.array(z.tuple([z.number(), z.string().nullable()])).optional(),
  records: z.array(usageRecordSchema)
})
export type ScanCacheEntry = z.infer<typeof fileEntry>
const cacheFile = 'scan-cache.json'
const cacheVersion = 3

export async function readScanCache(userData: string): Promise<Map<string, ScanCacheEntry>> {
  try {
    const data = z.object({ version: z.literal(cacheVersion), files: z.record(z.string(), z.unknown()) })
      .safeParse(await readJson(join(userData, cacheFile)))
    if (data.success) {
      const cache = new Map<string, ScanCacheEntry>()
      for (const [key, entry] of Object.entries(data.data.files)) {
        const parsed = fileEntry.safeParse(entry)
        if (parsed.success) cache.set(key, parsed.data)
      }
      return cache
    }
  } catch { /* Corruption and first-run cache misses are recoverable. */ }
  return new Map()
}

export function writeScanCache(userData: string, cache: Map<string, ScanCacheEntry>): Promise<void> {
  return writeJsonAtomic(join(userData, cacheFile), { version: cacheVersion, files: Object.fromEntries(cache) })
}

function statKey(info: Awaited<ReturnType<typeof stat>>): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
}

export async function fileFingerprint(path: string, sqlite: boolean): Promise<string> {
  const main = statKey(await stat(path))
  if (!sqlite) return main
  const wal = await stat(`${path}-wal`).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  })
  return `${main}|${wal ? statKey(wal) : ''}`
}

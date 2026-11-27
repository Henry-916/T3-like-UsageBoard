import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { accountConfigSchema, priceOverridesSchema, uiPreferencesSchema } from '../shared/types'
import { APP_VERSION } from '../shared/version'
import { readJson, writeJsonAtomic } from './jsonFile'

const configSchema = z.object({
  accounts: z.array(accountConfigSchema).default([]),
  hiddenAccountIds: z.array(z.string().trim().min(1)).default([]),
  accountPreferences: z.record(z.string(), z.object({
    enabled: z.boolean().optional(),
    displayName: z.string().trim().min(1).optional()
  })).default({}),
  priceOverrides: priceOverridesSchema.default({}),
  preferences: uiPreferencesSchema.extend({
    launchAtLogin: z.boolean().optional(),
    lastSeenVersion: z.string().trim().min(1).optional()
  }).default({})
})

export type AppConfig = z.infer<typeof configSchema>

export async function readConfig(userData: string): Promise<AppConfig> {
  try {
    const parsed = configSchema.safeParse(await readJson(join(userData, 'config.json')))
    if (parsed.success) return parsed.data
  } catch { /* A missing or invalid file does not prevent a usage scan. */ }
  return configSchema.parse({})
}

function configHasHistory(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const row = raw as Record<string, unknown>
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : {}
  if (list(row.accounts).length || list(row.hiddenAccountIds).length) return true
  if (Object.keys(record(row.accountPreferences)).length || Object.keys(record(row.priceOverrides)).length) return true
  return Object.keys(record(row.preferences)).some((key) => key !== 'lastSeenVersion')
}

export async function readWhatsNewStatus(userData: string): Promise<{ version: string; shouldShow: boolean }> {
  let hasHistory = false
  let lastSeenVersion: string | undefined
  let configReadable = false
  try {
    const raw: unknown = JSON.parse((await readFile(join(userData, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''))
    const parsed = configSchema.safeParse(raw)
    // A present but unreadable config is never overwritten by a fresh-install mark.
    if (!parsed.success) return { version: APP_VERSION, shouldShow: false }
    configReadable = true
    hasHistory = configHasHistory(raw)
    lastSeenVersion = parsed.data.preferences.lastSeenVersion
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { version: APP_VERSION, shouldShow: false }
    }
  }
  if (!configReadable || (lastSeenVersion === undefined && !hasHistory)) {
    await updateConfig(userData, config => ({
      ...config,
      preferences: { ...config.preferences, lastSeenVersion: APP_VERSION }
    })).catch(() => undefined)
    return { version: APP_VERSION, shouldShow: false }
  }
  return { version: APP_VERSION, shouldShow: lastSeenVersion !== APP_VERSION }
}

export function markWhatsNewSeen(userData: string): Promise<void> {
  return updateConfig(userData, config => ({
    ...config,
    preferences: { ...config.preferences, lastSeenVersion: APP_VERSION }
  }))
}

export function writeConfig(userData: string, data: AppConfig): Promise<void> {
  return writeJsonAtomic(join(userData, 'config.json'), configSchema.parse(data))
}

const configWrites = new Map<string, Promise<void>>()

export async function updateConfig(userData: string, edit: (current: AppConfig) => AppConfig | Promise<AppConfig>): Promise<void> {
  const previous = configWrites.get(userData)
  const current = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await writeConfig(userData, await edit(await readConfig(userData)))
  })
  configWrites.set(userData, current)
  try {
    await current
  } finally {
    if (configWrites.get(userData) === current) configWrites.delete(userData)
  }
}

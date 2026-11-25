import { join } from 'node:path'
import { z } from 'zod'
import { accountConfigSchema, modelAliasesSchema, priceOverridesSchema, uiPreferencesSchema } from '../shared/types'
import { readJson, writeJsonAtomic } from './jsonFile'

const configSchema = z.object({
  scanT3: z.boolean().default(true),
  accounts: z.array(accountConfigSchema).default([]),
  hiddenAccountIds: z.array(z.string().trim().min(1)).default([]),
  accountPreferences: z.record(z.string(), z.object({
    enabled: z.boolean().optional(),
    displayName: z.string().trim().min(1).optional()
  })).default({}),
  priceOverrides: priceOverridesSchema.default({}),
  modelAliases: modelAliasesSchema.default({}),
  preferences: uiPreferencesSchema.extend({
    launchAtLogin: z.boolean().optional()
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

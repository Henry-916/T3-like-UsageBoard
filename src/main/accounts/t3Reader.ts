import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { UsageProviderKind } from '../../shared/types'
import { readJson } from '../jsonFile'

const envelope = z.object({ providerInstances: z.record(z.string(), z.unknown()) })
const instance = z.object({
  driver: z.enum(['antigravity', 'codex', 'claudeAgent', 'opencode']),
  displayName: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
  environment: z.unknown().optional()
})
const pathConfig = z.object({
  homePath: z.string().optional(),
  dataDir: z.string().optional(),
  authMethod: z.string().optional()
})
const environmentVariable = z.object({ name: z.string(), value: z.string() })
const pathVariables = new Set(['ANTIGRAVITY_DATA_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCODE_DATA_DIR', 'XDG_DATA_HOME'])

export interface T3Instance {
  id: string
  provider: UsageProviderKind
  displayName: string
  enabled: boolean
  profileDir?: string
  configuredDir?: string
  authMethod?: string
  env: NodeJS.ProcessEnv
}

export async function readT3Instances(home: string): Promise<T3Instance[]> {
  const root = join(home, '.t3', 'userdata')
  const settings = await readJson(join(root, 'settings.json')).catch(() => undefined)
  const parsed = envelope.safeParse(settings)
  if (!parsed.success) return []
  const result: T3Instance[] = []
  for (const [id, value] of Object.entries(parsed.data.providerInstances)) {
    const known = instance.safeParse(value)
    if (!known.success) continue
    const item = known.data
    const provider = item.driver === 'claudeAgent' ? 'claude' : item.driver
    const config = pathConfig.safeParse(item.config)
    const configuredDir = config.success ? config.data.homePath?.trim() || config.data.dataDir?.trim() : undefined
    const env: NodeJS.ProcessEnv = {}
    if (Array.isArray(item.environment)) {
      for (const candidate of item.environment) {
        const variable = environmentVariable.safeParse(candidate)
        if (variable.success && pathVariables.has(variable.data.name) && variable.data.value.trim()) {
          env[variable.data.name] = variable.data.value
        }
      }
    }
    result.push({
      id,
      provider,
      displayName: item.displayName ?? id,
      enabled: item.enabled ?? true,
      configuredDir,
      authMethod: config.success ? config.data.authMethod : undefined,
      env,
      profileDir: provider === 'antigravity'
        ? join(root, 'providers', 'antigravity', createHash('sha256').update(id).digest('hex'), 'antigravity-acp')
        : undefined
    })
  }
  return result
}

import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DiscoveredAccount, UsageProviderKind } from '../../shared/types'
import type { AppConfig } from '../configStore'
import { readT3Instances } from './t3Reader'

export const providers = ['antigravity', 'opencode', 'codex', 'claude'] as const
export const providerNames = { antigravity: 'Antigravity', opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code' }
const credentials: Record<UsageProviderKind, string[]> = {
  antigravity: ['acp_token.json', 'antigravity-oauth-token'],
  opencode: ['auth.json'],
  codex: ['auth.json'],
  claude: ['.credentials.json']
}
const splitDirs = (value?: string): string[] => value?.split(',').map((dir) => dir.trim()).filter(Boolean) ?? []

export function expandDir(value: string, home: string): string {
  const path = value.trim()
  return resolve(path === '~' ? home : /^~[/\\]/.test(path) ? join(home, path.slice(2)) : path)
}

export const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value

function locations(provider: UsageProviderKind, env: NodeJS.ProcessEnv, home: string, defaults: boolean): string[] {
  switch (provider) {
    case 'claude': return env.CLAUDE_CONFIG_DIR?.trim() ? [env.CLAUDE_CONFIG_DIR] : defaults ? [join(home, '.claude')] : []
    case 'codex': return env.CODEX_HOME?.trim() ? [env.CODEX_HOME] : defaults ? [join(home, '.codex')] : []
    case 'antigravity': {
      const specified = splitDirs(env.ANTIGRAVITY_DATA_DIR)
      if (specified.length || !defaults) return specified
      return [
        ...['antigravity-acp', 'antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup'].map(name => join(home, '.gemini', name)),
        join(home, '.config', 'antigravity')
      ]
    }
    case 'opencode': {
      const specified = splitDirs(env.OPENCODE_DATA_DIR)
      if (specified.length) return specified
      const xdg = env.XDG_DATA_HOME?.trim()
      return [
        ...(xdg ? [join(xdg, 'opencode')] : defaults ? [join(home, '.local', 'share', 'opencode')] : []),
        ...(defaults && process.platform === 'win32' && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'opencode')] : [])
      ]
    }
  }
}

export async function discoverAccounts(
  config: AppConfig,
  { home = homedir(), env = process.env }: { home?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<DiscoveredAccount[]> {
  const found: DiscoveredAccount[] = []
  const add = (account: DiscoveredAccount): void => {
    const preference = Object.hasOwn(config.accountPreferences, account.id) ? config.accountPreferences[account.id] : undefined
    found.push({
      ...account,
      displayName: preference?.displayName ?? account.displayName,
      enabled: preference?.enabled ?? account.enabled
    })
  }
  for (const provider of providers) {
    const seen = new Set<string>()
    for (const choice of locations(provider, env, home, true)) {
      const dataDir = await realpath(expandDir(choice, home)).catch(() => undefined)
      if (!dataDir || seen.has(pathKey(dataDir)) || !(await stat(dataDir).catch(() => undefined))?.isDirectory()) continue
      seen.add(pathKey(dataDir))
      add({
        id: `native:${provider}:${createHash('sha256').update(pathKey(dataDir)).digest('hex').slice(0, 20)}`,
        provider, origin: 'native', displayName: providerNames[provider], enabled: true,
        dataDir, credentialPaths: credentials[provider].map(name => join(dataDir, name))
      })
    }
    if (provider === 'opencode' && !seen.size && env.OPENCODE_API_KEY?.trim()) {
      add({ id: 'native:opencode:env', provider, origin: 'native', displayName: providerNames[provider], enabled: true })
    }
  }
  if (config.scanT3) {
    for (const item of await readT3Instances(home)) {
      const candidates = [...new Set([
        ...(item.profileDir ? [item.profileDir] : []),
        ...(item.configuredDir ? [item.configuredDir] : []),
        ...locations(item.provider, item.env, home, false)
      ].map(dir => expandDir(dir, home)))]
      const credentialPaths = candidates.flatMap(dir => credentials[item.provider].map(name => join(dir, name)))
      for (const [index, dataDir] of candidates.entries()) {
        add({
          id: `t3:${item.id}${index ? `:data:${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}` : ''}`,
          provider: item.provider, origin: 't3', displayName: item.displayName, enabled: item.enabled,
          dataDir, credentialPaths, limitsEnv: { ANTIGRAVITY_AUTH_METHOD: item.authMethod }
        })
      }
    }
  }
  for (const item of config.accounts) {
    const dataDir = item.dataDir && expandDir(item.dataDir, home)
    const credentialPath = item.credentialPath && expandDir(item.credentialPath, home)
    add({
      ...item, dataDir, credentialPath, origin: 'manual', enabled: true,
      credentialPaths: [...(credentialPath ? [credentialPath] : []), ...(dataDir ? credentials[item.provider].map(name => join(dataDir, name)) : [])]
    })
  }
  return found
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { discoverAccounts } from '../src/main/accounts/discovery'
import { readConfig, writeConfig } from '../src/main/configStore'

test('reads native and manual accounts and ignores residual T3 data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-discovery-'))
  try {
    const userData = join(home, 'app')
    const claudeDir = join(home, 'native-claude')
    const t3 = join(home, '.t3', 'userdata')
    const settings = join(t3, 'settings.json')
    await mkdir(t3, { recursive: true })
    await mkdir(claudeDir)
    const raw = JSON.stringify({
      providerInstances: {
        gravity: { driver: 'antigravity', displayName: 'T3 Gravity' },
        codex: { driver: 'codex', enabled: false, environment: [{ name: 'CODEX_HOME', value: '~/alt-codex' }] }
      }
    })
    await writeFile(settings, raw)
    const config = await readConfig(userData)
    config.accounts = [{ id: 'manual-opencode', provider: 'opencode', displayName: 'My OpenCode', dataDir: '~/oc' }]
    config.accountPreferences = { 't3:gravity': { displayName: 'Renamed' } }
    await writeConfig(userData, config)
    // An upgraded config.json may still carry the removed scan switch; Zod strips it.
    const stored = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(userData, 'config.json'), JSON.stringify({ ...stored, scanT3: false }))
    const upgraded = await readConfig(userData)
    expect(upgraded).not.toHaveProperty('scanT3')
    const options = { home, env: { CLAUDE_CONFIG_DIR: claudeDir } }
    const accounts = await discoverAccounts(upgraded, options)
    expect(accounts.map(a => a.origin).sort()).toEqual(['manual', 'native'])
    expect(accounts.map(a => a.id).filter(id => id.startsWith('t3:'))).toEqual([])
    expect(accounts.find(a => a.id === 'manual-opencode')).toMatchObject({ dataDir: join(home, 'oc'), origin: 'manual' })
    expect(await readFile(settings, 'utf8')).toBe(raw)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('discovers ACP first and retains hidden and credentialless history directories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-discovery-acp-'))
  try {
    const dirs = ['antigravity-acp', 'antigravity', 'antigravity-cli', 'antigravity-ide']
      .map(name => join(home, '.gemini', name))
    await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })))
    await writeFile(join(dirs[0], 'acp_token.json'), '{"fixture":true}')
    const config = await readConfig(join(home, 'app'))
    const options = { home, env: {} }
    const accounts = await discoverAccounts(config, options)
    expect(accounts.map(account => account.dataDir)).toEqual(dirs)
    expect(accounts[0].credentialPaths).toContain(join(dirs[0], 'acp_token.json'))
    expect(await discoverAccounts({ ...config, hiddenAccountIds: [accounts[0].id] }, options)).toEqual(accounts)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

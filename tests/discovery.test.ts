import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { discoverAccounts } from '../src/main/accounts/discovery'
import { readConfig, writeConfig } from '../src/main/configStore'

test('reads native, T3 and manual accounts without modifying T3 settings', async () => {
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
        codex: { driver: 'codex', enabled: false, environment: [{ name: 'CODEX_HOME', value: '~/alt-codex' }] },
        claude: { driver: 'claudeAgent', config: { homePath: '~/native-claude' } },
        inheritedCodex: { driver: 'codex' },
        inheritedOpencode: { driver: 'opencode' },
        cursor: { driver: 'cursor' }
      }
    })
    await writeFile(settings, raw)
    const config = await readConfig(userData)
    config.accounts = [{ id: 'manual-opencode', provider: 'opencode', displayName: 'My OpenCode', dataDir: '~/oc' }]
    config.accountPreferences = { 't3:gravity': { displayName: 'Renamed' } }
    await writeConfig(userData, config)
    const options = { home, env: { CLAUDE_CONFIG_DIR: claudeDir } }
    const accounts = await discoverAccounts(await readConfig(userData), options)
    expect(accounts).toHaveLength(5)
    expect(accounts.map(a => a.id)).not.toContain('t3:inheritedCodex')
    expect(accounts.map(a => a.id)).not.toContain('t3:inheritedOpencode')
    expect(accounts.find(a => a.id === 't3:gravity')).toMatchObject({
      displayName: 'Renamed',
      dataDir: join(t3, 'providers', 'antigravity', createHash('sha256').update('gravity').digest('hex'), 'antigravity-acp')
    })
    expect(accounts.find(a => a.id === 't3:codex')).toMatchObject({ dataDir: join(home, 'alt-codex'), enabled: false })
    expect(accounts.find(a => a.id === 'manual-opencode')).toMatchObject({ dataDir: join(home, 'oc'), origin: 'manual' })
    expect(await readFile(settings, 'utf8')).toBe(raw)
    expect((await discoverAccounts({ ...config, scanT3: false }, options)).map(a => a.origin)).toEqual(['native', 'manual'])
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

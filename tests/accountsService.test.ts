import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createAccountService } from '../src/main/accounts/service'
import { discoverAccounts } from '../src/main/accounts/discovery'
import { readConfig } from '../src/main/configStore'

test('imports credentials privately, persists preferences, and removes the imported copy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-accounts-'))
  try {
    const userData = join(home, 'app')
    const credential = join(home, 'acp_token.json')
    const sensitive = '{"refresh_token":"fixture-not-a-credential"}'
    await writeFile(credential, sensitive)
    const service = createAccountService({
      userData, pickDirectory: async () => undefined, pickCredential: async () => credential,
      encrypt: text => Buffer.from(Buffer.from(text, 'utf8').map(byte => byte ^ 0x55)),
      decrypt: bytes => Buffer.from(bytes.map(byte => byte ^ 0x55)).toString('utf8'),
      discover: config => discoverAccounts(config, { home, env: {} })
    })
    const canceled = await service.add({ provider: 'claude', displayName: 'Personal', mode: 'directory' })
    expect(canceled).toBeNull()
    const result = await service.add({ provider: 'antigravity', displayName: 'Personal', mode: 'credential' })
    const view = result!.accounts[0]
    expect(view).toMatchObject({ provider: 'antigravity', origin: 'manual', enabled: true, hasCredential: true })
    expect(view).not.toHaveProperty('credentialPath')
    const item = (await service.listInternal())[0]
    expect((await readFile(item.credentialPath!, 'utf8'))).not.toContain('fixture-not-a-credential')
    expect(await service.readCredential(item.credentialPath!)).toEqual(JSON.parse(sensitive))
    expect(await readFile(credential, 'utf8')).toBe(sensitive)
    expect((await service.update(view.id, { displayName: 'Renamed', enabled: false })).accounts[0])
      .toMatchObject({ displayName: 'Renamed', enabled: false })
    expect((await service.setScanT3(false)).scanT3).toBe(false)
    expect((await service.remove(view.id)).accounts).toEqual([])
    await expect(readFile(item.credentialPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('lists only usable auto credentials, persists hiding, and restores without touching source files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-accounts-hide-'))
  const env = { OPENCODE_DATA_DIR: join(home, 'opencode') }
  vi.stubEnv('OPENCODE_API_KEY', ' ')
  try {
    const userData = join(home, 'app')
    const files = [
      [join(home, '.gemini', 'antigravity'), 'history.db', 'fixture-history'],
      [join(home, '.gemini', 'antigravity-acp'), 'acp_token.json', '{"fixture":true}'],
      [join(home, '.codex'), 'auth.json', '{"OPENAI_API_KEY":"fixture"}'],
      [join(home, '.claude'), '.credentials.json', '{"claudeAiOauth":{"refreshToken":"fixture"}}'],
      [env.OPENCODE_DATA_DIR, 'auth.json', '{"unrelated":{"key":"fixture"}}']
    ]
    for (const [dir, name, text] of files) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, name), text)
    }
    const db = new DatabaseSync(join(env.OPENCODE_DATA_DIR, 'opencode.db'))
    try {
      db.exec('CREATE TABLE credential (id INTEGER PRIMARY KEY, integration_id TEXT, active INTEGER, time_created INTEGER, value TEXT)')
      const insert = db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)')
      insert.run(1, 'opencode-go', 1, 1, '{"type":"key","key":"fixture","metadata":{"server":""}}')
      insert.run(2, 'opencode-go', 1, 2, '{"type":"key","key":"wrong-server","metadata":{"server":"https://example.test"}}')
    } finally { db.close() }
    const service = createAccountService({
      userData, pickDirectory: async () => files[2][0], pickCredential: async () => undefined,
      encrypt: () => { throw new Error('Unexpected encryption') }, decrypt: () => { throw new Error('Unexpected decryption') },
      discover: async config => {
        const accounts = await discoverAccounts(config, { home, env })
        accounts.push({
          ...accounts.find(account => account.provider === 'antigravity')!,
          id: 't3:vertex', origin: 't3', limitsEnv: { ANTIGRAVITY_AUTH_METHOD: 'vertex' }
        })
        return accounts
      }
    })
    const initial = await service.list()
    expect(initial.accounts.map(account => account.provider)).toEqual(['antigravity', 'opencode', 'claude'])
    const claude = initial.accounts[2].id
    await service.update(claude, { displayName: 'Custom' })
    await service.remove(claude)
    expect(await service.remove(claude)).toMatchObject({ hiddenAutoCount: 1 })
    expect((await readConfig(userData)).hiddenAccountIds).toEqual([claude])
    expect((await readConfig(userData)).accountPreferences[claude]).toBeUndefined()
    expect((await service.listInternal()).map(account => account.provider)).toEqual(['antigravity', 'opencode'])
    expect((await service.restoreHidden()).accounts[2].displayName).toBe('Claude Code')
    await expect(service.remove('unknown')).rejects.toThrow('Unknown account')
    const added = await service.add({ provider: 'codex', displayName: 'Imported', mode: 'directory' })
    const manual = added!.accounts.find(account => account.origin === 'manual')!
    expect(manual.hasCredential).toBe(false)
    await service.remove(manual.id)
    for (const [dir, name, text] of files) expect(await readFile(join(dir, name), 'utf8')).toBe(text)
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})

test('managed accounts validate ownership, serialize names, and clean up after the removal callback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-accounts-managed-'))
  try {
    const userData = join(home, 'app')
    const id = (n: number) => `manual-00000000-0000-0000-0000-00000000000${n}`
    const profile = join(userData, 'profiles', id(3))
    const external = join(home, 'external')
    let callbackSnapshot: { hasAccount: boolean; credential: string } | undefined
    const callback = vi.fn(async account => {
      if (account.credentialPath) {
        callbackSnapshot = {
          hasAccount: (await readConfig(userData)).accounts.some(item => item.id === account.id),
          credential: await readFile(account.credentialPath, 'utf8')
        }
        throw new Error('cache unavailable')
      }
    })
    const service = createAccountService({
      userData, pickDirectory: async () => undefined, pickCredential: async () => undefined,
      encrypt: text => Buffer.from(`encrypted:${text}`), decrypt: bytes => bytes.toString().slice('encrypted:'.length),
      discover: config => discoverAccounts(config, { home, env: {} }), onAccountRemoved: callback
    })
    const credential = { filename: 'antigravity-oauth-token', text: 'fixture' }
    await Promise.all([1, 2].map(n => service.addManagedAccount({ id: id(n), provider: 'antigravity' }, credential)))
    expect((await service.list()).accounts.map(account => account.displayName)).toEqual(['Antigravity', 'Antigravity 2'])
    await expect(service.addManagedAccount({ id: id(4), provider: 'antigravity' }, {
      ...credential, filename: '../antigravity-oauth-token'
    })).rejects.toThrow('Invalid credential file')
    const stored = join(userData, 'accounts', id(1), credential.filename)
    expect(await service.readCredential(stored)).toBe('fixture')
    await service.remove(id(1))
    expect(callback).toHaveBeenCalledOnce()
    expect(callbackSnapshot).toEqual({ hasAccount: false, credential: 'encrypted:fixture' })
    await expect(readFile(stored)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(external)
    await mkdir(join(userData, 'profiles'))
    await symlink(external, profile, 'junction')
    await expect(service.addManagedAccount({ id: id(3), provider: 'codex', dataDir: external })).rejects.toThrow('Invalid account directory')
    await expect(service.addManagedAccount({ id: id(3), provider: 'codex', dataDir: profile })).rejects.toThrow('Invalid account directory')
    await rm(profile)
    await mkdir(profile)
    const auth = join(profile, 'auth.json')
    await writeFile(auth, '{"tokens":{"access_token":"fixture"}}')
    const report = await service.addManagedAccount({ id: id(3), provider: 'codex', dataDir: profile })
    expect(report.accounts.find(account => account.id === id(3))?.hasCredential).toBe(true)
    await service.remove(id(3))
    await expect(readFile(auth)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('manual OpenCode keys stay out of config and renderer data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-accounts-key-'))
  try {
    await mkdir(join(home, 'app'))
    const service = createAccountService({
      userData: join(home, 'app'), pickDirectory: async () => undefined, pickCredential: async () => undefined,
      encrypt: text => Buffer.from(Buffer.from(text, 'utf8').map(byte => byte ^ 0x55)),
      decrypt: bytes => Buffer.from(bytes.map(byte => byte ^ 0x55)).toString('utf8'),
      discover: config => discoverAccounts(config, { home, env: {} })
    })
    const key = 'test-fixture-key'
    const view = await service.add({ provider: 'opencode', displayName: 'Go', mode: 'apiKey', apiKey: key })
    expect(JSON.stringify(view)).not.toContain(key)
    expect(await readFile(join(home, 'app', 'config.json'), 'utf8')).not.toContain(key)
    expect(await service.getManualApiKey((await service.listInternal())[0])).toBe(key)
    await service.add({ provider: 'opencode', displayName: 'OpenCode', mode: 'apiKey', apiKey: key })
    await Promise.all(['', '   '].map(displayName =>
      service.add({ provider: 'opencode', displayName, mode: 'apiKey', apiKey: key })))
    const names = (await service.list()).accounts.map(account => account.displayName)
    expect(names).toEqual(['Go', 'OpenCode', 'OpenCode 2', 'OpenCode 3'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

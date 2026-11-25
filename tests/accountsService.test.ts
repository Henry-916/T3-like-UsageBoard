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
      .toMatchObject({ displayName: '正在识别…', enabled: false })
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
    expect((await service.restoreHidden()).accounts[2].displayName).toBe('正在识别…')
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

test('managed accounts validate ownership, use canonical labels, and clean up after the removal callback', async () => {
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
    expect((await service.list()).accounts.map(account => account.displayName)).toEqual(['正在识别…', '正在识别…'])
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
    expect(names).toEqual(Array(4).fill('OpenCode Go'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('merges normalized manual and current identities while routing reads to the active slot and snapshots safely', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-accounts-current-'))
  try {
    const userData = join(home, 'app')
    const cli = (email: string, marker: string) => JSON.stringify({
      id_token_email: email, token: { access_token: marker, refresh_token: marker }
    })
    let current = Buffer.from(cli(' SAME@Example.COM ', 'active-fixture'))
    const service = createAccountService({
      userData, pickDirectory: async () => undefined, pickCredential: async () => undefined,
      encrypt: text => Buffer.from(`encrypted:${text}`),
      decrypt: bytes => bytes.toString().slice('encrypted:'.length),
      discover: config => discoverAccounts(config, { home, env: {} }),
      readAntigravityCredential: async () => ({ blob: current })
    })
    const id = 'manual-00000000-0000-0000-0000-000000000006'
    const filename = 'antigravity-oauth-token'
    const initial = await service.addManagedAccount({ id, provider: 'antigravity' }, { filename, text: cli('same@example.com', 'old-fixture') })
    expect(initial.accounts).toMatchObject([{ id, displayName: 'same@example.com', current: true }])
    expect(JSON.stringify(initial)).not.toContain('active-fixture')
    const [representative] = await service.listInternal()
    expect(representative.credentialSource?.currentCredential).toEqual(current)
    expect(representative.canSwitch).toBeUndefined()
    expect(await readFile(representative.credentialPath!, 'utf8')).toContain('old-fixture')
    await service.snapshotCurrentCredential('antigravity', current.toString())
    expect(await readFile(representative.credentialPath!, 'utf8')).toBe(`encrypted:${current.toString()}`)
    expect((await readConfig(userData)).accounts).toHaveLength(1)
    current = Buffer.from(cli('different@example.com', 'new-fixture'))
    expect((await service.list()).accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, canSwitch: true }),
      expect.objectContaining({ id: 'native:antigravity:credman', current: true, displayName: 'different@example.com' })
    ]))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('caches learned email across service restarts and reads nested Codex JWT email offline', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-accounts-identities-'))
  try {
    const dir = join(home, 'codex-override')
    await mkdir(dir)
    const jwt = Buffer.from(JSON.stringify({ 'https://api.openai.com/profile': { email: 'EXAMPLE@example.com' } })).toString('base64url')
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: `x.${jwt}.x`, access_token: 'fixture' } }))
    const options = {
      userData: join(home, 'app'), pickDirectory: async () => undefined, pickCredential: async () => undefined,
      encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString(),
      discover: (config: Parameters<typeof discoverAccounts>[0]) => discoverAccounts(config, { home, env: { CODEX_HOME: dir } })
    }
    const service = createAccountService(options)
    expect((await service.list()).accounts).toMatchObject([{ provider: 'codex', displayName: 'example@example.com', current: true }])
    const report = await service.addManagedAccount({ id: 'manual-00000000-0000-0000-0000-000000000007', provider: 'antigravity' },
      { filename: 'acp_token.json', text: '{"fixture":true}' })
    const id = report.accounts.find(account => account.provider === 'antigravity')!.id
    const account = (await service.listInternal()).find(account => account.id === id)!
    await service.recordIdentity(account)
    expect((await service.list()).accounts.find(account => account.id === id)?.displayName).toBe('未知账号')
    await service.recordIdentity(account, ' LEARNED@example.com ')
    expect((await createAccountService(options).list()).accounts.find(account => account.id === id)?.displayName).toBe('learned@example.com')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('encrypts new automatic Codex snapshots and updates existing managed profiles in place', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-codex-snapshot-'))
  try {
    const userData = join(home, 'app')
    const auth = (email: string, marker: string) => JSON.stringify({
      tokens: { access_token: marker, id_token: `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x` }
    })
    const service = createAccountService({
      userData, pickDirectory: async () => undefined, pickCredential: async () => undefined,
      encrypt: text => Buffer.from(Buffer.from(text).map(byte => byte ^ 0x55)),
      decrypt: bytes => Buffer.from(bytes.map(byte => byte ^ 0x55)).toString(),
      discover: config => discoverAccounts(config, { home, env: {} })
    })
    await service.snapshotCurrentCredential('codex', auth('auto@example.com', 'before-fixture'))
    await service.snapshotCurrentCredential('codex', auth('AUTO@example.com', 'rotated-fixture'))
    const [auto] = await service.listInternal()
    const encrypted = auto.switchSource?.credentialPaths?.[0]
    expect(encrypted).toBe(join(userData, 'accounts', auto.id, 'auth.json'))
    expect(auto.dataDir).toBeUndefined()
    expect(await service.readCredential(encrypted!)).toEqual(JSON.parse(auth('AUTO@example.com', 'rotated-fixture')))
    expect(await readFile(encrypted!, 'utf8')).not.toContain('rotated-fixture')
    const managed = 'manual-00000000-0000-0000-0000-000000000008'
    const profile = join(userData, 'profiles', managed)
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'auth.json'), auth('managed@example.com', 'original-fixture'))
    await service.addManagedAccount({ id: managed, provider: 'codex', dataDir: profile })
    await service.snapshotCurrentCredential('codex', auth('managed@example.com', 'updated-fixture'))
    expect(await readFile(join(profile, 'auth.json'), 'utf8')).toBe(auth('managed@example.com', 'updated-fixture'))
    expect((await readConfig(userData)).accounts).toHaveLength(2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

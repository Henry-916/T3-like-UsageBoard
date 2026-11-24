import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createAccountService } from '../src/main/accounts/service'
import { discoverAccounts } from '../src/main/accounts/discovery'

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
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

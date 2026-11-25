import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertSwitchPath, prepareAntigravitySwitch, prepareCodexSwitch, readSwitchTarget, runAccountSwitch } from '../src/main/accounts/switchAccount'
import type { WindowsCredential } from '../src/main/accounts/windowsCredentials'

const codex = (email: string) => Buffer.from(JSON.stringify({ tokens: {
  id_token: `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`,
  access_token: 'fixture'
} }))
const ag = (email: string) => Buffer.from(JSON.stringify({
  token: { access_token: 'fixture', refresh_token: 'fixture', expiry: '2030-01-01T00:00:00Z' },
  auth_method: 'consumer', id_token_email: email
}))
const originalEmail = 'first@example.com'
const expectedEmail = 'next@example.com'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'switch-fixture-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('account switch transaction', () => {
  it('snapshots the current account before applying and prunes only old Codex backups', async () => {
    const original = codex(originalEmail)
    const target = codex(expectedEmail)
    const file = join(root, 'auth.json')
    await writeFile(file, original)
    for (const stamp of ['2001', '2002', '2003']) await writeFile(`${file}.bak-usageboard-${stamp}`, original)
    await writeFile(`${file}.other`, original)
    await runAccountSwitch({
      provider: 'codex', target, expectedEmail,
      stop: async () => async () => { expect(await readFile(file)).toEqual(target) },
      prepare: bytes => prepareCodexSwitch(file, bytes),
      snapshot: async text => {
        expect(Buffer.from(text)).toEqual(original)
        expect(await readFile(file)).toEqual(original)
      }
    })
    expect(await readFile(file)).toEqual(target)
    expect((await readdir(root)).filter(name => name.startsWith('auth.json.bak-usageboard-'))).toHaveLength(3)
    expect(await readFile(`${file}.other`)).toEqual(original)
  })
  it('restores Codex before attempting to restart a second time', async () => {
    const original = codex(originalEmail)
    const file = join(root, 'auth.json')
    await writeFile(file, original)
    const restart = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('fixture')).mockResolvedValue(undefined)
    await expect(runAccountSwitch({
      provider: 'codex', target: codex(expectedEmail), expectedEmail, stop: async () => restart,
      prepare: bytes => prepareCodexSwitch(file, bytes), snapshot: async () => undefined
    })).rejects.toThrow('已恢复原账号')
    expect(await readFile(file)).toEqual(original)
    expect(restart).toHaveBeenCalledTimes(2)
  })
  it('restores Windows credentials and the project cache when Antigravity cannot relaunch', async () => {
    const original = { userName: 'antigravity', persist: 2, comment: 'fixture', blob: ag(originalEmail) }
    let value: WindowsCredential = original
    const cache = join(root, 'default_project_id.txt')
    await writeFile(cache, 'fixture-project')
    const restart = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('fixture')).mockResolvedValue(undefined)
    await expect(runAccountSwitch({
      provider: 'antigravity', target: ag(expectedEmail), expectedEmail, stop: async () => restart,
      prepare: bytes => prepareAntigravitySwitch(bytes, [cache], async () => value,
        async (expected, next) => {
          if (!value.blob.equals(expected)) return false
          value = { ...value, blob: next }
          return true
        },
        async restored => { value = restored }),
      snapshot: async () => undefined
    })).rejects.toThrow('已恢复原账号')
    expect(value).toEqual(original)
    expect(await readFile(cache, 'utf8')).toBe('fixture-project')
  })
  it('refuses a junction pointing into the protected T3 tree before writing', async () => {
    await mkdir(join(root, '.t3'))
    await symlink(join(root, '.t3'), join(root, 'alias'), 'junction')
    await expect(assertSwitchPath(join(root, 'alias', 'auth.json'), root)).rejects.toThrow('路径不安全')
  })
  it('uses an inactive account’s latest rotated token without rewriting its source file', async () => {
    const file = join(root, 'antigravity-oauth-token')
    const before = ag(expectedEmail)
    await writeFile(file, before)
    const target = await readSwitchTarget({
      id: 'manual-example', provider: 'antigravity', enabled: true, origin: 'manual',
      displayName: expectedEmail, credentialPaths: [file]
    }, async () => JSON.parse(before.toString()), {
      getEntry: async () => ({
        refreshToken: 'new-fixture', accessToken: 'new-access-fixture',
        expiry: '2027-01-01T00:00:00Z', updatedAt: Date.now()
      })
    })
    expect(JSON.parse(target.toString()).token.refresh_token).toBe('new-fixture')
    expect(await readFile(file)).toEqual(before)
  })
})

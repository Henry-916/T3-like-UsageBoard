import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { markWhatsNewSeen, readWhatsNewStatus } from '../src/main/configStore'
import { APP_VERSION } from '../src/shared/version'

const dirs: string[] = []
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usageboard-whatsnew-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('whats-new status', () => {
  it('silently marks a fresh install and never auto-opens the notice', async () => {
    const userData = await directory()
    expect(await readWhatsNewStatus(userData)).toEqual({ version: APP_VERSION, shouldShow: false })
    const config = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8'))
    expect(config.preferences.lastSeenVersion).toBe(APP_VERSION)
  })

  it('shows the notice for an existing configuration without a seen version', async () => {
    const userData = await directory()
    await writeFile(join(userData, 'config.json'), JSON.stringify({
      accounts: [{ id: 'a', provider: 'codex', displayName: 'Codex' }]
    }))
    expect(await readWhatsNewStatus(userData)).toEqual({ version: APP_VERSION, shouldShow: true })
    await markWhatsNewSeen(userData)
    expect(await readWhatsNewStatus(userData)).toEqual({ version: APP_VERSION, shouldShow: false })
  })

  it('shows the notice when the stored version is older', async () => {
    const userData = await directory()
    await writeFile(join(userData, 'config.json'), JSON.stringify({
      preferences: { lastSeenVersion: '0.5.3', window: '7d' }
    }))
    expect(await readWhatsNewStatus(userData)).toEqual({ version: APP_VERSION, shouldShow: true })
  })

  it('never overwrites an unreadable existing config', async () => {
    const userData = await directory()
    await writeFile(join(userData, 'config.json'), '{not json')
    expect(await readWhatsNewStatus(userData)).toEqual({ version: APP_VERSION, shouldShow: false })
    expect(await readFile(join(userData, 'config.json'), 'utf8')).toBe('{not json')
  })
})

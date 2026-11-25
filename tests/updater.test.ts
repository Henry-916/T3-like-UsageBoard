import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareSemver, createUpdater } from '../src/main/updater'

vi.mock('electron', () => ({ app: {}, shell: {} }))

const directories: string[] = []
const version = '0.4.0'
const filename = 'usage-dashboard-0.4.1-portable-x64.exe'
const releaseUrl = 'https://github.com/Henry-916/UsageDashboard/releases/tag/v0.4.1'
const assetUrl = `https://github.com/Henry-916/UsageDashboard/releases/download/v0.4.1/${filename}`
const cdnUrl = 'https://release-assets.githubusercontent.com/fixture'

function mockNsis() {
  const nsis = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => {
      nsis.emit('checking-for-update')
      nsis.emit('update-available', { version: '0.4.1' })
      return {}
    }),
    downloadUpdate: vi.fn(async () => {
      nsis.emit('download-progress', { percent: 41.8 })
      nsis.emit('update-downloaded', { version: '0.4.1', downloadedFile: 'fixture.exe' })
    }),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    netSession: { webRequest: { onBeforeRequest: vi.fn<(fn: (details: { url: string }, reply: (result: { cancel: boolean }) => void) => void) => void>() } }
  })
  return { nsis, autoUpdater: nsis as unknown as AppUpdater }
}

const mockApp = (downloads = '', isPackaged = true) => ({
  isPackaged, getVersion: () => version, getPath: () => downloads
})

async function portable(options: { override?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'usage-updater-test-'))
  directories.push(directory)
  const fetch = vi.fn<typeof globalThis.fetch>()
  const shell = { openExternal: vi.fn(async () => {}), showItemInFolder: vi.fn() }
  const onStateChanged = vi.fn()
  const updater = createUpdater({
    app: mockApp(directory),
    shell,
    fetch,
    onStateChanged,
    resourcesPath: directory,
    env: { PORTABLE_EXECUTABLE_FILE: 'fixture.exe', USAGE_DASHBOARD_UPDATE_URL: options.override }
  })
  return { directory, fetch, shell, onStateChanged, updater }
}

function release(assets = [{ name: filename, browser_download_url: assetUrl, size: 4 }]) {
  return Response.json({ tag_name: 'v0.4.1', html_url: releaseUrl, assets })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('compareSemver', () => {
  it('orders core and prerelease components, ignoring build metadata', () => {
    expect(compareSemver('v1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', 'v1.0.0-rc.10')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.beta')).toBeLessThan(0)
    expect(compareSemver('v1.0.0+a', '1.0.0+b')).toBe(0)
    expect(() => compareSemver('1.0.0-01', '1.0.0')).toThrow()
    expect(() => compareSemver('1.01.0', '1.0.0')).toThrow()
    expect(() => compareSemver('1.0.0\n', '1.0.0')).toThrow()
  })
})

describe('NSIS updates', () => {
  it('does not automatically download and prepares to quit before installing', async () => {
    const { nsis, autoUpdater } = mockNsis()
    const onStateChanged = vi.fn()
    const prepareQuitForUpdate = vi.fn(async () => { expect(nsis.quitAndInstall).not.toHaveBeenCalled() })
    const updater = createUpdater({ app: mockApp(), env: {}, autoUpdater, onStateChanged, prepareQuitForUpdate })
    expect(await updater.checkForUpdates()).toMatchObject({ mode: 'nsis', status: 'available', latestVersion: '0.4.1' })
    expect(autoUpdater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: true, allowDowngrade: false })
    expect(nsis.downloadUpdate).not.toHaveBeenCalled()
    expect(await updater.downloadUpdate()).toMatchObject({ status: 'downloaded', downloadPercent: 100 })
    expect(onStateChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading', downloadPercent: 42 }))
    await updater.installUpdate()
    expect(prepareQuitForUpdate).toHaveBeenCalledOnce()
    expect(nsis.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it.each([
    [new Error('404 Not Found'), 'up-to-date', '暂未检测到已发布的新版本'],
    [new Error('No published versions'), 'up-to-date', '暂未检测到已发布的新版本'],
    [new Error('network timeout'), 'error', '检查更新失败，请检查网络后重试']
  ])('silences scheduled failures and reports manual checks (%s)', async (error, status, message) => {
    vi.useFakeTimers()
    const { nsis, autoUpdater } = mockNsis()
    nsis.checkForUpdates.mockImplementation(async () => {
      nsis.emit('error', error)
      throw error
    })
    const updater = createUpdater({ app: mockApp(), env: {}, autoUpdater })
    updater.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(nsis.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(nsis.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.getState().status).toBe('idle')
    expect(await updater.checkForUpdates()).toMatchObject({ status, message })
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    expect(nsis.checkForUpdates).toHaveBeenCalledTimes(3)
    expect(updater.getState().status).toBe('idle')
    updater.stop()
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    expect(nsis.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('only permits a loopback HTTP override for development checks', async () => {
    const { nsis, autoUpdater } = mockNsis()
    const create = (url: string) => createUpdater({
      app: mockApp('', false), autoUpdater, env: { USAGE_DASHBOARD_UPDATE_URL: url }
    })
    const development = create('http://127.0.0.1.example.com/feed/')
    expect(await development.checkForUpdates()).toMatchObject({ mode: 'development', status: 'idle' })
    expect(nsis.setFeedURL).not.toHaveBeenCalled()
    expect(await create('http://127.0.0.1:9876/feed/').checkForUpdates()).toMatchObject({ status: 'available' })
    expect(nsis.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:9876/feed/' })
    const [guard] = nsis.netSession.webRequest.onBeforeRequest.mock.calls[0]
    const reply = vi.fn()
    guard({ url: 'http://127.0.0.1:9876/setup.exe' }, reply)
    guard({ url: 'https://github.com/setup.exe' }, reply)
    expect(reply.mock.calls).toEqual([[{ cancel: false }], [{ cancel: true }]])
  })
})

describe('portable updates', () => {
  it('reads packaged repository metadata, writes a verified stream and only reveals the result', async () => {
    const { directory, fetch, shell, onStateChanged, updater } = await portable()
    await writeFile(join(directory, 'app-update.yml'), 'provider: github\nowner: fixture-owner\nrepo: fixture-repo\n')
    fetch.mockResolvedValueOnce(release())
      .mockResolvedValueOnce(Response.redirect(cdnUrl))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(Uint8Array.from([1, 2]))
          stream.enqueue(Uint8Array.from([3, 4]))
          stream.close()
        }
      })))
    expect(await updater.checkForUpdates()).toMatchObject({ mode: 'portable', status: 'available', releaseUrl })
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.github.com/repos/fixture-owner/fixture-repo/releases/latest')
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
    const target = join(directory, filename)
    expect(await updater.downloadUpdate()).toMatchObject({ status: 'downloaded', downloadedFile: target, downloadPercent: 100 })
    expect(String(fetch.mock.calls[2][0])).toBe(cdnUrl)
    expect(fetch.mock.calls[2][1]).toMatchObject({ redirect: 'manual' })
    expect(onStateChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading', downloadPercent: 50 }))
    expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(await readdir(directory)).not.toContain(`${filename}.part`)
    await updater.installUpdate()
    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).toHaveBeenCalledWith(target)
  })

  it('falls back to the release page without fetching unsafe assets', async () => {
    const { fetch, shell, updater } = await portable()
    fetch.mockResolvedValueOnce(release([
      { name: filename, browser_download_url: 'http://github.com/fixture', size: 4 },
      { name: filename, browser_download_url: 'https://github.com.example.com/fixture', size: 4 },
      { name: `../${filename}`, browser_download_url: assetUrl, size: 4 },
      { name: `${filename}\n`, browser_download_url: assetUrl, size: 4 },
      { name: filename, browser_download_url: assetUrl, size: -1 }
    ]))
    await updater.checkForUpdates()
    await updater.downloadUpdate()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).toHaveBeenCalledWith(releaseUrl)
  })

  it('rejects unsafe redirect destinations before fetching', async () => {
    const { directory, fetch, updater } = await portable()
    fetch.mockResolvedValueOnce(release()).mockResolvedValueOnce(Response.redirect('https://untrusted.example/update.exe'))
    await updater.checkForUpdates()
    expect(await updater.downloadUpdate()).toMatchObject({ status: 'error' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await readdir(directory)).toEqual([])
  })

  it.each(['123', '12345'])('cleans the partial file when the number of bytes differs (%s)', async body => {
    const { directory, fetch, updater } = await portable()
    fetch.mockResolvedValueOnce(release())
      .mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(new Response('1234'))
    await updater.checkForUpdates()
    expect(await updater.downloadUpdate()).toMatchObject({ status: 'error' })
    expect(await readdir(directory)).toEqual([])
    const target = join(directory, filename)
    expect(await updater.downloadUpdate()).toMatchObject({ status: 'downloaded', downloadedFile: target })
    expect(await readFile(target, 'utf8')).toBe('1234')
    expect(await readdir(directory)).toEqual([filename])
  })

  it('leaves a partial file it did not create untouched', async () => {
    const { directory, fetch, updater } = await portable()
    const partial = join(directory, `${filename}.part`)
    await writeFile(partial, 'existing')
    fetch.mockResolvedValueOnce(release()).mockResolvedValueOnce(new Response('1234'))
    await updater.checkForUpdates()
    expect(await updater.downloadUpdate()).toMatchObject({ status: 'error' })
    expect(await readFile(partial, 'utf8')).toBe('existing')
  })

  it('does not allow a loopback fixture to redirect outside its origin', async () => {
    const origin = 'http://127.0.0.1:9876'
    const { fetch, updater } = await portable({ override: `${origin}/latest` })
    fetch.mockResolvedValueOnce(release([{ name: filename, browser_download_url: `${origin}/asset`, size: 4 }]))
      .mockResolvedValueOnce(Response.redirect('http://127.0.0.1:9877/asset'))
    await updater.checkForUpdates()
    expect(String(fetch.mock.calls[0][0])).toBe(`${origin}/latest`)
    expect(await updater.downloadUpdate()).toMatchObject({ status: 'error' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

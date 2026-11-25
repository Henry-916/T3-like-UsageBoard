import { open, readFile, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { app, shell } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { UpdateState, UpdateStatus } from '../shared/updateTypes'

interface UpdaterOptions {
  prepareQuitForUpdate?: () => Promise<void> | void
  onStateChanged?: (state: UpdateState) => void
  app?: Pick<typeof app, 'isPackaged' | 'getVersion' | 'getPath'>
  shell?: Pick<typeof shell, 'openExternal' | 'showItemInFolder'>
  autoUpdater?: AppUpdater
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
}

const releaseHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const loopbackHosts = new Set(['127.0.0.1', '[::1]'])
const semver = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(version: string) {
  const match = semver.exec(version)
  const pre = match?.[4]?.split('.') ?? []
  if (!match || match[0] !== version || pre.some(part => /^0\d+$/.test(part))) throw new Error('Invalid version')
  return { core: match.slice(1, 4).map(BigInt), pre }
}

export function compareSemver(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  const cmp = (x: bigint | string, y: typeof x) => x === y ? 0 : x < y ? -1 : 1
  for (let i = 0; i < 3; i++) {
    const order = cmp(a.core[i], b.core[i])
    if (order) return order
  }
  if (!a.pre.length || !b.pre.length) return cmp(BigInt(b.pre.length), BigInt(a.pre.length))
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    const order = nx && ny ? cmp(BigInt(x), BigInt(y)) : nx !== ny ? (nx ? -1 : 1) : cmp(x, y)
    if (order) return order
  }
  return cmp(BigInt(a.pre.length), BigInt(b.pre.length))
}

function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return url
  } catch { /* invalid URL */ }
}

function mockUrl(value: unknown): URL | undefined {
  const url = parseUrl(value)
  if (url?.protocol === 'http:' && loopbackHosts.has(url.hostname)) return url
}

function trustedUrl(value: unknown, mock?: URL, page = false): URL | undefined {
  const url = parseUrl(value)
  if (!url) return
  if (mock) return url.origin === mock.origin ? url : undefined
  if (url.protocol === 'https:' && !url.port && (page ? url.hostname === 'github.com' : releaseHosts.has(url.hostname))) return url
}

interface PortableAsset {
  name: string
  url: URL
  size: number
}

function portableAsset(value: unknown, mock?: URL): PortableAsset | undefined {
  if (!value || typeof value !== 'object') return
  const { name, browser_download_url, size } = value as Record<string, unknown>
  if (typeof name !== 'string' || name.length > 200 || !/^[a-z0-9]/i.test(name) || /[^a-z0-9._-]/i.test(name)
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name) || !/portable.*x64\.exe$/i.test(name)
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return
  const url = trustedUrl(browser_download_url, mock)
  if (url) return { name, url, size }
}

const noRelease = '暂未检测到已发布的新版本'
const checkFailed = '检查更新失败，请检查网络后重试'
const downloadFailed = '下载更新失败，请重试'

async function loadElectronUpdater() {
  // Node exposes the entire CommonJS exports object as `default`; its named
  // namespace does not reliably expose the computed autoUpdater accessor.
  const module = await import('electron-updater') as unknown as { default: typeof import('electron-updater') }
  return module.default
}

function isMissingRelease(error: unknown): boolean {
  return error instanceof Error && (
    ('statusCode' in error && error.statusCode === 404)
    || ('code' in error && error.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')
    || /\b404\b|no published versions/i.test(error.message)
  )
}

export function createUpdater(options: UpdaterOptions = {}) {
  const application = options.app ?? app
  const desktop = options.shell ?? shell
  const fetchUrl = options.fetch ?? fetch
  const env = options.env ?? process.env
  const override = mockUrl(env.USAGE_DASHBOARD_UPDATE_URL)
  const mode = !application.isPackaged ? 'development' : env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis'
  const currentVersion = application.getVersion()
  const base = { mode, currentVersion } as const
  let state: UpdateState = { ...base, status: 'idle' }
  let asset: PortableAsset | undefined
  let firstCheck: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let nsis: AppUpdater | undefined
  let check: Promise<UpdateState> | undefined
  let download: Promise<UpdateState> | undefined
  let install: Promise<void> | undefined
  let silentCheck = false
  let stopped = false
  let activeFetch: AbortController | undefined
  let cancelNsisDownload: (() => void) | undefined

  function setState(status: UpdateStatus, details: Partial<UpdateState> = {}): UpdateState {
    if (!stopped) {
      state = { ...details, ...base, status }
      options.onStateChanged?.({ ...state })
    }
    return { ...state }
  }

  function checkError(error: unknown) {
    if (silentCheck) return setState('idle')
    return isMissingRelease(error)
      ? setState('up-to-date', { message: noRelease })
      : setState('error', { message: checkFailed })
  }

  async function nsisUpdater() {
    if (nsis) return nsis
    const updater = options.autoUpdater ?? (await loadElectronUpdater()).autoUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowDowngrade = false
    if (override) {
      // The updater has a dedicated Electron session. Constrain metadata,
      // blockmap and installer requests, including URLs supplied by the feed.
      updater.netSession.webRequest.onBeforeRequest(({ url }, reply) => {
        reply({ cancel: !trustedUrl(url, override) })
      })
      updater.setFeedURL({ provider: 'generic', url: override.href })
      if (mode === 'development') updater.forceDevUpdateConfig = true
    }
    updater.on('checking-for-update', () => {
      if (state.status !== 'checking') setState('checking')
    })
    updater.on('update-available', info => setState('available', { latestVersion: info.version }))
    updater.on('update-not-available', () => setState('up-to-date'))
    updater.on('download-progress', progress => {
      if (state.status === 'downloading') {
        setState('downloading', { ...state, downloadPercent: Math.min(100, Math.max(0, Math.round(progress.percent))) })
      }
    })
    updater.on('update-downloaded', info => setState('downloaded', {
      latestVersion: info.version, downloadPercent: 100, downloadedFile: info.downloadedFile
    }))
    // The check/download promises also reject on an error. Subscribe to cover
    // errors emitted later by quitAndInstall, without duplicating state changes.
    updater.on('error', () => {
      if (!check && !download) setState('error', { message: '安装更新失败，请重试' })
    })
    nsis = updater
    return updater
  }

  async function releaseApi(): Promise<URL> {
    if (override) return override
    let config = ''
    try {
      config = await readFile(join(options.resourcesPath ?? process.resourcesPath, 'app-update.yml'), 'utf8')
    } catch { /* use the default repository without packaged metadata */ }
    const owner = /^owner:[ \t]*['"]?([A-Za-z0-9-]+)['"]?[ \t]*\r?$/m.exec(config)?.[1] ?? 'Henry-916'
    const repo = /^repo:[ \t]*['"]?([A-Za-z0-9_.-]+)['"]?[ \t]*\r?$/m.exec(config)?.[1] ?? 'UsageDashboard'
    return new URL(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
  }

  async function checkPortable() {
    const controller = activeFetch = new AbortController()
    try {
      const response = await fetchUrl(await releaseApi(), {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `UsageDashboard/${currentVersion}` },
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
      })
      if (!response.ok) throw Object.assign(new Error('Release request failed'), { statusCode: response.status })
      const release = await response.json()
      const version = release.tag_name
      if (typeof version !== 'string') throw new Error('Missing release version')
      if (release.draft || compareSemver(version, currentVersion) <= 0) return setState('up-to-date')
      asset = Array.isArray(release.assets)
        ? release.assets.map((candidate: unknown) => portableAsset(candidate, override)).find(Boolean)
        : undefined
      return setState('available', {
        latestVersion: version.replace(/^v/, ''),
        releaseUrl: trustedUrl(release.html_url, override, true)?.href
      })
    } finally {
      activeFetch = undefined
    }
  }

  function checkForUpdates(silent = false): Promise<UpdateState> {
    if (check) {
      if (!silent) silentCheck = false
      return check
    }
    if (stopped || download || state.status === 'downloaded' || (silent && state.status === 'available')) {
      return Promise.resolve({ ...state })
    }
    if (mode === 'development' && !override) {
      return Promise.resolve(silent ? { ...state } : setState('idle', { message: '当前为开发模式，请使用打包版本检查更新' }))
    }
    silentCheck = silent
    check = Promise.resolve().then(async () => {
      if (stopped) return { ...state }
      asset = undefined
      setState('checking')
      try {
        if (mode === 'portable') return await checkPortable()
        const updater = await nsisUpdater()
        if (!stopped && !await updater.checkForUpdates() && state.status === 'checking') return setState('idle')
        return { ...state }
      } catch (error) {
        return checkError(error)
      }
    }).finally(() => { check = undefined })
    return check
  }

  async function portableResponse(url: URL, signal: AbortSignal): Promise<Response> {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetchUrl(url, { redirect: 'manual', signal })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      await response.body?.cancel()
      const location = response.headers.get('location')
      const next = location && !/[\s\\]/.test(location) && trustedUrl(new URL(location, url).href, override)
      if (!next) throw new Error('Untrusted release asset redirect')
      url = next
    }
    throw new Error('Too many release asset redirects')
  }

  async function downloadPortable(selected: PortableAsset, available: UpdateState) {
    const controller = activeFetch = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)])
    const filename = join(application.getPath('downloads'), selected.name)
    const partial = `${filename}.part`
    let handle: FileHandle | undefined
    let renamed = false
    let written = 0
    try {
      const response = await portableResponse(selected.url, signal)
      if (!response.ok || !response.body) throw new Error('Asset request failed')
      handle = await open(partial, 'wx')
      const reader = response.body.getReader()
      async function* chunks() {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            written += value.byteLength
            if (written > selected.size) throw new Error('Asset size mismatch')
            const percent = Math.min(99, Math.floor(100 * written / selected.size))
            if (percent !== state.downloadPercent) setState('downloading', { ...available, downloadPercent: percent })
            yield value
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
      }
      await pipeline(chunks(), handle.createWriteStream(), { signal })
      await handle.close()
      signal.throwIfAborted()
      if (written !== selected.size) throw new Error('Asset size mismatch')
      await rename(partial, filename)
      renamed = true
      return setState('downloaded', { ...available, downloadPercent: 100, downloadedFile: filename })
    } finally {
      controller.abort()
      activeFetch = undefined
      if (handle && !renamed) {
        await handle.close().catch(() => {})
        // Keep removal non-recursive; fs.rm's built-in retries only apply to recursive removal.
        for (let attempt = 0; ; attempt++) {
          try {
            await rm(partial, { force: true })
            break
          } catch (error) {
            if (attempt === 5 || !['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
            await delay(50)
          }
        }
      }
    }
  }

  function downloadUpdate(): Promise<UpdateState> {
    if (download) return download
    const retryPortable = mode === 'portable' && asset && state.status === 'error' && state.message === downloadFailed
    if (stopped || (state.status !== 'available' && !retryPortable)) return Promise.resolve({ ...state })
    const available: UpdateState = { ...state, status: 'available', message: undefined }
    download = Promise.resolve().then(async () => {
      if (stopped) return { ...state }
      try {
        if (mode === 'portable' && !asset) {
          if (!available.releaseUrl) throw new Error('Missing release URL')
          await desktop.openExternal(available.releaseUrl)
          return { ...state }
        }
        setState('downloading', { ...available, downloadPercent: 0 })
        if (asset && mode === 'portable') return await downloadPortable(asset, available)
        const updater = await nsisUpdater()
        const { CancellationToken } = await loadElectronUpdater()
        const token = new CancellationToken()
        cancelNsisDownload = () => token.cancel()
        if (!stopped) await updater.downloadUpdate(token)
        return { ...state }
      } catch {
        return setState('error', { ...available, message: downloadFailed })
      }
    }).finally(() => { download = undefined; cancelNsisDownload = undefined })
    return download
  }

  function installUpdate(): Promise<void> {
    if (install) return install
    if (stopped) return Promise.resolve()
    const ready = { ...state }
    install = Promise.resolve().then(async () => {
      if (mode === 'portable') {
        if (ready.status === 'downloaded' && ready.downloadedFile) desktop.showItemInFolder(ready.downloadedFile)
        else if (ready.status === 'available' && ready.releaseUrl) await desktop.openExternal(ready.releaseUrl)
      } else if (ready.status === 'downloaded' && nsis) {
        const updater = nsis
        await options.prepareQuitForUpdate?.()
        await new Promise<void>((resolve, reject) => setImmediate(() => {
          try {
            updater.quitAndInstall(false, true)
            resolve()
          } catch (error) {
            reject(error)
          }
        }))
      }
    }).catch(() => { setState('error', { message: '安装更新失败，请重试' }) })
      .finally(() => { install = undefined })
    return install
  }

  function start() {
    if (firstCheck || poll || mode === 'development') return
    stopped = false
    firstCheck = setTimeout(() => {
      firstCheck = undefined
      void checkForUpdates(true)
    }, 10_000)
    poll = setInterval(() => { void checkForUpdates(true) }, 4 * 60 * 60_000)
  }

  function stop() {
    stopped = true
    clearTimeout(firstCheck)
    clearInterval(poll)
    firstCheck = poll = undefined
    activeFetch?.abort()
    cancelNsisDownload?.()
  }

  return { getState: () => ({ ...state }), checkForUpdates, downloadUpdate, installUpdate, start, stop }
}

export type Updater = ReturnType<typeof createUpdater>

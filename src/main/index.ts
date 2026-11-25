import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import type { Tray } from 'electron'
import trayIconPath from '../../resources/tray-icon.ico?asset'
import { usageChannels } from '../shared/ipc'
import { registerIpc } from './ipc'
import { createTray } from './tray'
import { createUsageClient } from './usage/client'
import { createAccountService } from './accounts/service'
import { createAccountLoginManager } from './accounts/loginManager'
import { validateExternalUrl } from './accounts/externalUrl'
import { createUpdater } from './updater'
import { createLimitsService } from './limits/service'
import { createAntigravityProbe, waitForAntigravityRenewals } from './limits/probes/antigravity'
import { antigravityTokenKey, createAntigravityTokenCache } from './limits/antigravityTokenCache'
import { readConfig } from './configStore'
import { probeClaude } from './limits/probes/claude'
import { probeCodex } from './limits/probes/codex'
import { createCodexResetCreditConsumer } from './limits/codexResetCredit'
import { probeOpenCode } from './limits/probes/opencode'

let panel: BrowserWindow | undefined
let tray: (Tray & { refreshMenu(): void }) | undefined
let quitting = false

function showPanel(): void {
  if (!panel) return
  if (panel.isMinimized()) panel.restore()
  panel.show()
  panel.focus()
}

function createPanel(): void {
  const window = new BrowserWindow({
    title: 'UsageDashboard',
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    icon: trayIconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  panel = window
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => { panel = undefined })
  const sendMaximized = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(usageChannels.maximizedChanged, window.isMaximized() || window.isFullScreen())
  }
  window.on('maximize', sendMaximized)
  window.on('unmaximize', sendMaximized)
  window.on('enter-full-screen', sendMaximized)
  window.on('leave-full-screen', sendMaximized)
  if (!process.argv.includes('--auto-launch')) window.once('ready-to-show', showPanel)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())

  const devUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  const load = devUrl ? window.loadURL(devUrl) : window.loadFile(join(__dirname, '../renderer/index.html'))
  void load.catch(() => {
    console.error('Failed to load the UsageDashboard window.')
    app.exit(1)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId('com.usage-dashboard.app')
  app.on('second-instance', showPanel)
  app.on('activate', showPanel)
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => tray?.destroy())
  void app.whenReady().then(async () => {
    const fallbackRates = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'fallback-rates.json')
    const userData = app.getPath('userData')
    await mkdir(userData, { recursive: true })
    const usage = createUsageClient(userData, fallbackRates)
    const encrypt = async (text: string) => {
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Credential encryption is unavailable')
      return safeStorage.encryptStringAsync(text)
    }
    const decrypt = async (bytes: Buffer) => (await safeStorage.decryptStringAsync(bytes)).result
    const tokenCache = createAntigravityTokenCache({ userData, encrypt, decrypt })
    async function openExternal(url: string): Promise<void> {
      try { await shell.openExternal(validateExternalUrl(url).toString()) }
      catch { throw new Error('无法打开此链接。') }
    }
    const accounts = createAccountService({
      userData,
      async pickDirectory() {
        if (!panel) return undefined
        const result = await dialog.showOpenDialog(panel, { title: '选择数据目录', properties: ['openDirectory'] })
        return result.canceled ? undefined : result.filePaths[0]
      },
      async pickCredential() {
        if (!panel) return undefined
        const result = await dialog.showOpenDialog(panel, { title: '选择 Antigravity 凭证文件', properties: ['openFile'] })
        return result.canceled ? undefined : result.filePaths[0]
      },
      encrypt,
      decrypt,
      async onAccountRemoved(account): Promise<void> {
        if (account.provider !== 'antigravity' || !account.credentialPath) return
        const stored = await accounts.readCredential(account.credentialPath).catch(() => undefined) as
          { token?: { refresh_token?: unknown } } | undefined
        const refreshToken = stored?.token?.refresh_token
        if (typeof refreshToken === 'string' && refreshToken.trim()) {
          await tokenCache.invalidate(await antigravityTokenKey(account.credentialPath, refreshToken.trim()))
        }
      }
    })
    const antigravity = createAntigravityProbe({
      tokenCache,
      getScanT3: async () => (await readConfig(userData)).scanT3
    })
    const limits = createLimitsService({
      userData,
      consumeCodexCredit: createCodexResetCreditConsumer(),
      discover: accounts.listInternal,
      readCredential: accounts.readCredential,
      getManualApiKey: accounts.getManualApiKey,
      probes: { antigravity, opencode: probeOpenCode, codex: probeCodex, claude: probeClaude },
      onUpdate: (report) => {
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send(usageChannels.limitsUpdated, report)
      }
    })
    const login = createAccountLoginManager({
      userData,
      getScanT3: async () => (await readConfig(userData)).scanT3,
      openExternal,
      onUpdate: state => {
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send(usageChannels.accountLoginUpdated, state)
      },
      async commitAccount(account, credential) {
        const result = await accounts.addManagedAccount(account, credential)
        limits.accountsChanged(result.accounts)
      }
    })
    app.on('will-quit', usage.stop)
    let cleanup: Promise<void> | undefined
    let cleaned = false
    function prepareQuitForUpdate(): Promise<void> {
      quitting = true
      limits.stop()
      cleanup ??= Promise.allSettled([login.stop(), waitForAntigravityRenewals()]).then(() => {
        cleaned = true
        if (tray && !tray.isDestroyed()) tray.destroy()
        tray = undefined
      })
      return cleanup
    }
    const updater = createUpdater({
      prepareQuitForUpdate,
      onStateChanged: state => {
        tray?.refreshMenu()
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send(usageChannels.updateStateChanged, state)
      }
    })
    app.on('before-quit', event => {
      if (cleaned) return
      event.preventDefault()
      if (cleanup) return
      void prepareQuitForUpdate().then(() => app.quit())
    })
    app.on('will-quit', updater.stop)
    registerIpc(() => panel, userData, usage.getSummary, accounts, limits, login, updater, openExternal)
    createPanel()
    tray = createTray(trayIconPath, userData, {
      show: showPanel,
      toggle: () => {
        if (panel?.isVisible() && !panel.isMinimized()) panel.hide()
        else showPanel()
      },
      refresh: () => {
        panel?.webContents.send(usageChannels.refreshRequested)
        void limits.refresh()
      },
      updateState: updater.getState,
      update: () => {
        const { status } = updater.getState()
        if (status === 'available') void updater.downloadUpdate().catch(() => undefined)
        else if (status === 'downloaded') void updater.installUpdate().catch(() => undefined)
        else {
          showPanel()
          void updater.checkForUpdates().catch(() => undefined)
        }
      }
    })
    limits.start()
    updater.start()
  }).catch(() => {
    console.error('Failed to initialize UsageDashboard.')
    app.exit(1)
  })
}

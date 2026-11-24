import { join } from 'node:path'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import type { Tray } from 'electron'
import trayIconPath from '../../resources/tray-icon.ico?asset'
import { usageChannels } from '../shared/ipc'
import { registerIpc } from './ipc'
import { createTray } from './tray'
import { createUsageClient } from './usage/client'
import { createAccountService } from './accounts/service'
import { createLimitsService } from './limits/service'
import { probeAntigravity } from './limits/probes/antigravity'
import { probeClaude } from './limits/probes/claude'
import { probeCodex } from './limits/probes/codex'
import { probeOpenCode } from './limits/probes/opencode'

let panel: BrowserWindow | undefined
let tray: Tray | undefined
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
    backgroundColor: '#09090b',
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
  void app.whenReady().then(() => {
    const fallbackRates = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'fallback-rates.json')
    const userData = app.getPath('userData')
    const usage = createUsageClient(userData, fallbackRates)
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
      encrypt: async text => {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Credential encryption is unavailable')
        return safeStorage.encryptStringAsync(text)
      },
      decrypt: async bytes => (await safeStorage.decryptStringAsync(bytes)).result
    })
    const limits = createLimitsService({
      discover: accounts.listInternal,
      readCredential: accounts.readCredential,
      getManualApiKey: accounts.getManualApiKey,
      probes: { antigravity: probeAntigravity, opencode: probeOpenCode, codex: probeCodex, claude: probeClaude },
      onUpdate: (report) => {
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send(usageChannels.limitsUpdated, report)
      }
    })
    app.on('will-quit', usage.stop)
    app.on('will-quit', limits.stop)
    registerIpc(() => panel, userData, usage.getSummary, accounts, limits)
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
      }
    })
    limits.start()
  }).catch((error: unknown) => {
    console.error('Failed to initialize UsageDashboard:', error)
    app.exit(1)
  })
}

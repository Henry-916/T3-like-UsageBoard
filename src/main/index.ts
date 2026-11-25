import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
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
import { migrateUserData } from './userDataMigration'
import { createTrayPanel } from './trayPanel'
import { readAntigravityCredential, writeAntigravityCredential, compareAndWriteAntigravityCredential } from './accounts/windowsCredentials'
import { stopAntigravityForSwitch, stopCodexForSwitch } from './accounts/windowsSwitchProcesses'
import { assertSwitchPath, prepareAntigravitySwitch, prepareCodexSwitch, readSwitchTarget, runAccountSwitch, SwitchRollbackError } from './accounts/switchAccount'

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
    title: 'T3-like UsageBoard',
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
    console.error('T3-like UsageBoard: failed to load the window.')
    app.exit(1)
  })
}

const appData = app.getPath('appData')
const userData = join(appData, 't3-like-usageboard')
mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)

function migrateBeforeReady(): boolean {
  try { migrateUserData(join(appData, 'usage-dashboard'), userData); return true } catch {
    console.error('T3-like UsageBoard: could not migrate the existing user data.')
    return false
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else if (!migrateBeforeReady()) {
  app.exit(1)
} else {
  app.setAppUserModelId('com.t3-like-usageboard.app')
  app.on('second-instance', showPanel)
  app.on('activate', showPanel)
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => tray?.destroy())
  void app.whenReady().then(async () => {
    const fallbackRates = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'fallback-rates.json')
    const trayPanel = createTrayPanel({ iconPath: trayIconPath, showMain: showPanel,
      rendererUrl: !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined })
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
      readAntigravityCredential,
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
      getScanT3: async () => (await readConfig(userData)).scanT3,
      readCurrentCredential: readAntigravityCredential,
      compareAndWriteCurrentCredential: compareAndWriteAntigravityCredential
    })
    const limits = createLimitsService({
      userData,
      consumeCodexCredit: createCodexResetCreditConsumer(),
      discover: accounts.listInternal,
      recordIdentity: accounts.recordIdentity,
      readCredential: accounts.readCredential,
      getManualApiKey: accounts.getManualApiKey,
      probes: { antigravity, opencode: probeOpenCode, codex: probeCodex, claude: probeClaude },
      onUpdate: (report) => {
        if (panel && !panel.webContents.isDestroyed()) panel.webContents.send(usageChannels.limitsUpdated, report)
        trayPanel.send(usageChannels.limitsUpdated, report)
      }
    })
    let activeSwitch: Promise<Awaited<ReturnType<typeof accounts.list>>> | undefined
    let rollbackFailure: SwitchRollbackError | undefined
    function switchAccount(id: string) {
      if (rollbackFailure) throw rollbackFailure
      if (process.platform !== 'win32' || quitting) throw new Error('当前无法切换账号。')
      if (activeSwitch) throw new Error('正在切换账号，请稍候。')
      const operation = limits.exclusiveSwitch(async () => {
        const selected = (await accounts.listInternal()).find(item => item.id === id)
        const source = selected?.switchSource
        const provider = selected?.provider
        if (!source || !selected?.email || selected.current || (provider !== 'codex' && provider !== 'antigravity')) {
          throw new Error('目标账号或凭证不可用，请刷新后重试。')
        }
        const target = await readSwitchTarget(source, accounts.readCredential, tokenCache)
          .catch(() => { throw new Error('无法读取目标账号凭证。') })
        const codexFile = join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'auth.json')
        const cacheFiles = ['antigravity-cli', 'antigravity'].map(dir => join(homedir(), '.gemini', dir, 'cache', 'default_project_id.txt'))
        try {
          await Promise.all((provider === 'codex' ? [codexFile, dirname(codexFile)] : cacheFiles).map(path => assertSwitchPath(path)))
        } catch { throw new Error('默认凭证或项目缓存路径不安全，未切换。') }
        await runAccountSwitch({
          provider, target, expectedEmail: selected.email,
          stop: provider === 'codex' ? stopCodexForSwitch : stopAntigravityForSwitch,
          prepare: bytes => provider === 'codex' ? prepareCodexSwitch(codexFile, bytes)
            : prepareAntigravitySwitch(bytes, cacheFiles, readAntigravityCredential,
              compareAndWriteAntigravityCredential, writeAntigravityCredential),
          snapshot: text => accounts.snapshotCurrentCredential(provider, text)
        }).catch(error => {
          if (error instanceof SwitchRollbackError) {
            rollbackFailure = error
            limits.stop()
          }
          throw error
        })
        const result = await accounts.list()
        limits.accountsChanged(result.accounts)
        return result
      })
      activeSwitch = operation
      void operation.finally(() => { activeSwitch = undefined }).catch(() => undefined)
      return operation
    }
    const login = createAccountLoginManager({
      userData,
      getScanT3: async () => (await readConfig(userData)).scanT3,
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
      trayPanel.hide()
      cleanup ??= Promise.allSettled([login.stop(), waitForAntigravityRenewals(), activeSwitch]).then(() => {
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
    registerIpc(() => panel, userData, usage.getSummary, accounts, limits, login, updater, openExternal, trayPanel, switchAccount)
    createPanel()
    tray = createTray(trayIconPath, userData, {
      show: trayPanel.openMain,
      togglePanel: trayPanel.toggle,
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
    console.error('T3-like UsageBoard: failed to initialize.')
    app.exit(1)
  })
}

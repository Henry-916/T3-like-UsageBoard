import { clipboard, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { usageChannels } from '../shared/ipc'
import { pricingSettingsSchema, uiPreferencesSchema, usageSummaryInputSchema } from '../shared/types'
import type { UsageSummary, UsageSummaryInput } from '../shared/types'
import { accountChangesSchema, addManualAccountSchema, startAccountLoginSchema } from '../shared/limitsTypes'
import type { AccountsReport } from '../shared/limitsTypes'
import { readConfig, updateConfig } from './configStore'
import type { createAccountService } from './accounts/service'
import type { createLimitsService } from './limits/service'
import type { createAccountLoginManager } from './accounts/loginManager'
import type { createUpdater } from './updater'

export function registerIpc(
  getWindow: () => BrowserWindow | undefined,
  userData: string,
  getSummary: (input: UsageSummaryInput, refresh?: boolean) => Promise<UsageSummary>,
  accounts: ReturnType<typeof createAccountService>,
  limits: ReturnType<typeof createLimitsService>,
  login: ReturnType<typeof createAccountLoginManager>,
  updater: ReturnType<typeof createUpdater>,
  openExternal: (url: string) => Promise<void>
): void {
  function ownWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Untrusted window IPC sender')
    }
    return window
  }

  ipcMain.handle(usageChannels.minimize, (event) => ownWindow(event).minimize())
  ipcMain.handle(usageChannels.isMaximized, event => {
    const window = ownWindow(event)
    return window.isMaximized() || window.isFullScreen()
  })
  ipcMain.handle(usageChannels.toggleMaximize, event => {
    const window = ownWindow(event)
    if (window.isFullScreen()) window.setFullScreen(false)
    else if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized() || window.isFullScreen()
  })
  ipcMain.handle(usageChannels.hide, (event) => ownWindow(event).close())
  ipcMain.handle(usageChannels.summary, (event, input: unknown, refresh: unknown) => {
    ownWindow(event)
    const parsed = usageSummaryInputSchema.safeParse(input)
    if (!parsed.success || (refresh !== undefined && typeof refresh !== 'boolean')) throw new Error('Invalid usage query')
    return getSummary(parsed.data, refresh)
  })
  ipcMain.handle(usageChannels.pricingSettings, async (event) => {
    ownWindow(event)
    const { priceOverrides, modelAliases } = await readConfig(userData)
    return { priceOverrides, modelAliases }
  })
  ipcMain.handle(usageChannels.savePricing, async (event, input: unknown) => {
    ownWindow(event)
    const parsed = pricingSettingsSchema.safeParse(input)
    if (!parsed.success) throw new Error('Invalid pricing settings')
    await updateConfig(userData, config => ({ ...config, ...parsed.data }))
  })

  function updated<T extends AccountsReport | null>(result: T): T {
    if (result) limits.accountsChanged(result.accounts)
    return result
  }
  ipcMain.handle(usageChannels.limits, async event => {
    ownWindow(event)
    await limits.ready
    return limits.get()
  })
  ipcMain.handle(usageChannels.refreshLimits, event => { ownWindow(event); return limits.refresh() })
  ipcMain.handle(usageChannels.consumeResetCredit, (event, accountId: unknown) => {
    ownWindow(event)
    if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 512) throw new Error('账号无效')
    return limits.consumeResetCredit(accountId)
  })
  ipcMain.handle(usageChannels.accounts, event => { ownWindow(event); return accounts.list() })
  ipcMain.handle(usageChannels.addAccount, async (event, input: unknown) => {
    ownWindow(event)
    const result = addManualAccountSchema.safeParse(input)
    if (!result.success) throw new Error('Invalid account configuration')
    return updated(await accounts.add(result.data))
  })
  ipcMain.handle(usageChannels.updateAccount, async (event, id: unknown, changes: unknown) => {
    ownWindow(event)
    const update = accountChangesSchema.safeParse(changes)
    if (typeof id !== 'string' || !update.success) throw new Error('Invalid account changes')
    return updated(await accounts.update(id, update.data))
  })
  ipcMain.handle(usageChannels.setScanT3, async (event, enabled: unknown) => {
    ownWindow(event)
    if (typeof enabled !== 'boolean') throw new Error('Invalid T3 scan setting')
    return updated(await accounts.setScanT3(enabled))
  })
  ipcMain.handle(usageChannels.removeAccount, async (event, id: unknown) => {
    ownWindow(event)
    if (typeof id !== 'string' || !id.trim() || id.length > 512) throw new Error('Invalid account')
    return updated(await accounts.remove(id))
  })
  ipcMain.handle(usageChannels.restoreHiddenAccounts, async event => {
    ownWindow(event)
    return updated(await accounts.restoreHidden())
  })
  ipcMain.handle(usageChannels.accountLoginState, event => { ownWindow(event); return login.getState() })
  ipcMain.handle(usageChannels.startAccountLogin, (event, input: unknown) => {
    ownWindow(event)
    const parsed = startAccountLoginSchema.safeParse(input)
    if (!parsed.success) throw new Error('登录参数无效。')
    return login.start(parsed.data)
  })
  const validFlowId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)
  ipcMain.handle(usageChannels.submitAccountLoginCode, (event, id: unknown, code: unknown) => {
    ownWindow(event)
    if (!validFlowId(id) || typeof code !== 'string' || !code.trim() || code.length > 8192) throw new Error('授权信息无效。')
    return login.submitCode(id, code)
  })
  ipcMain.handle(usageChannels.cancelAccountLogin, (event, id: unknown) => {
    ownWindow(event)
    if (!validFlowId(id)) throw new Error('登录流程无效。')
    return login.cancel(id)
  })
  ipcMain.handle(usageChannels.openExternalUrl, (event, url: unknown) => {
    ownWindow(event)
    if (typeof url !== 'string' || url.length > 8192) throw new Error('链接无效。')
    return openExternal(url)
  })
  ipcMain.handle(usageChannels.copyText, (event, text: unknown) => {
    ownWindow(event)
    if (typeof text !== 'string' || text.length === 0 || text.length > 8192) throw new Error('无法复制此文本。')
    clipboard.writeText(text)
  })
  ipcMain.handle(usageChannels.getUpdateState, event => { ownWindow(event); return updater.getState() })
  ipcMain.handle(usageChannels.checkForUpdates, event => { ownWindow(event); return updater.checkForUpdates() })
  ipcMain.handle(usageChannels.downloadUpdate, event => { ownWindow(event); return updater.downloadUpdate() })
  ipcMain.handle(usageChannels.installUpdate, event => { ownWindow(event); return updater.installUpdate() })
  ipcMain.handle(usageChannels.preferences, async event => {
    ownWindow(event)
    return uiPreferencesSchema.parse((await readConfig(userData)).preferences)
  })
  ipcMain.handle(usageChannels.savePreferences, async (event, input: unknown) => {
    ownWindow(event)
    const parsed = uiPreferencesSchema.safeParse(input)
    if (!parsed.success) throw new Error('Invalid UI preferences')
    await updateConfig(userData, config => ({ ...config, preferences: { ...config.preferences, ...parsed.data } }))
  })
}

import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { usageChannels } from '../shared/ipc'
import { pricingSettingsSchema, uiPreferencesSchema, usageSummaryInputSchema } from '../shared/types'
import type { UsageSummary, UsageSummaryInput } from '../shared/types'
import { accountChangesSchema, addManualAccountSchema } from '../shared/limitsTypes'
import type { AccountsReport } from '../shared/limitsTypes'
import { readConfig, updateConfig } from './configStore'
import type { createAccountService } from './accounts/service'
import type { createLimitsService } from './limits/service'

export function registerIpc(
  getWindow: () => BrowserWindow | undefined,
  userData: string,
  getSummary: (input: UsageSummaryInput, refresh?: boolean) => Promise<UsageSummary>,
  accounts: ReturnType<typeof createAccountService>,
  limits: ReturnType<typeof createLimitsService>
): void {
  function ownWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Untrusted window IPC sender')
    }
    return window
  }

  ipcMain.handle(usageChannels.minimize, (event) => ownWindow(event).minimize())
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
    if (typeof id !== 'string') throw new Error('Invalid manual account')
    return updated(await accounts.remove(id))
  })
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

import { contextBridge, ipcRenderer } from 'electron'
import { usageChannels } from '../shared/ipc'
import type { UsageApi } from '../shared/ipc'
import type { AccountLoginState, LimitsReport } from '../shared/limitsTypes'
import type { UpdateState } from '../shared/updateTypes'
import type { UiPreferences } from '../shared/types'

const usageApi: UsageApi = {
  minimize: () => ipcRenderer.invoke(usageChannels.minimize),
  toggleMaximize: () => ipcRenderer.invoke(usageChannels.toggleMaximize),
  isMaximized: () => ipcRenderer.invoke(usageChannels.isMaximized),
  onMaximizedChanged(listener) {
    const handler = (_event: unknown, maximized: boolean) => listener(maximized)
    ipcRenderer.on(usageChannels.maximizedChanged, handler)
    return () => ipcRenderer.removeListener(usageChannels.maximizedChanged, handler)
  },
  hide: () => ipcRenderer.invoke(usageChannels.hide),
  getSummary: (query, refresh) => ipcRenderer.invoke(usageChannels.summary, query, refresh),
  getPricingSettings: () => ipcRenderer.invoke(usageChannels.pricingSettings),
  savePricingSettings: (settings) => ipcRenderer.invoke(usageChannels.savePricing, settings),
  getLimits: () => ipcRenderer.invoke(usageChannels.limits),
  refreshLimits: () => ipcRenderer.invoke(usageChannels.refreshLimits),
  consumeResetCredit: accountId => ipcRenderer.invoke(usageChannels.consumeResetCredit, accountId),
  getAccounts: () => ipcRenderer.invoke(usageChannels.accounts),
  addManualAccount: input => ipcRenderer.invoke(usageChannels.addAccount, input),
  switchAccount: id => ipcRenderer.invoke(usageChannels.switchAccount, id),
  updateAccount: (id, changes) => ipcRenderer.invoke(usageChannels.updateAccount, id, changes),
  removeManualAccount: id => ipcRenderer.invoke(usageChannels.removeAccount, id),
  removeAccount: id => ipcRenderer.invoke(usageChannels.removeAccount, id),
  restoreHiddenAccounts: () => ipcRenderer.invoke(usageChannels.restoreHiddenAccounts),
  getAccountLoginState: () => ipcRenderer.invoke(usageChannels.accountLoginState),
  startAccountLogin: input => ipcRenderer.invoke(usageChannels.startAccountLogin, input),
  submitAccountLoginCode: (id, code) => ipcRenderer.invoke(usageChannels.submitAccountLoginCode, id, code),
  cancelAccountLogin: id => ipcRenderer.invoke(usageChannels.cancelAccountLogin, id),
  openExternalUrl: url => ipcRenderer.invoke(usageChannels.openExternalUrl, url),
  copyText: text => ipcRenderer.invoke(usageChannels.copyText, text),
  getUpdateState: () => ipcRenderer.invoke(usageChannels.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(usageChannels.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(usageChannels.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(usageChannels.installUpdate),
  onAccountLoginUpdated(listener) {
    const handler = (_event: unknown, state: AccountLoginState) => listener(state)
    ipcRenderer.on(usageChannels.accountLoginUpdated, handler)
    return () => ipcRenderer.removeListener(usageChannels.accountLoginUpdated, handler)
  },
  onUpdateStateChanged(listener) {
    const handler = (_event: unknown, state: UpdateState) => listener(state)
    ipcRenderer.on(usageChannels.updateStateChanged, handler)
    return () => ipcRenderer.removeListener(usageChannels.updateStateChanged, handler)
  },
  setScanT3: enabled => ipcRenderer.invoke(usageChannels.setScanT3, enabled),
  getUiPreferences: () => ipcRenderer.invoke(usageChannels.preferences),
  saveUiPreferences: changes => ipcRenderer.invoke(usageChannels.savePreferences, changes),
  trayResize: height => ipcRenderer.invoke(usageChannels.trayResize, height),
  trayOpenMain: () => ipcRenderer.invoke(usageChannels.trayOpenMain),
  onUiPreferencesUpdate(listener) {
    const handler = (_event: unknown, preferences: UiPreferences) => listener(preferences)
    ipcRenderer.on(usageChannels.preferencesUpdated, handler)
    return () => ipcRenderer.removeListener(usageChannels.preferencesUpdated, handler)
  },
  onLimitsUpdated(listener) {
    const handler = (_event: unknown, report: LimitsReport) => listener(report)
    ipcRenderer.on(usageChannels.limitsUpdated, handler)
    return () => ipcRenderer.removeListener(usageChannels.limitsUpdated, handler)
  },
  onRefreshRequested(listener) {
    const handler = () => listener()
    ipcRenderer.on(usageChannels.refreshRequested, handler)
    return () => ipcRenderer.removeListener(usageChannels.refreshRequested, handler)
  }
}

contextBridge.exposeInMainWorld('usageApi', usageApi)

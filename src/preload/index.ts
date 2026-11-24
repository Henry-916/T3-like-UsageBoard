import { contextBridge, ipcRenderer } from 'electron'
import { usageChannels } from '../shared/ipc'
import type { UsageApi } from '../shared/ipc'
import type { LimitsReport } from '../shared/limitsTypes'

const usageApi: UsageApi = {
  minimize: () => ipcRenderer.invoke(usageChannels.minimize),
  hide: () => ipcRenderer.invoke(usageChannels.hide),
  getSummary: (query, refresh) => ipcRenderer.invoke(usageChannels.summary, query, refresh),
  getPricingSettings: () => ipcRenderer.invoke(usageChannels.pricingSettings),
  savePricingSettings: (settings) => ipcRenderer.invoke(usageChannels.savePricing, settings),
  getLimits: () => ipcRenderer.invoke(usageChannels.limits),
  refreshLimits: () => ipcRenderer.invoke(usageChannels.refreshLimits),
  consumeResetCredit: accountId => ipcRenderer.invoke(usageChannels.consumeResetCredit, accountId),
  getAccounts: () => ipcRenderer.invoke(usageChannels.accounts),
  addManualAccount: input => ipcRenderer.invoke(usageChannels.addAccount, input),
  updateAccount: (id, changes) => ipcRenderer.invoke(usageChannels.updateAccount, id, changes),
  removeManualAccount: id => ipcRenderer.invoke(usageChannels.removeAccount, id),
  setScanT3: enabled => ipcRenderer.invoke(usageChannels.setScanT3, enabled),
  getUiPreferences: () => ipcRenderer.invoke(usageChannels.preferences),
  saveUiPreferences: changes => ipcRenderer.invoke(usageChannels.savePreferences, changes),
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

import type { PricingSettings, UiPreferences, UsageSummary, UsageSummaryInput } from './types'
import type { AccountChanges, AccountLoginState, AccountsReport, AddManualAccount, ConsumeResetCreditResult, LimitsReport, StartAccountLoginInput } from './limitsTypes'
import type { UpdateState } from './updateTypes'

export const usageChannels = {
  minimize: 'usage:window-minimize',
  toggleMaximize: 'usage:window-toggle-maximize',
  isMaximized: 'usage:window-is-maximized',
  maximizedChanged: 'usage:window-maximized-changed',
  hide: 'usage:window-hide',
  refreshRequested: 'usage:refresh-requested',
  summary: 'usage:get-summary',
  pricingSettings: 'usage:get-pricing-settings',
  savePricing: 'usage:save-pricing-settings',
  limits: 'usage:get-limits',
  refreshLimits: 'usage:refresh-limits',
  consumeResetCredit: 'usage:consume-reset-credit',
  limitsUpdated: 'usage:limits-updated',
  accounts: 'usage:get-accounts',
  addAccount: 'usage:add-manual-account',
  updateAccount: 'usage:update-account',
  removeAccount: 'usage:remove-manual-account',
  restoreHiddenAccounts: 'usage:restore-hidden-accounts',
  accountLoginState: 'usage:account-login-state',
  startAccountLogin: 'usage:start-account-login',
  submitAccountLoginCode: 'usage:submit-account-login-code',
  cancelAccountLogin: 'usage:cancel-account-login',
  accountLoginUpdated: 'usage:account-login-updated',
  openExternalUrl: 'usage:open-external-url',
  getUpdateState: 'usage:get-update-state',
  checkForUpdates: 'usage:check-for-updates',
  downloadUpdate: 'usage:download-update',
  installUpdate: 'usage:install-update',
  updateStateChanged: 'usage:update-state-changed',
  setScanT3: 'usage:set-scan-t3',
  preferences: 'usage:get-ui-preferences',
  savePreferences: 'usage:save-ui-preferences'
} as const

export interface UsageApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  isMaximized(): Promise<boolean>
  onMaximizedChanged(listener: (maximized: boolean) => void): () => void
  hide(): Promise<void>
  getSummary(query: UsageSummaryInput, refresh?: boolean): Promise<UsageSummary>
  getPricingSettings(): Promise<PricingSettings>
  savePricingSettings(settings: PricingSettings): Promise<void>
  onRefreshRequested(listener: () => void): () => void
  getLimits(): Promise<LimitsReport>
  refreshLimits(): Promise<LimitsReport>
  consumeResetCredit(accountId: string): Promise<ConsumeResetCreditResult>
  onLimitsUpdated(listener: (report: LimitsReport) => void): () => void
  getAccounts(): Promise<AccountsReport>
  addManualAccount(input: AddManualAccount): Promise<AccountsReport | null>
  updateAccount(id: string, changes: AccountChanges): Promise<AccountsReport>
  removeManualAccount(id: string): Promise<AccountsReport>
  removeAccount(id: string): Promise<AccountsReport>
  restoreHiddenAccounts(): Promise<AccountsReport>
  getAccountLoginState(): Promise<AccountLoginState>
  startAccountLogin(input: StartAccountLoginInput): Promise<AccountLoginState>
  submitAccountLoginCode(flowId: string, code: string): Promise<AccountLoginState>
  cancelAccountLogin(flowId: string): Promise<AccountLoginState>
  onAccountLoginUpdated(listener: (state: AccountLoginState) => void): () => void
  openExternalUrl(url: string): Promise<void>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdateStateChanged(listener: (state: UpdateState) => void): () => void
  setScanT3(enabled: boolean): Promise<AccountsReport>
  getUiPreferences(): Promise<UiPreferences>
  saveUiPreferences(changes: UiPreferences): Promise<void>
}

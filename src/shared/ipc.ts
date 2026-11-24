import type { PricingSettings, UiPreferences, UsageSummary, UsageSummaryInput } from './types'
import type { AccountChanges, AccountsReport, AddManualAccount, ConsumeResetCreditResult, LimitsReport } from './limitsTypes'

export const usageChannels = {
  minimize: 'usage:window-minimize',
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
  setScanT3: 'usage:set-scan-t3',
  preferences: 'usage:get-ui-preferences',
  savePreferences: 'usage:save-ui-preferences'
} as const

export interface UsageApi {
  minimize(): Promise<void>
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
  setScanT3(enabled: boolean): Promise<AccountsReport>
  getUiPreferences(): Promise<UiPreferences>
  saveUiPreferences(changes: UiPreferences): Promise<void>
}

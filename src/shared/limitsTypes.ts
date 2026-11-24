import { z } from 'zod'
import { providerSchema } from './types'
import type { UsageProviderKind } from './types'

export interface LimitWindow {
  id: string
  kind: 'session' | 'weekly' | 'monthly' | 'other'
  label: string
  usedPercent: number
  resetsAt?: string
  windowDurationMins?: number
  modelIds?: string[]
}

export type LimitFailureReason = 'expired' | 'cli_missing' | 'failed'

export type LimitsProbeResult = {
  kind: 'ok'
  windows: LimitWindow[]
  fingerprint?: string
  plan?: string
  resetCredits?: number
  resetCreditsExpiresAt?: string
  nextResetCreditId?: string
} | { kind: 'unsupported' } | { kind: 'failed'; reason?: LimitFailureReason }

export interface LimitsProbeContext {
  signal: AbortSignal
  fetch: typeof globalThis.fetch
  readCredential: (path: string) => Promise<unknown>
  manualApiKey?: string
}

export type AccountOrigin = 'native' | 't3' | 'manual'
export interface LimitAccountReading {
  id: string
  provider: UsageProviderKind
  displayName: string
  origin: AccountOrigin
  plan?: string
  windows: LimitWindow[]
  checkedAt: string
  stale: boolean
  resetCredits?: number
  resetCreditsExpiresAt?: string
  nextResetCreditId?: string
  previous?: { checkedAt: string; windows: LimitWindow[] }
}

export interface LimitAccountIssue {
  id: string
  provider: UsageProviderKind
  displayName: string
  origin: AccountOrigin
  reason: LimitFailureReason
  cached: boolean
}

export interface LimitsReport {
  accounts: LimitAccountReading[]
  issues?: LimitAccountIssue[]
  checkedAt: string | null
  refreshing: boolean
}

export type ConsumeResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

export interface ConsumeResetCreditResult {
  outcome: ConsumeResetCreditOutcome
  report: LimitsReport
  warning?: string
}

export interface AccountView {
  id: string
  provider: UsageProviderKind
  displayName: string
  origin: AccountOrigin
  enabled: boolean
  dataDir?: string
  hasCredential: boolean
}

export interface AccountsReport {
  scanT3: boolean
  accounts: AccountView[]
}

const displayName = z.string().trim().min(1).max(120)
export const addManualAccountSchema = z.object({
  provider: providerSchema,
  displayName,
  mode: z.enum(['directory', 'credential', 'apiKey']),
  apiKey: z.string().trim().min(1).max(8192).optional()
}).refine(({ provider, mode, apiKey }) =>
  mode === 'directory' ? apiKey === undefined
    : mode === 'credential' ? provider === 'antigravity' && apiKey === undefined
      : provider === 'opencode' && Boolean(apiKey))
export type AddManualAccount = z.infer<typeof addManualAccountSchema>

export const accountChangesSchema = z.object({
  enabled: z.boolean().optional(),
  displayName: displayName.optional()
})
export type AccountChanges = z.infer<typeof accountChangesSchema>

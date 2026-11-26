import { z } from 'zod'

export const providerSchema = z.enum(['antigravity', 'opencode', 'codex', 'claude'])
export type UsageProviderKind = z.infer<typeof providerSchema>
export const usageSpeedSchema = z.enum(['standard', 'fast', 'ultrafast'])
export type UsageSpeed = z.infer<typeof usageSpeedSchema>

const count = z.number().int().nonnegative()
const text = z.string().trim().min(1)
export const tokenTotalsSchema = z.object({
  uncachedInputTokens: count,
  cachedInputTokens: count,
  cacheCreationTokens: count,
  outputTokens: count,
  reasoningTokens: count
})
export type UsageTokenTotals = z.infer<typeof tokenTotalsSchema>

export const usageRecordSchema = z.object({
  provider: providerSchema,
  timestampMs: z.number(),
  model: text,
  rateModel: text.optional(),
  // Legacy exports may include usage without any session identifier.
  sessionId: z.string(),
  totals: tokenTotalsSchema,
  cacheCreation1hTokens: count.optional(),
  reportedCostUsd: z.number().nullable(),
  speed: usageSpeedSchema,
  unresolvedServiceTierTurnId: text.optional(),
  dedupeKey: text.nullable(),
  antigravity: z.object({
    modelId: count,
    modelQuality: count,
    timestampQuality: count,
    keys: z.array(text)
  }).optional()
})
export type UsageRecord = Readonly<z.infer<typeof usageRecordSchema>>

export const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0
}

export function totalTokens(totals: UsageTokenTotals): number {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens
}

export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export type UsageDay = string
export type UsageResolution = 'day' | 'hour'
export type UsageCostSource = 'providerReported' | 'modelPriced' | 'unpriced'
export interface UsageCategoryCost {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}
export interface UsageBucket {
  day: UsageDay
  hourStart?: string
  provider: UsageProviderKind
  model: string
  totals: UsageTokenTotals
  costUsd: number
  cacheSavingsUsd: number
  categoryCostUsd?: UsageCategoryCost
  fastCostUsd?: number
  ultrafastCostUsd?: number
  speedPremiumUsd?: number
  costSource: UsageCostSource
  records: number
  unpricedRecords: number
  unpricedTokens?: number
  sessions: number
}
export type UsagePricingStatus = 'fresh' | 'cached' | 'unavailable'
export interface UsagePricing {
  status: UsagePricingStatus
  source: string
  fetchedAt: string | null
  knownModels: number
}

const day = z.iso.date()
export const usageSummaryInputSchema = z.object({
  sinceDay: day,
  untilDay: day,
  timeZone: text.refine((value) => {
    if (value.startsWith('+') || value.startsWith('-')) return false
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
  }, 'Expected IANA time zone'),
  resolution: z.enum(['day', 'hour']).optional(),
  sinceTime: z.iso.datetime({ offset: true }).optional(),
  untilTime: z.iso.datetime({ offset: true }).optional()
}).refine(({ sinceDay, untilDay }) => sinceDay <= untilDay)
  .refine(({ resolution, sinceTime, untilTime }) => {
    if (!sinceTime && !untilTime) return resolution !== 'hour'
    return Boolean(sinceTime && untilTime && Date.parse(sinceTime) < Date.parse(untilTime))
  })
export type UsageSummaryInput = z.infer<typeof usageSummaryInputSchema>

export type UsageSourceStatus = 'ok' | 'missing' | 'partial' | 'failed'
export interface UsageSource {
  provider: UsageProviderKind
  status: UsageSourceStatus
  scannedFiles: number
  skippedFiles: number
  distinctSessions: number
}
export interface UsageSummary {
  readAt: string
  timeZone: string
  sinceDay: UsageDay
  untilDay: UsageDay
  buckets: UsageBucket[]
  sources: UsageSource[]
  pricing: UsagePricing
  scanDurationMs: number
}

const price = z.number().nonnegative()
export const priceOverridesSchema = z.record(text, z.object({
  inputCostPerMillionTokens: price,
  outputCostPerMillionTokens: price,
  cacheReadCostPerMillionTokens: price.optional(),
  cacheWriteCostPerMillionTokens: price.optional()
}))
export type PriceOverrides = Readonly<z.infer<typeof priceOverridesSchema>>
export const pricingSettingsSchema = z.object({
  priceOverrides: priceOverridesSchema
})
export type PricingSettings = z.infer<typeof pricingSettingsSchema>
export type PricePresetSource = 'models.dev'
export interface PricePreset {
  id: string
  modelId: string
  label: string
  providerId?: string
  providerLabel: string
  providerRank?: number
  canonicalId?: string
  isCanonicalOwner?: boolean
  popularity?: number
  primary?: boolean
  derived?: boolean
  source: PricePresetSource
  aliases?: string[]
  inputCostPerMillionTokens: number
  outputCostPerMillionTokens: number
  cacheReadCostPerMillionTokens?: number
  cacheWriteCostPerMillionTokens?: number
}
export const uiPreferencesSchema = z.object({
  tab: z.enum(['cost', 'tokens', 'limits']).optional(),
  window: z.enum(['24h', '7d', '30d', '90d']).optional(),
  hiddenProviders: z.array(providerSchema).max(4).optional()
})
export type UiPreferences = z.infer<typeof uiPreferencesSchema>

export const accountConfigSchema = z.object({
  id: text,
  provider: providerSchema,
  displayName: text,
  dataDir: text.optional(),
  credentialPath: text.optional()
})
export type AccountConfig = z.infer<typeof accountConfigSchema>
export interface DiscoveredAccount extends AccountConfig {
  email?: string
  current?: boolean
  canSwitch?: boolean
  credentialSource?: DiscoveredAccount
  switchSource?: DiscoveredAccount
  currentCredential?: Buffer
  origin: 'native' | 'manual'
  enabled: boolean
  credentialPaths?: string[]
}

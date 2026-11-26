import type { PricePreset, UsageSummary, UsageSummaryInput } from '../../shared/types'

export type UsageWorkerRequest = {
  id: number
  type?: 'summary'
  query: UsageSummaryInput
  refresh: boolean
} | {
  id: number
  type: 'presets'
}

export type UsageWorkerResponse = {
  id: number
  summary: UsageSummary
} | {
  id: number
  presets: PricePreset[]
} | {
  id: number
  error: string
}

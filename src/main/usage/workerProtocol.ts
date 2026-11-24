import type { UsageSummary, UsageSummaryInput } from '../../shared/types'

export interface UsageWorkerRequest {
  id: number
  query: UsageSummaryInput
  refresh: boolean
}

export type UsageWorkerResponse = {
  id: number
  summary: UsageSummary
} | {
  id: number
  error: string
}

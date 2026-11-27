import type { PricePreset, UsageProviderKind, UsageSummary, UsageSummaryInput } from '../../shared/types'

export type UsageWorkerRequest = {
  id: number
  type?: 'summary'
  query: UsageSummaryInput
  refresh: boolean
  refreshProvider?: UsageProviderKind
} | {
  id: number
  type: 'presets'
}

/** Main-process answer to a worker catalog request (electron.net.fetch bridge). */
export interface UsageWorkerFetchAnswer {
  kind: 'models-dev:fetch'
  requestId: number
  status: number
  body?: string
  etag?: string
}

/** Worker-initiated catalog request, handled by the main-process client. */
export interface UsageWorkerFetchRequest {
  kind: 'models-dev:fetch'
  requestId: number
  url: string
  etag?: string
}

export type UsageWorkerMessage = {
  id: number
  summary: UsageSummary
} | {
  id: number
  presets: PricePreset[]
} | {
  id: number
  error: string
}

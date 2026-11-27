import { net } from 'electron'
import type { Worker } from 'node:worker_threads'
import type { PricePreset, UsageProviderKind, UsageSummary, UsageSummaryInput } from '../../shared/types'
import startWorker from './worker?nodeWorker'
import type { UsageWorkerFetchAnswer, UsageWorkerFetchRequest, UsageWorkerMessage, UsageWorkerRequest } from './workerProtocol'

export function createUsageClient(userData: string, bundledSnapshot: string) {
  const pending = new Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }>()
  let worker: Worker | undefined
  let nextId = 0

  function rejectPending(): void {
    for (const request of pending.values()) request.reject(new Error('Usage scanner stopped'))
    pending.clear()
  }

  async function answerFetch(instance: Worker, message: UsageWorkerFetchRequest): Promise<void> {
    let status = 0
    let body: string | undefined
    let etag: string | undefined
    try {
      // electron.net.fetch inherits the system proxy, unlike worker_threads' fetch.
      const response = await net.fetch(message.url, {
        headers: message.etag ? { 'If-None-Match': message.etag } : undefined,
        signal: AbortSignal.timeout(15_000),
      })
      status = response.status
      etag = response.headers.get('etag') ?? undefined
      if (status !== 304) body = await response.text()
    } catch {
      status = 0
    }
    const answer: UsageWorkerFetchAnswer = {
      kind: 'models-dev:fetch', requestId: message.requestId, status, body, etag,
    }
    instance.postMessage(answer)
  }

  function start(): Worker {
    const instance = startWorker({ workerData: { userData, bundledSnapshot } })
    instance.on('message', (message: UsageWorkerMessage | UsageWorkerFetchRequest) => {
      if ('kind' in message && message.kind === 'models-dev:fetch') {
        void answerFetch(instance, message)
        return
      }
      const result = message as UsageWorkerMessage
      const request = pending.get(result.id)
      pending.delete(result.id)
      if ('summary' in result) request?.resolve(result.summary)
      else if ('presets' in result) request?.resolve(result.presets)
      else request?.reject(new Error(result.error))
    })
    const stopped = (): void => {
      if (worker !== instance) return
      worker = undefined
      rejectPending()
    }
    instance.on('exit', stopped)
    instance.on('error', stopped)
    instance.unref()
    return instance
  }

  function send<T>(payload: {
    type?: 'summary'
    query: UsageSummaryInput
    refresh: boolean
    refreshProvider?: UsageProviderKind
  } | { type: 'presets' }): Promise<T> {
    worker ??= start()
    const instance = worker
    const message = { id: nextId++, ...payload } as UsageWorkerRequest
    return new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject })
      try {
        instance.postMessage(message)
      } catch (error) {
        pending.delete(message.id)
        reject(error)
      }
    })
  }

  return {
    getSummary(query: UsageSummaryInput, refresh = false, refreshProvider?: UsageProviderKind): Promise<UsageSummary> {
      return send({ type: 'summary', query, refresh, ...(refreshProvider ? { refreshProvider } : {}) })
    },
    getPricePresets(): Promise<PricePreset[]> {
      return send({ type: 'presets' })
    },
    stop(): void {
      const instance = worker
      worker = undefined
      rejectPending()
      void instance?.terminate()
    }
  }
}

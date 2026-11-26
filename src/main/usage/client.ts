import type { Worker } from 'node:worker_threads'
import type { PricePreset, UsageSummary, UsageSummaryInput } from '../../shared/types'
import startWorker from './worker?nodeWorker'
import type { UsageWorkerRequest, UsageWorkerResponse } from './workerProtocol'

export function createUsageClient(userData: string, fallbackRates: string) {
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

  function start(): Worker {
    const instance = startWorker({ workerData: { userData, fallbackRates } })
    instance.on('message', (message: UsageWorkerResponse) => {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if ('summary' in message) request?.resolve(message.summary)
      else if ('presets' in message) request?.resolve(message.presets)
      else request?.reject(new Error(message.error))
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

  function send<T>(payload: { type?: 'summary'; query: UsageSummaryInput; refresh: boolean } | { type: 'presets' }): Promise<T> {
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
    getSummary(query: UsageSummaryInput, refresh = false): Promise<UsageSummary> {
      return send({ type: 'summary', query, refresh })
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

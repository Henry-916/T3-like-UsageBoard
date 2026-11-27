import { parentPort, workerData } from 'node:worker_threads'
import { setModelsDevFetcher } from './modelsDev'
import type { ModelsDevFetchRequest, ModelsDevFetchResponse } from './modelsDev'
import { createUsageService } from './service'
import type { UsageServiceOptions } from './service'
import type { UsageWorkerFetchAnswer, UsageWorkerMessage, UsageWorkerRequest } from './workerProtocol'

const port = parentPort
if (!port) throw new Error('Usage scanner requires a worker')

// Catalog HTTP goes through the main process: worker_threads' native fetch
// ignores the Windows system proxy, while electron.net.fetch inherits it.
const pendingFetches = new Map<number, (response: ModelsDevFetchResponse | null) => void>()
let nextFetch = 0
setModelsDevFetcher((request: ModelsDevFetchRequest) => new Promise((resolve) => {
  const requestId = nextFetch++
  pendingFetches.set(requestId, resolve)
  port.postMessage({ kind: 'models-dev:fetch', requestId, url: request.url, etag: request.etag })
}))

const service = createUsageService(workerData as UsageServiceOptions)
port.on('message', async (message: UsageWorkerRequest | UsageWorkerMessage | UsageWorkerFetchAnswer) => {
  if ('kind' in message && message.kind === 'models-dev:fetch') {
    const resolve = pendingFetches.get(message.requestId)
    pendingFetches.delete(message.requestId)
    resolve?.(typeof message.status === 'number' ? { status: message.status, body: message.body, etag: message.etag } : null)
    return
  }
  const request = message as UsageWorkerRequest
  let result: UsageWorkerMessage
  try {
    if (request.type === 'presets') {
      result = { id: request.id, presets: await service.getPricePresets() }
    } else {
      result = {
        id: request.id,
        summary: await service.getSummary(request.query, request.refresh, request.refreshProvider),
      }
    }
  } catch {
    result = { id: request.id, error: request.type === 'presets' ? 'Unable to load price presets' : 'Unable to read usage summary' }
  }
  port.postMessage(result)
})

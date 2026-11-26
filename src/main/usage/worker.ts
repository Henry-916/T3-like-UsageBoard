import { parentPort, workerData } from 'node:worker_threads'
import { createUsageService } from './service'
import type { UsageServiceOptions } from './service'
import type { UsageWorkerRequest, UsageWorkerResponse } from './workerProtocol'

const port = parentPort
if (!port) throw new Error('Usage scanner requires a worker')
const service = createUsageService(workerData as UsageServiceOptions)
port.on('message', async (request: UsageWorkerRequest) => {
  let result: UsageWorkerResponse
  try {
    if (request.type === 'presets') {
      result = { id: request.id, presets: await service.getPricePresets() }
    } else {
      result = { id: request.id, summary: await service.getSummary(request.query, request.refresh) }
    }
  } catch {
    result = { id: request.id, error: request.type === 'presets' ? 'Unable to load price presets' : 'Unable to read usage summary' }
  }
  port.postMessage(result)
})

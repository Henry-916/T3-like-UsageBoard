import { parentPort, workerData } from 'node:worker_threads'
import { createUsageService } from './service'
import type { UsageServiceOptions } from './service'
import type { UsageWorkerRequest, UsageWorkerResponse } from './workerProtocol'

const port = parentPort
if (!port) throw new Error('Usage scanner requires a worker')
const service = createUsageService(workerData as UsageServiceOptions)
port.on('message', async ({ id, query, refresh }: UsageWorkerRequest) => {
  let result: UsageWorkerResponse
  try {
    result = { id, summary: await service.getSummary(query, refresh) }
  } catch {
    result = { id, error: 'Unable to read usage summary' }
  }
  port.postMessage(result)
})

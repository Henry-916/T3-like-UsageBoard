import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeClaude } from '../src/main/limits/probes/claude'
import type { LimitsProbeContext } from '../src/shared/limitsTypes'
import type { DiscoveredAccount } from '../src/shared/types'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/limits/probes/cli', async importActual => ({
  ...await importActual<typeof import('../src/main/limits/probes/cli')>(),
  resolveCli: async () => join(process.cwd(), 'fixture-claude.exe')
}))
vi.mock('node:fs/promises', async importActual => ({
  ...await importActual<typeof import('node:fs/promises')>(),
  realpath: vi.fn(async (path: string) => path), stat: vi.fn(async () => ({ isDirectory: () => true }))
}))
const home = join(process.cwd(), 'fake-claude')
const account: DiscoveredAccount = { id: 'claude', provider: 'claude', origin: 'native',
  displayName: 'Claude', enabled: true, dataDir: home, credentialPaths: [join(home, '.credentials.json')] }
function requestContext() {
  return {
    signal: new AbortController().signal,
    readCredential: vi.fn<LimitsProbeContext['readCredential']>().mockResolvedValue({
      claudeAiOauth: { accessToken: 'fake-claude-token', subscriptionType: 'max', accountUuid: 'fake-account' }
    }),
    fetch: vi.fn<LimitsProbeContext['fetch']>()
  }
}

function fakePeer(usage: object) {
  const requests: unknown[] = []
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString())
        requests.push(frame)
        const payload = frame.request_id === 'initialize'
          ? { account: { subscriptionType: 'max', apiProvider: 'firstParty' } } : usage
        queueMicrotask(() => stdout.write(`${JSON.stringify({ type: 'control_response',
          response: { request_id: frame.request_id, subtype: 'success', response: payload } })}\n`))
        callback()
      }
    }),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close')); return true })
  })
  mocks.spawn.mockReturnValue(child)
  return { requests, child }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('Claude usage probe', () => {
  it('reads subscription, model allowance and matching-currency monthly spend', async () => {
    const ctx = requestContext()
    ctx.fetch.mockResolvedValueOnce(Response.json({
      five_hour: { utilization: 15, resets_at: '2032-01-01T00:00:00Z' },
      seven_day: { utilization: 27, resets_at: 'invalid' },
      limits: [
        { kind: 'other', percent: 99 },
        { kind: 'weekly_scoped', percent: 34, scope: { model: { display_name: 'Opus', id: 'claude-opus-4-6' } } },
        { kind: 'model_scoped', percent: 12, scope: { model: { display_name: 'Sonnet' } } }
      ],
      spend: { enabled: true, used: { amount_minor: 16, currency: 'USD', exponent: 2 },
        limit: { amount_minor: 40, currency: 'USD', exponent: 2 } },
      extra_usage: { is_enabled: true, used_credits: 10, monthly_limit: 20 }
    }))
    expect(await probeClaude(account, ctx)).toMatchObject({ kind: 'ok', plan: 'max',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 15, resetsAt: '2032-01-01T00:00:00.000Z' },
        { id: 'seven_day', kind: 'weekly', usedPercent: 27 },
        { id: 'seven_day_opus', kind: 'weekly', modelIds: ['claude-opus-4-6'], usedPercent: 34 },
        { id: 'seven_day_sonnet', kind: 'weekly', modelIds: ['sonnet'], usedPercent: 12 },
        { id: 'monthly_spend', kind: 'monthly', usedPercent: 40 }
      ] })
    expect(ctx.fetch).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', {
      signal: ctx.signal, redirect: 'error', headers: { Authorization: 'Bearer fake-claude-token',
        'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.273' }
    })
  })

  it('uses Claude control IPC without a prompt after a 401', async () => {
    const ctx = requestContext()
    ctx.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const { requests, child } = fakePeer({ rate_limits_available: true,
      rate_limits: { model_scoped: [{ display_name: 'Sonnet', utilization: 77, resets_at: null }] } })
    expect(await probeClaude(account, ctx)).toMatchObject({ kind: 'ok', plan: 'max',
      windows: [{ id: 'seven_day_sonnet', usedPercent: 77 }] })
    expect(requests).toEqual([
      { type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }
    ])
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('treats no subscription or a manual API key as unsupported', async () => {
    const ctx = requestContext()
    ctx.readCredential.mockResolvedValue(undefined)
    const { requests } = fakePeer({ rate_limits_available: false, rate_limits: null })
    expect(await probeClaude(account, ctx)).toEqual({ kind: 'unsupported' })
    expect(await probeClaude(account, { ...ctx, manualApiKey: 'fake-key' })).toEqual({ kind: 'unsupported' })
    expect(ctx.fetch).not.toHaveBeenCalled()
    expect(requests).toHaveLength(2)
  })

  it('rejects malformed utilization while ignoring a null window', async () => {
    const ctx = requestContext()
    ctx.fetch.mockResolvedValueOnce(Response.json({ five_hour: null, seven_day: { utilization: '75' } }))
    expect(await probeClaude(account, ctx)).toEqual({ kind: 'failed' })
  })
})

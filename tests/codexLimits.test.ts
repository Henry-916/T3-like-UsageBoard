import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codexPlanLabel, probeCodex } from '../src/main/limits/probes/codex'
import type { LimitsProbeContext } from '../src/shared/limitsTypes'
import type { DiscoveredAccount } from '../src/shared/types'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), realpath: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/limits/probes/cli', async importActual => ({
  ...await importActual<typeof import('../src/main/limits/probes/cli')>(),
  resolveCli: async () => join(process.cwd(), 'fixture-codex.exe')
}))
vi.mock('node:fs/promises', async importActual => ({
  ...await importActual<typeof import('node:fs/promises')>(),
  realpath: mocks.realpath, stat: vi.fn(async () => ({ isDirectory: () => true }))
}))

const home = join(process.cwd(), 'fake-codex')
const account: DiscoveredAccount = { id: 'codex', provider: 'codex', origin: 'native',
  displayName: 'Codex', enabled: true, dataDir: home, credentialPaths: [join(home, 'auth.json')] }
const fakeCredential = { tokens: { access_token: 'fake-codex-token', account_id: 'fake-account' } }
function requestContext() {
  return {
    signal: new AbortController().signal,
    readCredential: vi.fn<LimitsProbeContext['readCredential']>().mockResolvedValue(fakeCredential),
    fetch: vi.fn<LimitsProbeContext['fetch']>()
  }
}

function fakePeer(onFrame: (request: Record<string, unknown>, send: (reply: object) => void) => void) {
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        onFrame(JSON.parse(chunk.toString()), reply => queueMicrotask(() => stdout.write(`${JSON.stringify(reply)}\n`)))
        callback()
      }
    }),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close')); return true })
  })
  mocks.spawn.mockReturnValue(child)
  return child
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.realpath.mockImplementation(async (path: string) => path)
})

describe('Codex usage probe', () => {
  it.each([
    ['free', 'Free'], ['go', 'Go'], ['plus', 'Plus'], ['pro', 'Pro 200'], ['prolite', 'Pro 100'],
    ['promax', 'Pro 500'], ['self_serve_business_prolite', 'Business Premium'], ['team', 'Business'],
    ['self_serve_business_usage_based', 'Business'], ['business', 'Business'], ['ent26', 'Enterprise'],
    ['enterprise_cbp_automation', 'Enterprise'], ['enterprise_cbp_usage_based', 'Enterprise'],
    ['enterprise', 'Enterprise'], ['edu', 'Edu'], ['edu_plus', 'Edu'], ['edu_pro', 'Edu']
  ])('maps plan %s', (id, name) => {
    expect(codexPlanLabel(id)).toBe(`ChatGPT ${name} Subscription`)
  })

  it('handles unknown, new and missing plan types', () => {
    expect(codexPlanLabel('unknown')).toBe('ChatGPT Subscription')
    expect(codexPlanLabel('new_plan')).toBe('new_plan')
    expect(codexPlanLabel(undefined)).toBeUndefined()
  })

  it('reads windows and counts only available unexpired Codex reset credits', async () => {
    const ctx = requestContext()
    ctx.fetch
      .mockResolvedValueOnce(Response.json({ plan_type: 'plus', rate_limit: {
        primary_window: { used_percent: 32, reset_at: 1_900_000_000, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 140, limit_window_seconds: 604_800 }
      } }))
      .mockResolvedValueOnce(Response.json({ credits: [
        { id: 'later', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2999-01-01' },
        { id: 'first', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2998-01-01' },
        { reset_type: 'codex_rate_limits', status: 'available', expires_at: '2000-01-01' },
        { reset_type: 'codex_rate_limits', status: 'available', expires_at: 'invalid' },
        { reset_type: 'codex_rate_limits', status: 'redeemed', expires_at: '2999-01-01' },
        { reset_type: 'unknown', status: 'available', expires_at: '2999-01-01' }
      ] }))
    expect(await probeCodex(account, ctx)).toMatchObject({ kind: 'ok', plan: 'ChatGPT Plus Subscription',
      resetCredits: 2, nextResetCreditId: 'first', resetCreditsExpiresAt: '2998-01-01T00:00:00.000Z',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), windows: [
        { id: 'primary', kind: 'session', windowDurationMins: 300, usedPercent: 32, resetsAt: '2030-03-17T17:46:40.000Z' },
        { id: 'secondary', kind: 'weekly', windowDurationMins: 10080, usedPercent: 100 }
      ] })
    const [first, second] = ctx.fetch.mock.calls
    expect(first[0]).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(second[0]).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits')
    expect(first[1]).toMatchObject({ signal: ctx.signal, redirect: 'error', headers: {
      Authorization: 'Bearer fake-codex-token', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop',
      'Chatgpt-Account-Id': 'fake-account'
    } })
  })

  it('uses initialize/initialized then account/rateLimits/read after a 401 and closes the child', async () => {
    const ctx = requestContext()
    ctx.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const methods: unknown[] = []
    const child = fakePeer((request, send) => {
      methods.push(request.method)
      if (request.id === 1) send({ id: 1, result: { userAgent: 'fake' } })
      if (request.id === 2) send({ id: 2, result: {
        accountId: 'fake-account', rateLimits: { primary: { usedPercent: 4 } },
        rateLimitsByLimitId: { codex: { planType: 'go', primary: { usedPercent: 61 } } },
        rateLimitResetCredits: { credits: [
          { id: 'later', resetType: 'codexRateLimits', status: 'available', expiresAt: 32_473_353_600 },
          { id: 'expired', resetType: 'codexRateLimits', status: 'available', expiresAt: 1 },
          { id: 'first', resetType: 'codexRateLimits', status: 'available', expiresAt: 1_900_000_000 }
        ] }
      } })
    })
    expect(await probeCodex(account, ctx)).toMatchObject({ kind: 'ok', plan: 'ChatGPT Go Subscription',
      windows: [{ usedPercent: 61, kind: 'monthly' }], resetCredits: 2, nextResetCreditId: 'first',
      resetCreditsExpiresAt: '2030-03-17T17:46:40.000Z' })
    expect(methods).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
    expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), ['app-server'],
      expect.objectContaining({ shell: false, env: expect.objectContaining({ CODEX_HOME: home }) }))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('aborts and closes a pending CLI request', async () => {
    const controller = new AbortController()
    const ctx = { ...requestContext(), signal: controller.signal }
    ctx.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    const child = fakePeer(() => queueMicrotask(() => controller.abort()))
    expect(await probeCodex(account, ctx)).toEqual({ kind: 'failed' })
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('distinguishes malformed readings from subscriptions without windows', async () => {
    const ctx = requestContext()
    ctx.fetch.mockResolvedValueOnce(Response.json({ rate_limit: { primary_window: { used_percent: '4' } } }))
      .mockResolvedValueOnce(Response.json({ rate_limit: null }))
    expect(await probeCodex(account, ctx)).toEqual({ kind: 'failed' })
    expect(await probeCodex(account, ctx)).toEqual({ kind: 'unsupported' })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not launch the CLI for T3 or a manually selected alias into T3', async () => {
    const ctx = requestContext()
    ctx.fetch.mockImplementation(async () => new Response(null, { status: 401 }))
    expect(await probeCodex({ ...account, origin: 't3' }, ctx)).toEqual({ kind: 'failed' })
    mocks.realpath.mockImplementation(async (path: string) => path === home
      ? join(homedir(), '.t3', 'userdata', 'codex') : path)
    expect(await probeCodex({ ...account, origin: 'manual' }, ctx)).toEqual({ kind: 'failed' })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

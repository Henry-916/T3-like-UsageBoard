import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { createCodexResetCreditConsumer } from '../src/main/limits/codexResetCredit'
import type { LimitsProbeContext } from '../src/shared/limitsTypes'
import type { DiscoveredAccount } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(), realpath: vi.fn(), resolveCli: vi.fn()
}))
vi.mock('node:fs/promises', async importActual => ({
  ...await importActual<typeof import('node:fs/promises')>(),
  realpath: mocks.realpath, stat: vi.fn(async () => ({ isDirectory: () => true }))
}))
vi.mock('../src/main/limits/probes/cli', async importActual => ({
  ...await importActual<typeof import('../src/main/limits/probes/cli')>(),
  exchangeCli: mocks.exchange, resolveCli: mocks.resolveCli
}))

const url = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const account = (id: string, origin: DiscoveredAccount['origin'] = 'native'): DiscoveredAccount => ({
  id, origin, provider: 'codex', enabled: true, displayName: id,
  dataDir: join(process.cwd(), id), credentialPaths: [join(process.cwd(), id, 'auth.json')]
})
const context = (id?: string, token = 'fixture') => ({
  signal: new AbortController().signal,
  fetch: vi.fn<LimitsProbeContext['fetch']>(),
  readCredential: vi.fn<LimitsProbeContext['readCredential']>()
    .mockResolvedValue(token ? { tokens: { access_token: token, chatgpt_account_id: id } } : {})
})
const body = (ctx: ReturnType<typeof context>, i: number) => JSON.parse(String(ctx.fetch.mock.calls[i][1]?.body))
const credit = (id: string, expires_at: string) => ({ id, expires_at, reset_type: 'codex_rate_limits', status: 'available' })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.realpath.mockImplementation(async (path: string) => path)
  mocks.resolveCli.mockResolvedValue(join(process.cwd(), 'fixture-codex.exe'))
})

it('uses fixed HTTP endpoints and submits the earliest eligible credit without redirects', async () => {
  const ctx = context('fixture-account')
  ctx.fetch.mockResolvedValueOnce(Response.json({ credits: [
    credit('later', '2999-01-01'), credit('first', '2998-01-01'), credit('old', '2000-01-01')
  ] })).mockResolvedValueOnce(Response.json({ code: 'reset' }))
  await expect(createCodexResetCreditConsumer()(account('native'), ctx)).resolves.toBe('reset')
  expect(ctx.fetch.mock.calls.map(([path]) => path)).toEqual([url, `${url}/consume`])
  expect(ctx.fetch.mock.calls[1][1]).toMatchObject({
    method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
    headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json',
      'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop', 'Chatgpt-Account-Id': 'fixture-account' }
  })
  expect(body(ctx, 1)).toEqual({ credit_id: 'first', redeem_request_id: expect.stringMatching(/^[a-f0-9-]{36}$/) })
})

it.each(['network', 503, 408, 429, 'invalid-success'])('pins ID and key across an ambiguous %s response', async issue => {
  const consume = createCodexResetCreditConsumer()
  const ctx = context('fixture-account')
  if (issue === 'network') ctx.fetch.mockRejectedValueOnce(new TypeError('fixture network failure'))
  else if (issue === 'invalid-success') ctx.fetch.mockResolvedValueOnce(Response.json({}))
  else ctx.fetch.mockResolvedValueOnce(new Response(null, { status: Number(issue) }))
  ctx.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ code: 'already_redeemed' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ code: 'nothing_to_reset' }))
  await expect(consume(account('native'), ctx, 'first')).rejects.toThrow()
  await expect(consume(account('alias', 'manual'), ctx, 'second')).rejects.toThrow()
  await expect(consume(account('alias', 'manual'), ctx, 'second')).resolves.toBe('alreadyRedeemed')
  await expect(consume(account('native'), ctx, 'second')).resolves.toBe('nothingToReset')
  expect(body(ctx, 1)).toEqual(body(ctx, 0))
  expect(body(ctx, 2)).toEqual(body(ctx, 0))
  expect(body(ctx, 3)).toMatchObject({ credit_id: 'second' })
  expect(body(ctx, 3).redeem_request_id).not.toBe(body(ctx, 0).redeem_request_id)
  expect(mocks.exchange).not.toHaveBeenCalled()
})

it('does not submit when no eligible ticket exists and clears the key after a definitive HTTP rejection', async () => {
  const consume = createCodexResetCreditConsumer()
  const ctx = context()
  ctx.fetch.mockResolvedValueOnce(Response.json({ credits: [] }))
    .mockResolvedValueOnce(Response.json({}, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ code: 'no_credit' }))
  await expect(consume(account('native'), ctx)).resolves.toBe('noCredit')
  await expect(consume(account('native'), ctx, 'first')).rejects.toThrow()
  await expect(consume(account('native'), ctx, 'second')).resolves.toBe('noCredit')
  expect(body(ctx, 2).redeem_request_id).not.toBe(body(ctx, 1).redeem_request_id)
})

it('blocks retry under a different token when no OAuth account ID can confirm the identity', async () => {
  const consume = createCodexResetCreditConsumer()
  const original = context()
  const replacement = context(undefined, 'different-token')
  original.fetch.mockRejectedValueOnce(new TypeError('fixture network failure'))
    .mockResolvedValueOnce(Response.json({ code: 'reset' }))
  await expect(consume(account('native'), original, 'first')).rejects.toThrow()
  await expect(consume(account('native'), replacement, 'second')).rejects.toThrow()
  expect(replacement.fetch).not.toHaveBeenCalled()
  await expect(consume(account('native'), original, 'second')).resolves.toBe('reset')
  expect(body(original, 1)).toEqual(body(original, 0))
})

it('serializes the same canonical directory across origins even if only one has an OAuth ID', async () => {
  mocks.realpath.mockImplementation(async (path: string) => path === account('alias').dataDir
    ? account('native').dataDir : path)
  const consume = createCodexResetCreditConsumer()
  const ctx1 = context('fixture-account')
  const ctx2 = context()
  let finish!: (response: Response) => void
  let started!: () => void
  const firstStarted = new Promise<void>(resolve => { started = resolve })
  ctx1.fetch.mockImplementationOnce(async () => {
    started()
    return new Promise<Response>(resolve => { finish = resolve })
  })
  ctx2.fetch.mockResolvedValueOnce(Response.json({ code: 'reset' }))
  const first = consume(account('native'), ctx1, 'first')
  await firstStarted
  const second = consume(account('alias', 'manual'), ctx2, 'second')
  await new Promise(resolve => setImmediate(resolve))
  expect(ctx2.fetch).not.toHaveBeenCalled()
  finish(Response.json({ code: 'reset' }))
  await expect(Promise.all([first, second])).resolves.toEqual(['reset', 'reset'])
})

function scriptCli(reply: boolean) {
  const frames: object[] = []
  mocks.exchange.mockImplementationOnce(async (_executable, _args, _env, _signal, start, receive) => {
    frames.push(start)
    const send = (frame: object) => frames.push(frame)
    receive({ id: 1, result: {} }, send)
    if (frames.some(frame => 'id' in frame && frame.id === 3)) {
      receive({ id: 3, result: { rateLimitResetCredits: [{ id: 'first',
        resetType: 'codexRateLimits', status: 'available', expiresAt: 32_473_353_600 }] } }, send)
    }
    if (reply) return receive({ id: 2, result: { outcome: 'reset' } }, send)
  })
  return frames
}

it('only falls back on an initial 401 with the same key and exact ticket', async () => {
  const ctx = context('fixture-account')
  ctx.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
  const frames = scriptCli(true)
  await expect(createCodexResetCreditConsumer()(account('native'), ctx, 'first')).resolves.toBe('reset')
  expect(frames).toEqual([
    { id: 1, method: 'initialize', params: { clientInfo: { name: 't3-like-usageboard', version: expect.any(String) } } },
    { method: 'initialized' },
    { id: 2, method: 'account/rateLimitResetCredit/consume',
      params: { idempotencyKey: body(ctx, 0).redeem_request_id, creditId: 'first' } }
  ])
  expect(mocks.exchange).toHaveBeenCalledWith(expect.any(String), ['app-server'],
    expect.objectContaining({ CODEX_HOME: account('native').dataDir }), expect.any(AbortSignal),
    expect.any(Object), expect.any(Function))
})

it('looks up the ticket on CLI-only accounts and stays on CLI after ambiguous submission', async () => {
  const consume = createCodexResetCreditConsumer()
  const ctx = context(undefined, '')
  const first = scriptCli(false)
  await expect(consume(account('native'), ctx)).rejects.toThrow()
  expect(first[2]).toEqual({ id: 3, method: 'account/rateLimits/read', params: null })
  const second = scriptCli(true)
  const withOAuth = context('fixture-account')
  await expect(consume(account('native'), withOAuth, 'different')).resolves.toBe('reset')
  expect(second[2]).toEqual(first[3])
  expect(second[2]).toMatchObject({ params: { creditId: 'first' } })
  expect(withOAuth.fetch).not.toHaveBeenCalled()
})

it('never invokes CLI for a native/manual directory aliased into T3', async () => {
  const consume = createCodexResetCreditConsumer()
  const ctx = context(undefined, '')
  mocks.realpath.mockImplementation(async (path: string) => path === account('alias').dataDir
    ? join(homedir(), '.t3', 'userdata', 'codex') : path)
  await expect(consume(account('alias', 'manual'), ctx, 'first')).rejects.toThrow('请在 T3 Code 中重新登录')
  expect(mocks.resolveCli).not.toHaveBeenCalled()
  expect(mocks.exchange).not.toHaveBeenCalled()
  expect(ctx.fetch).not.toHaveBeenCalled()
})

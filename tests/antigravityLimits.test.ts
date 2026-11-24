import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  createAntigravityProbe, probeAntigravity, waitForAntigravityRenewals, type CliRenewParams
} from '../src/main/limits/probes/antigravity'
import { antigravityTokenKey, createAntigravityTokenCache } from '../src/main/limits/antigravityTokenCache'
import type { DiscoveredAccount } from '../src/shared/types'

const account: DiscoveredAccount = {
  id: 'fake-ag', provider: 'antigravity', origin: 't3', enabled: true, displayName: 'Fake',
  credentialPaths: ['antigravity-oauth-token', 'acp_token.json']
}

it('refreshes ACP in memory, merges business-first quotas, and hashes the Google identity', async () => {
  const signal = new AbortController().signal
  const readCredential = vi.fn(async () => ({
    client_id: 'fake-client', client_secret: 'fake-secret', refresh_token: 'fake-refresh', project_id: 'fake-project'
  }))
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input))
    expect(init?.redirect).toBe('error')
    if (url.pathname !== '/oauth2/v2/userinfo') expect(init?.signal).toBe(signal)
    if (url.href === 'https://oauth2.googleapis.com/token') {
      expect(init?.method).toBe('POST')
      expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
        client_id: 'fake-client', client_secret: 'fake-secret', refresh_token: 'fake-refresh', grant_type: 'refresh_token'
      })
      return Response.json({ access_token: 'fake-access', expires_in: 3600 })
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-access')
    if (url.href === 'https://www.googleapis.com/oauth2/v2/userinfo') return Response.json({ id: 'fake-google-id' })
    expect(init?.body).toBe('{"project":"fake-project"}')
    expect(new Headers(init?.headers).get('user-agent')).toContain('antigravity/hub/2.24.0')
    const common = { bucketId: 'gemini-argon-rolling', window: '5h' }
    if (url.href === 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary') {
      return Response.json({ groups: [{ displayName: 'Argon Pro', buckets: [{ ...common, remainingFraction: 0.25 }] }] })
    }
    expect(url.href).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary')
    return Response.json({ buckets: [
      { ...common, remainingFraction: 0.75 },
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5 },
      { bucketId: 'gemini-carbon-rolling', window: '5h', remainingFraction: 0, disabled: true }
    ] })
  })
  const business: DiscoveredAccount = { ...account, limitsEnv: { ANTIGRAVITY_AUTH_METHOD: 'oauth-business' } }
  const ctx = { readCredential, fetch, signal }
  const result = await probeAntigravity(business, ctx)
  expect(result).toEqual({
    kind: 'ok', fingerprint: createHash('sha256').update('google-account\0fake-google-id').digest('hex'),
    windows: [
      { id: 'gemini-argon-rolling', label: 'Argon Pro · 5-hour', kind: 'session', usedPercent: 75, windowDurationMins: 300 },
      { id: '3p-weekly', label: 'Claude & GPT (shared) · Weekly', kind: 'weekly', usedPercent: 50, windowDurationMins: 10080 }
    ]
  })
  expect(readCredential.mock.calls).toEqual([['acp_token.json']])
  expect(await probeAntigravity(business, ctx)).toEqual(result)
  expect(fetch.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(1)
})

it('uses the unexpired CLI file when ACP is missing, falling back to model quotas without inventing cadence', async () => {
  const readCredential = async (path: string): Promise<unknown> => {
    if (path === 'acp_token.json') throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
    return { token: { access_token: 'fake-cli', expiry: '2099-01-01T00:00:00Z' } }
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-cli')
    if (String(input).endsWith(':retrieveUserQuotaSummary')) return Response.json({})
    if (String(input) === 'https://www.googleapis.com/oauth2/v2/userinfo') return new Response(null, { status: 403 })
    expect(String(input)).toMatch(/^https:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com\/v1internal:fetchAvailableModels$/)
    return Response.json({ models: {
      'gemini-a': { quotaInfo: { remainingFraction: 0.5 } },
      'gemini-b': { quotaInfo: { remainingFraction: 0.25 }, weeklyQuotaInfo: { remainingFraction: 1 } }
    } })
  })
  expect(await probeAntigravity(account, { readCredential, fetch, signal: new AbortController().signal })).toEqual({
    kind: 'ok',
    fingerprint: createHash('sha256').update('antigravity-cli\0fake-cli').digest('hex'),
    windows: [
      { id: 'gemini-quota', label: 'Gemini · Reported quota', kind: 'other', usedPercent: 75, modelIds: ['gemini-a', 'gemini-b'] },
      { id: 'gemini-weekly', label: 'Gemini · Weekly', kind: 'weekly', usedPercent: 0, windowDurationMins: 10080, modelIds: ['gemini-b'] }
    ]
  })
})

it('bounds userinfo independently and keeps successful windows with a stable credential fingerprint', async () => {
  vi.useFakeTimers()
  try {
    const signal = new AbortController().signal
    let identitySignal: AbortSignal | null | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        const client = (init?.body as URLSearchParams).get('client_id')
        return Response.json({ access_token: `fake-access-${client}`, expires_in: 3600 })
      }
      if (String(input) === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        identitySignal = init?.signal
        return new Promise<Response>(() => {}) // Even a fetch stub that ignores abort cannot delay the result.
      }
      return Response.json({ buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 }] })
    })
    const probe = async (client_id: string, refresh_token: string) => {
      const result = probeAntigravity(account, {
        fetch, signal, readCredential: async () => ({ client_id, client_secret: 'fake-secret', refresh_token })
      })
      await vi.advanceTimersByTimeAsync(1500)
      return result
    }
    const expected = {
      kind: 'ok',
      fingerprint: createHash('sha256').update('antigravity-acp\0fake-refresh-a').digest('hex'),
      windows: [{ id: 'gemini-weekly', kind: 'weekly', label: 'Gemini · Weekly', usedPercent: 50, windowDurationMins: 10080 }]
    }
    expect(await probe('fake-client-a', 'fake-refresh-a')).toEqual(expected)
    expect(identitySignal?.aborted).toBe(true)
    expect(signal.aborted).toBe(false)
    expect(await probe('fake-client-b', 'fake-refresh-a')).toEqual(expected)
    expect(await probe('fake-client-c', 'fake-refresh-b')).toMatchObject({
      kind: 'ok', fingerprint: createHash('sha256').update('antigravity-acp\0fake-refresh-b').digest('hex')
    })
  } finally {
    vi.useRealTimers()
  }
})

it('does not send expired credentials or start after cancellation', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  const readCredential = vi.fn(async () => ({ token: { access_token: 'fake-expired', expiry: '2000-01-01T00:00:00Z' } }))
  expect(await probeAntigravity({ ...account, credentialPaths: ['antigravity-oauth-token'] }, {
    fetch, readCredential, signal: new AbortController().signal
  })).toEqual({ kind: 'failed', reason: 'expired' })
  readCredential.mockClear()
  expect(await probeAntigravity(account, { fetch, readCredential, signal: AbortSignal.abort() })).toEqual({ kind: 'failed' })
  expect(fetch).not.toHaveBeenCalled()
  expect(readCredential).not.toHaveBeenCalled()
})

const cliAccount = { ...account, credentialPaths: ['synthetic-antigravity'] }
const validUntil = '2099-01-01T00:00:00Z'
const cliFixture = {
  auth_method: 'oauth-business',
  extra: 'synthetic-extra',
  token: { access_token: 'synthetic-stale', refresh_token: 'synthetic-source', token_type: 'Bearer' }
}
const renewed = {
  accessToken: 'synthetic-new', refreshToken: 'synthetic-rotated',
  expiry: validUntil, updatedAt: Date.now()
}
const cliContext = (status: (token: string | null, url: string) => number = () => 200) => ({
  readCredential: async () => cliFixture,
  signal: new AbortController().signal,
  fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const code = status(new Headers(init?.headers).get('authorization'), String(input))
    return code === 200 ? Response.json({ buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.5 }] })
      : new Response(null, { status: code })
  })
})

it('serializes across instances, double-checks the cache and skips canceled queued work', async () => {
  const tokenCache = createAntigravityTokenCache()
  const resolveCli = vi.fn(async () => 'synthetic-agy')
  let complete!: () => void
  const gate = new Promise<void>(resolve => { complete = resolve })
  const renewCliToken = vi.fn(async (params: CliRenewParams) => {
    expect(params).toMatchObject({
      executable: 'synthetic-agy', authMethod: 'oauth-business', stored: cliFixture, refreshToken: 'synthetic-source'
    })
    await gate
    return { kind: 'ok', token: renewed } as const
  })
  const deps = { tokenCache, resolveCli, renewCliToken, getScanT3: async () => false }
  const probe = createAntigravityProbe(deps)
  const first = probe(cliAccount, cliContext())
  await vi.waitFor(() => expect(renewCliToken).toHaveBeenCalledTimes(1))
  expect(resolveCli).toHaveBeenCalledWith({ scanT3: false })
  const next = createAntigravityProbe(deps)(cliAccount, cliContext())
  const controller = new AbortController()
  const canceled = probe({ ...cliAccount, credentialPaths: ['other-synthetic-account'] },
    { ...cliContext(), signal: controller.signal })
  controller.abort()
  expect(await canceled).toEqual({ kind: 'failed' })
  let drained = false
  const drain = waitForAntigravityRenewals().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  complete()
  await drain
  expect(await first).toMatchObject({ kind: 'ok' })
  expect(await next).toMatchObject({ kind: 'ok' })
  expect(await probe(cliAccount, cliContext())).toMatchObject({ kind: 'ok' })
  expect(renewCliToken).toHaveBeenCalledTimes(1)
})

it('renews rejected cached access once and keeps the rotated refresh token through transient errors', async () => {
  const tokenCache = createAntigravityTokenCache()
  const key = await antigravityTokenKey(cliAccount.credentialPaths[0], cliFixture.token.refresh_token)
  await tokenCache.set(key, renewed)
  const renewCliToken = vi.fn<(params: CliRenewParams) => Promise<{ kind: 'failed' | 'expired' }>>()
    .mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValueOnce({ kind: 'expired' })
  const probe = createAntigravityProbe({ tokenCache, resolveCli: async () => 'synthetic-agy', renewCliToken })
  expect(await probe(cliAccount, cliContext(() => 401))).toEqual({ kind: 'failed' })
  expect(renewCliToken).toHaveBeenCalledTimes(1)
  expect(renewCliToken.mock.calls[0][0].refreshToken).toBe(renewed.refreshToken)
  expect(await tokenCache.getValid(key)).toBeUndefined()
  expect((await tokenCache.getEntry(key))?.refreshToken).toBe(renewed.refreshToken)
  expect(await probe(cliAccount, cliContext(() => 401))).toEqual({ kind: 'failed', reason: 'expired' })
  expect(await tokenCache.getEntry(key)).toBeUndefined()
})

it('retries quotas with new access after all 401s but not mixed endpoint failures', async () => {
  const renewCliToken = vi.fn(async () => ({ kind: 'ok', token: renewed } as const))
  const probe = createAntigravityProbe({ resolveCli: async () => 'synthetic-agy', renewCliToken })
  const readCredential = async () => ({ ...cliFixture, token: { ...cliFixture.token, expiry: validUntil } })
  expect(await probe(cliAccount, { ...cliContext((_token, url) => url.includes('daily-') ? 403 : 401), readCredential }))
    .toEqual({ kind: 'failed' })
  expect(renewCliToken).not.toHaveBeenCalled()
  expect(await probe(cliAccount, { ...cliContext(token => token === 'Bearer synthetic-new' ? 200 : 401), readCredential }))
    .toMatchObject({ kind: 'ok' })
  expect(renewCliToken).toHaveBeenCalledTimes(1)
})

it('reports unavailable native CLI without fetching stale credentials', async () => {
  const ctx = cliContext()
  const probe = createAntigravityProbe({ resolveCli: async () => undefined })
  expect(await probe(cliAccount, ctx)).toEqual({ kind: 'failed', reason: 'cli_missing' })
  expect(ctx.fetch).not.toHaveBeenCalled()
})

it('maps the stored consumer auth label to ACP oauth-personal without rewriting the credential', async () => {
  const renewCliToken = vi.fn(async (_params: CliRenewParams) => ({ kind: 'ok', token: renewed } as const))
  const probe = createAntigravityProbe({ resolveCli: async () => 'synthetic-agy', renewCliToken })
  const stored = { ...cliFixture, auth_method: 'consumer' }
  expect(await probe(cliAccount, { ...cliContext(), readCredential: async () => stored })).toMatchObject({ kind: 'ok' })
  expect(renewCliToken.mock.calls[0][0]).toMatchObject({ authMethod: 'oauth-personal', stored })
})

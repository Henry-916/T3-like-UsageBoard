import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { probeAntigravity } from '../src/main/limits/probes/antigravity'
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
  })).toEqual({ kind: 'failed' })
  readCredential.mockClear()
  expect(await probeAntigravity(account, { fetch, readCredential, signal: AbortSignal.abort() })).toEqual({ kind: 'failed' })
  expect(fetch).not.toHaveBeenCalled()
  expect(readCredential).not.toHaveBeenCalled()
})

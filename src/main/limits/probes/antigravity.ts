// Adapted from T3 Code (MIT), Copyright (c) 2026 T3 Tools Inc.
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { LimitsProbeContext, LimitsProbeResult, LimitWindow } from '../../../shared/limitsTypes'
import type { DiscoveredAccount } from '../../../shared/types'

const daily = 'https://daily-cloudcode-pa.googleapis.com'
const production = 'https://cloudcode-pa.googleapis.com'
const userAgent = `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`
const text = z.string().trim().min(1)
const acpToken = z.object({
  client_id: text, client_secret: text, refresh_token: text, project_id: text.optional()
})
const cliToken = z.object({ token: z.object({ access_token: text, refresh_token: z.string().trim().optional(), expiry: text }) })
const refreshResponse = z.object({ access_token: text, expires_in: z.number().positive() })
const userInfo = z.object({ id: text })
const cache = new Map<string, { accessToken: string; expiresAt: number }>()
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const quota = z.object({ remainingFraction: z.number().optional(), resetTime: z.string().optional() })
const bucket = quota.extend({
  bucketId: text, window: z.string().optional(), displayName: z.string().optional(),
  description: z.string().optional(), disabled: z.boolean().optional()
})
const summary = z.object({
  groups: z.array(z.object({ displayName: z.string().optional(), buckets: z.array(bucket).optional() })).optional(),
  buckets: z.array(bucket).optional()
})
const models = z.object({
  models: z.record(z.string(), z.object({
    modelProvider: z.string().optional(), quotaInfo: quota.optional(), weeklyQuotaInfo: quota.optional()
  }))
})

function makeWindow(
  id: string, label: string, reading: z.infer<typeof quota>, kind: LimitWindow['kind'],
  windowDurationMins?: number
): LimitWindow | undefined {
  if (reading.remainingFraction === undefined) return undefined
  const reset = Date.parse(reading.resetTime ?? '')
  return {
    id, label, kind,
    usedPercent: (1 - Math.max(0, Math.min(1, reading.remainingFraction))) * 100,
    ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {})
  }
}

function summaryWindows(body: unknown, requestedAt: number): LimitWindow[] {
  const { groups, buckets } = summary.parse(body)
  const windows = new Map<string, LimitWindow>()
  for (const group of groups?.some(group => group.buckets?.length) ? groups : [{ displayName: undefined, buckets }]) {
    for (const reading of group.buckets ?? []) {
      if (reading.disabled) continue
      const id = reading.bucketId
      const groupLabel = group.displayName?.trim()
      const family = id.startsWith('gemini-argon-') ? groupLabel || 'Gemini Argon'
        : id.startsWith('gemini-carbon-') ? groupLabel || 'Gemini Carbon'
        : id.startsWith('gemini-') ? 'Gemini'
        : id.startsWith('3p-') ? 'Claude & GPT (shared)' : groupLabel || id
      const kind = reading.window === 'weekly' ? 'weekly' : reading.window === '5h' ? 'session' : 'other'
      const label = kind === 'weekly' ? 'Weekly' : kind === 'session' ? '5-hour' : reading.displayName?.trim() || 'Quota'
      const duration = kind === 'weekly' ? 10080 : kind === 'session' ? 300 : undefined
      const untouched = duration !== undefined && reading.remainingFraction === 1 && reading.description === undefined &&
        Math.abs(Date.parse(reading.resetTime ?? '') - requestedAt - duration * 60_000) <= 60_000
      const window = makeWindow(id, `${family} · ${label}`, untouched ? { remainingFraction: 1 } : reading, kind, duration)
      if (window) windows.set(id, window)
    }
  }
  return [...windows.values()]
}

function modelWindows(body: unknown): LimitWindow[] {
  const windows = new Map<string, LimitWindow>()
  for (const [id, model] of Object.entries(models.parse(body).models)) {
    const family = model.modelProvider === 'MODEL_PROVIDER_GOOGLE' || id.startsWith('gemini-') ? 'Gemini'
      : model.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || id.startsWith('claude-') ? 'Claude'
      : model.modelProvider === 'MODEL_PROVIDER_OPENAI' || id.startsWith('gpt-') ? 'GPT' : undefined
    if (!family) continue
    for (const [suffix, reading] of [['quota', model.quotaInfo], ['weekly', model.weeklyQuotaInfo]] as const) {
      if (!reading) continue
      const weekly = suffix === 'weekly'
      const window = makeWindow(`${family.toLowerCase()}-${suffix}`, `${family} · ${weekly ? 'Weekly' : 'Reported quota'}`,
        reading, weekly ? 'weekly' : 'other', weekly ? 10080 : undefined)
      if (!window) continue
      const previous = windows.get(window.id)
      const mostUsed = !previous || window.usedPercent > previous.usedPercent ? window : previous
      windows.set(window.id, { ...mostUsed, modelIds: [...(previous?.modelIds ?? []), id] })
    }
  }
  return [...windows.values()]
}

export async function probeAntigravity(account: DiscoveredAccount, ctx: LimitsProbeContext): Promise<LimitsProbeResult> {
  async function request(url: string, init: RequestInit, signal = ctx.signal): Promise<unknown> {
    signal.throwIfAborted()
    const response = await ctx.fetch(url, { ...init, redirect: 'error', signal })
    if (!response.ok) throw new Error('Antigravity request failed')
    return response.json()
  }

  try {
    ctx.signal.throwIfAborted()
    const method = account.limitsEnv?.ANTIGRAVITY_AUTH_METHOD
    if (method && method !== 'oauth-personal' && method !== 'oauth-business') return { kind: 'unsupported' }
    const paths = account.credentialPaths ?? []
    const isAcp = (path: string): boolean => basename(path).toLowerCase() === 'acp_token.json'
    let stored: unknown
    for (const path of [...paths.filter(isAcp), ...paths.filter(path => !isAcp(path))]) {
      stored = await ctx.readCredential(path).catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'ENOENT') throw error
      })
      ctx.signal.throwIfAborted()
      if (stored != null) break
    }
    if (stored == null) return { kind: 'unsupported' }

    let accessToken: string
    let project: string | undefined
    let credentialFingerprint: string
    const acp = acpToken.safeParse(stored)
    if (acp.success) {
      const { client_id, client_secret, refresh_token, project_id } = acp.data
      project = project_id
      credentialFingerprint = sha256(`antigravity-acp\0${refresh_token}`)
      const key = sha256(JSON.stringify([client_id, client_secret, refresh_token, project]))
      const now = Date.now()
      for (const [cachedKey, value] of cache) if (value.expiresAt <= now + 60_000) cache.delete(cachedKey)
      const cached = cache.get(key)
      if (cached) {
        accessToken = cached.accessToken
      } else {
        const refreshed = refreshResponse.parse(await request('https://oauth2.googleapis.com/token', {
          method: 'POST', body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' })
        }))
        ctx.signal.throwIfAborted()
        accessToken = refreshed.access_token
        cache.set(key, { accessToken, expiresAt: now + refreshed.expires_in * 1000 })
      }
    } else if (typeof stored === 'string') {
      accessToken = text.regex(/^[A-Za-z0-9\-._~+/]+=*$/).parse(stored)
      credentialFingerprint = sha256(`antigravity-cli\0${accessToken}`)
    } else {
      const { token } = cliToken.parse(stored)
      if (!(Date.parse(token.expiry) > Date.now() + 60_000)) return { kind: 'failed' }
      accessToken = token.access_token
      credentialFingerprint = sha256(`antigravity-cli\0${token.refresh_token || accessToken}`)
    }

    const headers = { Authorization: `Bearer ${accessToken}` }
    const identityController = new AbortController()
    const identitySignal = AbortSignal.any([ctx.signal, identityController.signal])
    let identityTimer: ReturnType<typeof setTimeout> | undefined
    const identityTimeout = new Promise<string>(resolve => {
      identityTimer = setTimeout(() => {
        identityController.abort()
        resolve(credentialFingerprint)
      }, 1500)
    })
    const fingerprint = Promise.race([
      request('https://www.googleapis.com/oauth2/v2/userinfo', { headers }, identitySignal)
        .then(body => sha256(`google-account\0${userInfo.parse(body).id}`)).catch(() => credentialFingerprint),
      identityTimeout
    ]).finally(() => clearTimeout(identityTimer))
    const endpoints = method === 'oauth-business' ? [production, daily] : [daily, production]
    const fetchWindows = async (
      operation: 'retrieveUserQuotaSummary' | 'fetchAvailableModels',
      parse: (body: unknown, requestedAt: number) => LimitWindow[]
    ): Promise<LimitWindow[]> => {
      const results = await Promise.all(endpoints.map(async endpoint => {
        try {
          const requestedAt = Date.now()
          const body = await request(`${endpoint}/v1internal:${operation}`, {
            method: 'POST',
            headers: { ...headers, 'User-Agent': userAgent, 'Content-Type': 'application/json' },
            body: JSON.stringify(project ? { project } : {})
          })
          return parse(body, requestedAt)
        } catch {
          return []
        }
      }))
      ctx.signal.throwIfAborted()
      const merged = new Map<string, LimitWindow>()
      for (const window of results.flat()) if (!merged.has(window.id)) merged.set(window.id, window)
      return [...merged.values()]
    }
    let windows = await fetchWindows('retrieveUserQuotaSummary', summaryWindows)
    if (!windows.length) windows = await fetchWindows('fetchAvailableModels', modelWindows)
    if (!windows.length) {
      identityController.abort()
      return { kind: 'failed' }
    }
    const identity = await fingerprint
    ctx.signal.throwIfAborted()
    return { kind: 'ok', windows, fingerprint: identity }
  } catch {
    return { kind: 'failed' }
  }
}

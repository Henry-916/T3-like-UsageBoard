import type { LimitsProbeContext, LimitsProbeResult, LimitWindow } from '../../../shared/limitsTypes'
import type { DiscoveredAccount } from '../../../shared/types'
import { APP_VERSION } from '../../../shared/version'
import { clamp, cliEnvironment, credentialCandidates, exchangeCli, fingerprint, iso, number, record, resolveCli, safeCliHome, text } from './cli'

const BASE = 'https://chatgpt.com/backend-api/wham'
const WEEK = 7 * 24 * 60
const MONTH = 30 * 24 * 60

const PLANS = new Map([
  ['free', 'Free'], ['go', 'Go'], ['plus', 'Plus'], ['pro', 'Pro 200'],
  ['prolite', 'Pro 100'], ['promax', 'Pro 500'], ['self_serve_business_prolite', 'Business Premium'],
  ['team', 'Business'], ['self_serve_business_usage_based', 'Business'], ['business', 'Business'],
  ['ent26', 'Enterprise'], ['enterprise_cbp_automation', 'Enterprise'],
  ['enterprise_cbp_usage_based', 'Enterprise'], ['enterprise', 'Enterprise'],
  ['edu', 'Edu'], ['edu_plus', 'Edu'], ['edu_pro', 'Edu']
])

export function codexPlanLabel(planType: string | undefined): string | undefined {
  if (!planType?.trim()) return
  if (planType === 'unknown') return 'ChatGPT Subscription'
  const name = PLANS.get(planType)
  return name ? `ChatGPT ${name} Subscription` : planType
}

export const CODEX_CREDITS_URL = `${BASE}/rate-limit-reset-credits`

export function codexResetCredits(value: unknown, cli: boolean) {
  if (!Array.isArray(value)) return
  const now = Date.now()
  const available = value.flatMap(raw => {
    const credit = record(raw)
    if (credit?.status !== 'available' ||
        credit[cli ? 'resetType' : 'reset_type'] !== (cli ? 'codexRateLimits' : 'codex_rate_limits')) return []
    const expires = cli ? (number(credit.expiresAt) ?? 0) * 1000 : Date.parse(text(credit.expires_at) ?? '')
    return expires > now && iso(expires) ? [{ expires, id: text(credit.id) }] : []
  }).sort((a, b) => a.expires - b.expires)
  const first = available[0]
  return { resetCredits: available.length,
    ...(first ? { resetCreditsExpiresAt: iso(first.expires) } : {}),
    ...(first?.id ? { nextResetCreditId: first.id } : {}) }
}

function epoch(value: unknown): string | undefined {
  const seconds = number(value)
  if (seconds !== undefined && seconds > 0) return iso(seconds * 1000)
}

function window(id: string, raw: unknown, fallbackMins: number, cli: boolean): LimitWindow | undefined {
  const row = record(raw)
  const used = number(cli ? row?.usedPercent : row?.used_percent)
  if (used === undefined) return
  const minutes = cli ? number(row?.windowDurationMins) : (number(row?.limit_window_seconds) ?? 0) / 60
  const windowDurationMins = minutes && minutes > 0 ? minutes : fallbackMins
  const kind = windowDurationMins >= MONTH ? 'monthly' : windowDurationMins >= WEEK ? 'weekly' : 'session'
  const resetsAt = epoch(cli ? row?.resetsAt : row?.reset_at)
  return { id, kind, label: kind === 'monthly' ? 'Monthly' : kind === 'weekly' ? 'Weekly' : 'Session',
    usedPercent: clamp(used), windowDurationMins, ...(resetsAt ? { resetsAt } : {}) }
}

function windowsFrom(snapshot: Record<string, unknown>, plan: string | undefined, cli: boolean): LimitWindow[] {
  const windows = [
    window('primary', snapshot[cli ? 'primary' : 'primary_window'], plan === 'free' || plan === 'go' ? MONTH : 300, cli),
    window('secondary', snapshot[cli ? 'secondary' : 'secondary_window'], WEEK, cli)
  ].filter((row): row is LimitWindow => !!row)
  const individual = record(snapshot.individualLimit)
  const remaining = number(individual?.remainingPercent)
  if (cli && remaining !== undefined) {
    const resetsAt = epoch(individual?.resetsAt)
    windows.push({ id: 'individual', kind: 'monthly', label: 'Monthly credit limit',
      usedPercent: clamp(100 - remaining), ...(resetsAt ? { resetsAt } : {}) })
  }
  return windows
}

async function readCredits(ctx: LimitsProbeContext, request: RequestInit) {
  try {
    const response = await ctx.fetch(CODEX_CREDITS_URL, request)
    if (!response.ok) { await response.body?.cancel(); return }
    return codexResetCredits(record(await response.json())?.credits, false)
  } catch { return undefined }
}

async function fromCli(
  account: DiscoveredAccount, ctx: LimitsProbeContext, hadOAuth: boolean, accountId?: string
): Promise<LimitsProbeResult> {
  const unavailable = { kind: hadOAuth ? 'failed' : 'unsupported' } as const
  const dataDir = await safeCliHome(account)
  if (!dataDir || ctx.signal.aborted) return ctx.signal.aborted ? { kind: 'failed' } : unavailable
  const executable = await resolveCli('codex')
  if (!executable) return unavailable
  let step = 1
  return await exchangeCli<LimitsProbeResult>(
    executable, ['app-server'], cliEnvironment('CODEX_HOME', dataDir), ctx.signal,
    { id: 1, method: 'initialize', params: { clientInfo: { name: 't3-like-usageboard', version: APP_VERSION } } },
    (frame, send) => {
      if (frame.id !== step) return
      const result = record(frame.result)
      if (!result || frame.error) return { kind: 'failed' }
      if (step === 1) {
        step = 2
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/rateLimits/read', params: null })
        return
      }
      const snapshot = record(record(result.rateLimitsByLimitId)?.codex) ?? record(result.rateLimits)
      if (!snapshot) return { kind: 'failed' }
      if (snapshot.limitId && snapshot.limitId !== 'codex') return unavailable
      const plan = text(snapshot.planType)
      const windows = windowsFrom(snapshot, plan, true)
      if (!windows.length) return snapshot.primary != null || snapshot.secondary != null
        ? { kind: 'failed' } : unavailable
      const hash = fingerprint(text(result.accountId) ?? accountId)
      const summary = record(result.rateLimitResetCredits)
      const advertised = number(summary?.availableCount)
      const credits = codexResetCredits(summary?.credits ?? result.rateLimitResetCredits, true)
      const label = codexPlanLabel(plan)
      return { kind: 'ok', windows, ...(label ? { plan: label } : {}), ...(hash ? { fingerprint: hash } : {}),
        ...(credits ?? (advertised !== undefined ? { resetCredits: Math.max(0, Math.floor(advertised)) } : {})) }
    }
  ) ?? { kind: 'failed' }
}

export async function probeCodex(account: DiscoveredAccount, ctx: LimitsProbeContext): Promise<LimitsProbeResult> {
  try {
    let apiKeyOnly = Boolean(ctx.manualApiKey)
    for (const path of credentialCandidates(account)) {
      ctx.signal.throwIfAborted()
      const file = record(await ctx.readCredential(path).catch(() => undefined))
      const tokens = record(file?.tokens)
      const token = text(tokens?.access_token)
      apiKeyOnly ||= Boolean(text(file?.OPENAI_API_KEY))
      if (!token) continue
      const accountId = text(tokens?.account_id) ?? text(tokens?.chatgpt_account_id)
      const request = {
        signal: ctx.signal, redirect: 'error' as const,
        headers: { Authorization: `Bearer ${token}`, 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop',
          ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}) }
      }
      const response = await ctx.fetch(`${BASE}/usage`, request)
      if (!response.ok) {
        await response.body?.cancel()
        return response.status === 401 ? await fromCli(account, ctx, true, accountId) : { kind: 'failed' }
      }
      const usage = record(await response.json())
      if (!usage) return { kind: 'failed' }
      if (usage.rate_limit === null) return { kind: 'unsupported' }
      const snapshot = record(usage.rate_limit)
      if (!snapshot) return { kind: 'failed' }
      const plan = text(usage.plan_type)
      const windows = windowsFrom(snapshot, plan, false)
      if (!windows.length) return snapshot.primary_window != null || snapshot.secondary_window != null
        ? { kind: 'failed' } : { kind: 'unsupported' }
      const hash = fingerprint(accountId ?? text(usage.account_id))
      const credits = await readCredits(ctx, request)
      const label = codexPlanLabel(plan)
      ctx.signal.throwIfAborted()
      return { kind: 'ok', windows, ...(label ? { plan: label } : {}), ...(hash ? { fingerprint: hash } : {}), ...credits }
    }
    if (apiKeyOnly) return { kind: 'unsupported' }
    return await fromCli(account, ctx, false)
  } catch { return { kind: 'failed' } }
}

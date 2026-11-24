import type { LimitsProbeContext, LimitsProbeResult, LimitWindow } from '../../../shared/limitsTypes'
import type { DiscoveredAccount } from '../../../shared/types'
import { clamp, cliEnvironment, credentialCandidates, exchangeCli, fingerprint, iso, number, record, resolveCli, safeCliHome, text } from './cli'

const WEEK = 7 * 24 * 60

function parseWindows(usage: Record<string, unknown>): LimitsProbeResult {
  const windows = new Map<string, LimitWindow>()
  let invalid = false
  function add(id: string, kind: LimitWindow['kind'], label: string, percent: unknown, reset?: unknown,
    windowDurationMins?: number, modelIds?: string[]): void {
    if (percent == null) return
    const used = number(percent)
    if (used === undefined) { invalid = true; return }
    const resetsAt = iso(text(reset))
    windows.set(id, { id, kind, label, usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}),
      ...(windowDurationMins ? { windowDurationMins } : {}), ...(modelIds?.length ? { modelIds } : {}) })
  }
  for (const [id, kind, label, duration] of [
    ['five_hour', 'session', 'Session', 300], ['seven_day', 'weekly', 'Weekly', WEEK]
  ] as const) {
    const raw = usage[id]
    if (raw == null) continue
    const row = record(raw)
    if (!row) { invalid = true; continue }
    add(id, kind, label, row.utilization, row.resets_at, duration)
  }
  const addScoped = (display: unknown, percent: unknown, reset: unknown, modelId?: unknown) => {
    const name = text(display)
    const key = name?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!name || !key) return
    add(`seven_day_${key}`, 'weekly', `Weekly · ${name}`, percent, reset, WEEK, [text(modelId) ?? key])
  }
  if (Array.isArray(usage.model_scoped)) {
    for (const value of usage.model_scoped) {
      const row = record(value)
      addScoped(row?.display_name, row?.utilization, row?.resets_at)
    }
  }
  if (Array.isArray(usage.limits)) {
    for (const value of usage.limits) {
      const row = record(value)
      if (row?.kind !== 'weekly_scoped' && row?.kind !== 'model_scoped') continue
      const model = record(record(row.scope)?.model)
      addScoped(model?.display_name, row.percent, row.resets_at, model?.id)
    }
  }
  for (const [id, raw] of Object.entries(usage)) {
    if (!id.startsWith('seven_day_')) continue
    const row = record(raw)
    const key = id.slice('seven_day_'.length)
    if (row && !windows.has(id) && !['oauth_apps', 'overage_included'].includes(key)) {
      addScoped(key[0]?.toUpperCase() + key.slice(1), row.utilization, row.resets_at, key)
    }
  }
  const spend = record(usage.spend)
  const used = record(spend?.used)
  const limit = record(spend?.limit)
  const extra = record(usage.extra_usage)
  let spent: number | undefined
  if (spend?.enabled === true && text(used?.currency) && used?.currency === limit?.currency &&
    number(used?.exponent) !== undefined && used?.exponent === limit?.exponent) {
    spent = amountPercent(used?.amount_minor, limit?.amount_minor)
  }
  if (spent === undefined && extra?.is_enabled === true) {
    spent = amountPercent(extra.used_credits, extra.monthly_limit) ?? number(extra.utilization)
  }
  if (spent !== undefined && spent >= 0) add('monthly_spend', 'monthly', 'Monthly spend', spent)
  return windows.size ? { kind: 'ok', windows: [...windows.values()] }
    : invalid ? { kind: 'failed' } : { kind: 'unsupported' }
}

function amountPercent(usedValue: unknown, limitValue: unknown): number | undefined {
  const used = number(usedValue)
  const limit = number(limitValue)
  if (used !== undefined && used >= 0 && limit !== undefined && limit > 0) return number(used / limit * 100)
}

function withAccount(result: LimitsProbeResult, identity: string | undefined, plan: string | undefined): LimitsProbeResult {
  if (result.kind !== 'ok') return result
  const hash = fingerprint(identity)
  return { ...result, ...(hash ? { fingerprint: hash } : {}), ...(plan ? { plan } : {}) }
}

async function fromCli(
  account: DiscoveredAccount, ctx: LimitsProbeContext, hadOAuth: boolean, credentialIdentity?: string
): Promise<LimitsProbeResult> {
  const unavailable = { kind: hadOAuth ? 'failed' : 'unsupported' } as const
  const dataDir = await safeCliHome(account)
  if (!dataDir || ctx.signal.aborted) return ctx.signal.aborted ? { kind: 'failed' } : unavailable
  const executable = await resolveCli('claude')
  if (!executable) return unavailable
  const sendRequest = (id: string, request: object) => ({ type: 'control_request', request_id: id, request })
  let expected = 'initialize'
  let identity = credentialIdentity
  let plan: string | undefined
  // Same stream-json control protocol used by the Agent SDK. Never send a user message.
  return await exchangeCli<LimitsProbeResult>(
    executable,
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--await-initialize',
      '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--tools', '',
      '--settings', '{"disableAllHooks":true}'],
    { ...cliEnvironment('CLAUDE_CONFIG_DIR', dataDir), CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1', DISABLE_AUTOUPDATER: '1' },
    ctx.signal, sendRequest('initialize', { subtype: 'initialize' }),
    (frame, send) => {
      if (frame.type !== 'control_response') return
      const reply = record(frame.response)
      if (reply?.request_id !== expected) return
      const value = record(reply.response)
      if (reply.subtype !== 'success' || !value) return { kind: 'failed' }
      if (expected === 'initialize') {
        const profile = record(value.account)
        if (profile?.apiProvider && profile.apiProvider !== 'firstParty') return { kind: 'unsupported' }
        identity ??= text(profile?.email)?.toLowerCase()
        plan = text(profile?.subscriptionType)
        expected = 'usage'
        send(sendRequest('usage', { subtype: 'get_usage', skip_behaviors: true }))
        return
      }
      if (value.rate_limits_available === false) return { kind: 'unsupported' }
      const usage = record(value.rate_limits)
      if (!usage) return { kind: 'failed' }
      return withAccount(parseWindows(usage), identity, text(value.subscription_type) ?? plan)
    }
  ) ?? { kind: 'failed' }
}

export async function probeClaude(account: DiscoveredAccount, ctx: LimitsProbeContext): Promise<LimitsProbeResult> {
  try {
    for (const path of credentialCandidates(account)) {
      ctx.signal.throwIfAborted()
      const file = record(await ctx.readCredential(path).catch(() => undefined))
      const oauth = record(file?.claudeAiOauth)
      const token = text(oauth?.accessToken)
      if (!token) continue
      const storedIdentity = text(oauth?.accountUuid) ?? text(file?.accountUuid) ??
        text(oauth?.emailAddress)?.toLowerCase()
      const response = await ctx.fetch('https://api.anthropic.com/api/oauth/usage', {
        signal: ctx.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.273' }
      })
      if (!response.ok) {
        await response.body?.cancel()
        return response.status === 401 ? await fromCli(account, ctx, true, storedIdentity) : { kind: 'failed' }
      }
      const usage = record(await response.json())
      ctx.signal.throwIfAborted()
      if (!usage) return { kind: 'failed' }
      return withAccount(parseWindows(usage), text(usage.account_id) ?? storedIdentity ?? token,
        text(usage.subscription_type) ?? text(oauth?.subscriptionType))
    }
    if (ctx.manualApiKey) return { kind: 'unsupported' }
    return await fromCli(account, ctx, false)
  } catch { return { kind: 'failed' } }
}

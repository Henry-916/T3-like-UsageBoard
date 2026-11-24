import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ConsumeResetCreditOutcome, LimitsProbeContext } from '../../shared/limitsTypes'
import type { DiscoveredAccount } from '../../shared/types'
import { APP_VERSION } from '../../shared/version'
import { cliEnvironment, credentialCandidates, exchangeCli, fingerprint, record, resolveCli, safeCliHome, text } from './probes/cli'
import { CODEX_CREDITS_URL, codexResetCredits } from './probes/codex'

const TIMEOUT = 20_000
const FAILED = '暂时无法确认 Codex 重置券结果，请稍后重试。'
const LOGIN = 'Codex 登录凭证已过期，请在 T3 Code 中重新登录后重试'
const HTTP_OUTCOMES = new Map<unknown, ConsumeResetCreditOutcome>([
  ['reset', 'reset'], ['nothing_to_reset', 'nothingToReset'],
  ['no_credit', 'noCredit'], ['already_redeemed', 'alreadyRedeemed']
])
const CLI_OUTCOMES = new Set<unknown>(HTTP_OUTCOMES.values())

type Attempt = {
  key: string
  creditId: string
  accountId?: string
  tokenFingerprint?: string
  transport: 'http' | 'cli'
  cliHome?: string
}

async function pathKey(path: string) {
  const full = resolve(path)
  const canonical = await realpath(full).catch(() => full)
  return `path:${process.platform === 'win32' ? canonical.toLowerCase() : canonical}`
}

async function readOAuth(account: DiscoveredAccount, ctx: LimitsProbeContext) {
  for (const path of credentialCandidates(account)) {
    ctx.signal.throwIfAborted()
    const auth = record(await ctx.readCredential(path).catch(() => undefined))
    const tokens = record(auth?.tokens)
    const token = text(tokens?.access_token)
    if (token) return { token, accountId: text(tokens?.account_id) ?? text(tokens?.chatgpt_account_id), path }
  }
}

const signalFor = (ctx: LimitsProbeContext) => AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT)])

export function createCodexResetCreditConsumer() {
  const tails = new Map<string, Promise<unknown>>()
  const pending = new Map<string, Attempt>()

  return async (account: DiscoveredAccount, ctx: LimitsProbeContext, creditId?: string): Promise<ConsumeResetCreditOutcome> => {
    if (account.provider !== 'codex' || !account.enabled) throw new Error('Codex 账号不可用。')
    const oauth = await readOAuth(account, ctx)
    const credential = oauth?.path ?? credentialCandidates(account)[0]
    const directories = [credential ? dirname(credential) : undefined, account.dataDir]
    const paths = await Promise.all(directories.flatMap(dir => dir ? [pathKey(dir)] : []))
    const keys = [...new Set([
      ...(oauth?.accountId ? [`oauth:${oauth.accountId}`] : []),
      ...paths, `account:${account.id}`
    ])]

    // Register all aliases synchronously, so overlapping identities wait without nested locks.
    const wait = Promise.all(keys.map(key => tails.get(key)?.catch(() => undefined)))
    const operation = wait.then(async () => {
      ctx.signal.throwIfAborted()
      const attempts = new Set(keys.flatMap(key => pending.has(key) ? [pending.get(key)!] : []))
      const previous = attempts.values().next().value
      if (attempts.size > 1 || (previous?.accountId && oauth?.accountId && previous.accountId !== oauth.accountId)) {
        throw new Error(FAILED)
      }
      const forget = (attempt: Attempt) => {
        for (const [key, saved] of pending) if (saved === attempt) pending.delete(key)
      }
      const save = (attempt: Attempt) => {
        for (const key of keys) pending.set(key, attempt)
      }
      const make = (id: string, transport: Attempt['transport'], cliHome?: string): Attempt =>
        ({ key: randomUUID(), creditId: id, transport, accountId: oauth?.accountId, cliHome,
          tokenFingerprint: transport === 'http' && !oauth?.accountId ? fingerprint(oauth?.token) : undefined })
      let selected = previous?.creditId ?? text(creditId)
      let rejectedHttp: Attempt | undefined

      if (oauth && previous?.transport !== 'cli') {
        const headers = {
          Authorization: `Bearer ${oauth.token}`, 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop',
          ...(oauth.accountId ? { 'Chatgpt-Account-Id': oauth.accountId } : {})
        }
        let fallback = false
        if (!selected) {
          const response = await ctx.fetch(CODEX_CREDITS_URL, { headers, redirect: 'error', signal: signalFor(ctx) })
            .catch(() => { throw new Error(FAILED) })
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined)
            if (response.status !== 401) throw new Error(FAILED)
            fallback = true
          } else {
            const credits = codexResetCredits(record(await response.json().catch(() => undefined))?.credits, false)
            if (credits?.resetCredits === 0) return 'noCredit'
            selected = credits?.nextResetCreditId
            if (!selected) throw new Error(FAILED)
          }
        }
        if (!fallback && selected) {
          if ((previous?.accountId && previous.accountId !== oauth.accountId) ||
              (previous?.tokenFingerprint && previous.tokenFingerprint !== fingerprint(oauth.token))) {
            throw new Error(FAILED)
          }
          const attempt = previous ?? make(selected, 'http')
          const signal = signalFor(ctx)
          signal.throwIfAborted()
          save(attempt)
          const response = await ctx.fetch(`${CODEX_CREDITS_URL}/consume`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            redirect: 'error', signal,
            body: JSON.stringify({ redeem_request_id: attempt.key, credit_id: attempt.creditId })
          }).catch(() => { throw new Error(FAILED) })
          const status = response.status
          // A 401 on a retry does not settle the earlier, ambiguous submission.
          if (status === 401) {
            void response.body?.cancel().catch(() => undefined)
            if (previous) throw new Error(FAILED)
            forget(attempt)
            rejectedHttp = attempt
          } else if (response.ok || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
            if (!response.ok) forget(attempt)
            const outcome = HTTP_OUTCOMES.get(record(await response.json().catch(() => undefined))?.code)
            if (!outcome) throw new Error(FAILED)
            forget(attempt)
            return outcome
          } else {
            void response.body?.cancel().catch(() => undefined)
            throw new Error(FAILED)
          }
        }
      }
      if (previous?.transport === 'http') throw new Error(FAILED)

      const dataDir = await safeCliHome(account)
      if (!dataDir) throw new Error(LOGIN)
      if (previous && previous.cliHome !== dataDir) throw new Error(FAILED)
      const executable = await resolveCli('codex')
      if (!executable) throw new Error('未找到 Codex CLI。')
      let step = 1
      let attempt = previous
      const outcome = await exchangeCli<ConsumeResetCreditOutcome | false>(
        executable, ['app-server'], cliEnvironment('CODEX_HOME', dataDir), signalFor(ctx),
        { id: 1, method: 'initialize', params: { clientInfo: { name: 'usage-dashboard', version: APP_VERSION } } },
        (frame, send) => {
          if (frame.id !== step) return
          const result = record(frame.result)
          if (!result || frame.error) return false
          if (step === 2) {
            const outcome = result.outcome
            return CLI_OUTCOMES.has(outcome) ? outcome as ConsumeResetCreditOutcome : false
          }
          if (step === 1) {
            send({ method: 'initialized' })
            // Resolve an exact ticket before any write, including on CLI-only accounts.
            if (!selected) {
              step = 3
              send({ id: 3, method: 'account/rateLimits/read', params: null })
              return
            }
          } else {
            const summary = result.rateLimitResetCredits
            const credits = codexResetCredits(record(summary)?.credits ?? summary, true)
            if (credits?.resetCredits === 0) return 'noCredit'
            selected = credits?.nextResetCreditId
            if (!selected) return false
          }
          attempt ??= rejectedHttp ? { ...rejectedHttp, transport: 'cli', cliHome: dataDir }
            : make(selected, 'cli', dataDir)
          save(attempt)
          step = 2
          send({ id: 2, method: 'account/rateLimitResetCredit/consume',
            params: { idempotencyKey: attempt.key, creditId: attempt.creditId } })
        }
      )
      if (!outcome) throw new Error(FAILED)
      if (attempt) forget(attempt)
      return outcome
    })
    for (const key of keys) tails.set(key, operation)
    try {
      return await operation
    } finally {
      for (const key of keys) if (tails.get(key) === operation) tails.delete(key)
    }
  }
}

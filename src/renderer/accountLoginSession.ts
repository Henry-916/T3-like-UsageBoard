import type { UsageApi } from '../shared/ipc'
import type { AccountLoginState, StartAccountLoginInput } from '../shared/limitsTypes'

type LoginApi = Pick<UsageApi, 'getAccountLoginState' | 'onAccountLoginUpdated' | 'startAccountLogin'
  | 'submitAccountLoginCode' | 'cancelAccountLogin'>

const idle: AccountLoginState = {
  phase: 'idle', flowId: null, provider: null, authorizationUrl: null, message: null
}

export function loginInProgress(state: AccountLoginState) {
  return state.phase === 'starting' || state.phase === 'waiting_browser' ||
    state.phase === 'waiting_code' || state.phase === 'verifying'
}

const missingCli = {
  antigravity: '未检测到 Antigravity CLI（agy），请先安装 Antigravity 后再登录。',
  codex: '未检测到 Codex CLI（codex），请先安装 Codex CLI 后再登录。',
  claude: '未检测到 Claude Code CLI（claude），请先安装 Claude Code 后再登录。'
}

export function loginFailureMessage(state: AccountLoginState): string {
  const provider = state.provider
  if (provider && provider !== 'opencode' && state.message === missingCli[provider]) return missingCli[provider]
  if (state.message === '登录已超时，请重试。') return '登录已超时，请重试。'
  return '未能完成登录，请重试。'
}

export function createAccountLoginSession(api: LoginApi) {
  let snapshot = { state: idle, cancelling: false, submitting: false, error: '' }
  let revision = 0
  let starting = false
  let reading = false
  let submission = 0
  let cancellation: { promise: Promise<boolean>; finish: (ok: boolean) => void; sent: boolean } | null = null
  const listeners = new Set<() => void>()

  function publish(partial: Partial<typeof snapshot>) {
    snapshot = { ...snapshot, ...partial }
    listeners.forEach((listener) => listener())
  }

  function apply(state: AccountLoginState) {
    publish({ state })
    advanceCancellation()
  }

  function advanceCancellation() {
    const request = cancellation
    if (!request || request.sent) return
    const { state } = snapshot
    if (loginInProgress(state) && state.flowId) {
      const { flowId } = state
      request.sent = true
      const before = revision
      void (async () => {
        try {
          const next = await api.cancelAccountLogin(flowId)
          if (revision === before || (snapshot.state.flowId === flowId && loginInProgress(snapshot.state)
            && next.flowId === flowId && !loginInProgress(next))) apply(next)
          finishCancellation(!loginInProgress(snapshot.state))
        } catch {
          finishCancellation(!loginInProgress(snapshot.state))
        }
      })()
    } else if (!starting && !reading) {
      finishCancellation(!loginInProgress(state))
    }
  }

  function finishCancellation(ok: boolean) {
    const request = cancellation
    cancellation = null
    publish({ cancelling: false, error: ok ? '' : '无法取消登录，请重试。' })
    request?.finish(ok)
  }

  function cancel() {
    if (cancellation) return cancellation.promise
    if (!starting && !reading && !loginInProgress(snapshot.state)) return Promise.resolve(true)
    let finish!: (ok: boolean) => void
    const promise = new Promise<boolean>((resolve) => { finish = resolve })
    cancellation = { promise, finish, sent: false }
    publish({ cancelling: true, error: '' })
    advanceCancellation()
    return promise
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    connect() {
      let active = true
      reading = true
      const before = revision
      const unsubscribe = api.onAccountLoginUpdated((state) => {
        if (!active) return
        revision++
        apply(state)
      })
      void (async () => {
        try {
          const state = await api.getAccountLoginState()
          if (active && revision === before && loginInProgress(state)) apply(state)
        } catch { /* Starting a new login does not depend on the initial read. */ }
        finally {
          if (active) {
            reading = false
            advanceCancellation()
          }
        }
      })()
      return () => {
        active = false
        reading = false
        unsubscribe()
        void cancel()
      }
    },
    async start(input: StartAccountLoginInput) {
      if (starting || cancellation || loginInProgress(snapshot.state)) return
      starting = true
      const before = ++revision
      submission++
      publish({ state: { ...idle, phase: 'starting', provider: input.provider }, submitting: false, error: '' })
      try {
        const state = await api.startAccountLogin(input)
        if (revision === before) apply(state)
      } catch {
        if (revision === before) apply({ ...idle, phase: 'failed', provider: input.provider })
      } finally {
        starting = false
        advanceCancellation()
      }
    },
    async submit(code: string) {
      const { state, submitting } = snapshot
      if (cancellation || submitting || state.phase !== 'waiting_code' || !state.flowId) return
      const before = revision
      const request = ++submission
      publish({ submitting: true, error: '' })
      try {
        const next = await api.submitAccountLoginCode(state.flowId, code)
        if (revision === before && !cancellation) apply(next)
      } catch {
        if (revision === before && !cancellation) publish({ error: '无法提交授权码，请检查后重试。' })
      } finally {
        if (submission === request) publish({ submitting: false })
      }
    },
    clearFeedback() {
      if (!loginInProgress(snapshot.state)) publish({ state: idle, error: '' })
    },
    cancel
  }
}

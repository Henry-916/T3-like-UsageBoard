import { describe, expect, it, vi } from 'vitest'
import type { AccountLoginState } from '../src/shared/limitsTypes'
import { createAccountLoginSession, loginFailureMessage } from '../src/renderer/accountLoginSession'
import { copyAuthorizationLink } from '../src/renderer/hooks/useAuthorizationCopy'

function state(phase: AccountLoginState['phase'], flowId = 'flow'): AccountLoginState {
  return { phase, flowId, provider: 'antigravity', authorizationUrl: null, message: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  let notify: (value: AccountLoginState) => void = () => undefined
  const initial = deferred<AccountLoginState>()
  const start = deferred<AccountLoginState>()
  const cancel = deferred<AccountLoginState>()
  const unsubscribe = vi.fn()
  const api = {
    getAccountLoginState: vi.fn(() => initial.promise),
    onAccountLoginUpdated: vi.fn((listener: typeof notify) => { notify = listener; return unsubscribe }),
    startAccountLogin: vi.fn(() => start.promise),
    cancelAccountLogin: vi.fn(() => cancel.promise),
    submitAccountLoginCode: vi.fn().mockResolvedValue(state('verifying'))
  }
  const login = createAccountLoginSession(api)
  const disconnect = login.connect()
  return { login, api, disconnect, unsubscribe, initial, start, cancel, push: (value: AccountLoginState) => notify(value) }
}

describe('renderer login session', () => {
  it('waits to close during startup and cancels on the first pushed flow ID rather than the eventual start response', async () => {
    const { login, api, push, start, cancel, initial } = fixture()
    initial.resolve(state('idle'))
    const started = login.start({ provider: 'antigravity' })
    const close = login.cancel()
    expect(login.cancel()).toBe(close)
    expect(api.cancelAccountLogin).not.toHaveBeenCalled()
    expect(login.getSnapshot().cancelling).toBe(true)

    push(state('starting'))
    expect(api.cancelAccountLogin).toHaveBeenCalledExactlyOnceWith('flow')
    push(state('cancelled'))
    expect(login.getSnapshot().cancelling).toBe(true)
    cancel.resolve(state('cancelled'))
    await expect(close).resolves.toBe(true)

    start.resolve(state('waiting_code'))
    await started
    expect(login.getSnapshot().state.phase).toBe('cancelled')
  })

  it('uses the method result to cancel when no state event has arrived', async () => {
    const { login, api, start, cancel, initial } = fixture()
    initial.resolve(state('idle'))
    const started = login.start({ provider: 'antigravity' })
    const close = login.cancel()
    start.resolve(state('waiting_code'))
    await started
    expect(api.cancelAccountLogin).toHaveBeenCalledExactlyOnceWith('flow')
    cancel.resolve(state('cancelled'))
    await expect(close).resolves.toBe(true)
  })

  it('does not roll back a newer state with an initial read and ignores late events after cleanup', async () => {
    const { login, push, initial, disconnect, unsubscribe } = fixture()
    push(state('failed'))
    initial.resolve(state('waiting_browser', 'stale'))
    await initial.promise
    expect(login.getSnapshot().state.phase).toBe('failed')
    disconnect()
    push(state('waiting_code', 'after-disconnect'))
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(login.getSnapshot().state.phase).toBe('failed')
  })

  it('still cancels an in-flight start on unmount after the subscription has been removed', async () => {
    const { login, api, initial, start, cancel, disconnect, unsubscribe } = fixture()
    initial.resolve(state('idle'))
    const started = login.start({ provider: 'antigravity' })
    disconnect()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(api.cancelAccountLogin).not.toHaveBeenCalled()
    start.resolve(state('waiting_code'))
    await started
    expect(api.cancelAccountLogin).toHaveBeenCalledExactlyOnceWith('flow')
    const close = login.cancel()
    cancel.resolve(state('cancelled'))
    await expect(close).resolves.toBe(true)
  })

  it('waits for an existing flow on close and leaves the form open when cancellation fails', async () => {
    const { login, api, initial, cancel } = fixture()
    const close = login.cancel()
    initial.resolve(state('waiting_browser'))
    await initial.promise
    expect(api.cancelAccountLogin).toHaveBeenCalledExactlyOnceWith('flow')
    cancel.resolve(state('waiting_browser'))
    await expect(close).resolves.toBe(false)
    expect(login.getSnapshot()).toMatchObject({ cancelling: false, error: '无法取消登录，请重试。' })
  })

  it('keeps rejected authorization submission feedback local and generic', async () => {
    const { login, api, push, initial } = fixture()
    initial.resolve(state('idle'))
    push(state('waiting_code'))
    api.submitAccountLoginCode.mockRejectedValueOnce(new Error('upstream diagnostic'))
    await login.submit('test-input')
    expect(login.getSnapshot()).toMatchObject({ submitting: false, error: '无法提交授权码，请检查后重试。' })
    expect(login.getSnapshot().state.phase).toBe('waiting_code')
  })

  it('only allows known localized login diagnostics', () => {
    expect(loginFailureMessage({ ...state('failed'), message: 'arbitrary upstream text' })).toBe('未能完成登录，请重试。')
    expect(loginFailureMessage({ ...state('failed'), message: '登录已超时，请重试。' })).toBe('登录已超时，请重试。')
    const missing = '未检测到 Antigravity CLI（agy），请先安装 Antigravity CLI 后再登录。'
    expect(loginFailureMessage({ ...state('failed'), message: missing })).toBe(missing)
    const missingClaude = '未检测到 Claude Code CLI（claude），请先安装 Claude Code CLI 后再登录。'
    expect(loginFailureMessage({ ...state('failed'), provider: 'claude', message: missingClaude })).toBe(missingClaude)
  })
})

describe('renderer authorization clipboard', () => {
  it('shares one auto-copy promise across effect replay and repeated pushes without blocking explicit copies', async () => {
    const url = 'https://example.test/authorize'
    const ref = { current: null }
    const copyText = vi.fn().mockResolvedValue(undefined)
    const automatic = copyAuthorizationLink(ref, copyText, url, `flow:${url}`)
    expect(copyAuthorizationLink(ref, copyText, url, `flow:${url}`)).toBe(automatic)
    await automatic
    expect(copyAuthorizationLink(ref, copyText, url, `flow:${url}`)).toBe(automatic)
    expect(copyText).toHaveBeenCalledExactlyOnceWith(url)
    await copyAuthorizationLink(ref, copyText, url)
    await copyAuthorizationLink(ref, copyText, url)
    expect(copyText).toHaveBeenCalledTimes(3)
  })

  it('permits a fresh auto-copy for a new flow or URL and an explicit retry after failure', async () => {
    const url = 'https://example.test/authorize'
    const replacement = 'https://example.test/authorize/new'
    const ref = { current: null }
    const copyText = vi.fn().mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValue(undefined)
    const failed = copyAuthorizationLink(ref, copyText, url, `first:${url}`)
    await expect(failed).rejects.toThrow('Clipboard unavailable')
    expect(copyAuthorizationLink(ref, copyText, url, `first:${url}`)).toBe(failed)
    await copyAuthorizationLink(ref, copyText, url)
    await copyAuthorizationLink(ref, copyText, url, `second:${url}`)
    await copyAuthorizationLink(ref, copyText, replacement, `second:${replacement}`)
    expect(copyText.mock.calls).toEqual([[url], [url], [url], [replacement]])
  })
})

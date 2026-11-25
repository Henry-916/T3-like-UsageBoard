import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AccountRow, SwitchAccountConfirmation, accountSwitchErrorMessage } from '../src/renderer/components/AccountsDialog'
import type { AccountView } from '../src/shared/limitsTypes'

const displayName = 'an-intentionally-long-account-email-that-must-not-be-cut-in-the-dom@example.com'
const account: AccountView = {
  id: 'account-1', provider: 'antigravity', displayName, origin: 'manual', enabled: true,
  hasCredential: true, dataDir: '/fake/profile', canSwitch: true
}

function renderRow(changes: Partial<AccountView> = {}, props: Partial<ComponentProps<typeof AccountRow>> = {}) {
  return renderToStaticMarkup(createElement(AccountRow, {
    account: { ...account, ...changes }, busy: false, removing: false,
    setRemoving: vi.fn(), onSwitch: vi.fn(), onToggle: vi.fn(), onRemove: vi.fn(), ...props
  }))
}

describe('account row', () => {
  it('puts the provider on the first line and the complete email and current status on the second', () => {
    const html = renderRow({ current: true })
    expect(html).toContain(`<strong>Antigravity</strong><div class="account-email-line"><span class="account-email" title="${displayName}">${displayName}</span><span class="account-current-badge">当前</span>`)
    expect(html).toContain('role="switch"')
    expect(html).toContain('title="删除"')
    expect(html).not.toMatch(/\/fake\/profile|应用内|原生|重命名|设为当前/)
  })

  it('offers switch confirmation only for supported, non-current accounts with switchable credentials', () => {
    expect(renderRow()).toContain('aria-haspopup="dialog"')
    expect(renderRow({ provider: 'codex', origin: 't3' })).toContain('>设为当前</button>')
    expect(renderRow({ canSwitch: false, origin: 'native' })).not.toContain('设为当前')
    expect(renderRow({ canSwitch: undefined })).not.toContain('设为当前')
    expect(renderRow({ provider: 'claude' })).not.toContain('设为当前')
    const go = renderRow({ provider: 'opencode', displayName: 'OpenCode Go' })
    expect(go).toContain('title="OpenCode Go">OpenCode Go</span>')
    expect(go).not.toContain('设为当前')
  })
})

describe('account switch confirmation', () => {
  it('opens a separate confirmation with Cancel before the opt-in action and a provider-specific warning', () => {
    const onConfirm = vi.fn()
    const html = renderToStaticMarkup(createElement(SwitchAccountConfirmation, {
      account: { ...account, provider: 'codex' }, busy: false, error: '', onCancel: vi.fn(), onConfirm
    }))
    expect(html).toMatch(/<dialog[^>]*aria-labelledby=/)
    expect(html).toContain('title="' + displayName + '">' + displayName)
    expect(html).toContain('写入本机默认凭证，并自动重启正在运行的 Codex App')
    expect(html).toContain('命令行会话需要手动重开或刷新')
    expect(html).toMatch(/<button[^>]*autoFocus=""[^>]*>取消<\/button>.*>确认切换<\/button>/i)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('blocks duplicate confirmation while pending and announces feedback', () => {
    const props = { account, onCancel: vi.fn(), onConfirm: vi.fn() }
    const pending = renderToStaticMarkup(createElement(SwitchAccountConfirmation, { ...props, busy: true, error: '' }))
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>正在切换…<\/button>/)
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>取消<\/button>/)
    const failed = renderToStaticMarkup(createElement(SwitchAccountConfirmation, {
      ...props, busy: false, error: '无法切换账号。'
    }))
    expect(failed).toContain('role="alert">无法切换账号。')
  })

  it('only forwards allowlisted switch errors and prevents a retry when rollback fails', () => {
    expect(accountSwitchErrorMessage(new Error('Error invoking remote method \'usage:switch-account\': Error: 应用未能重启，已恢复原账号。')))
      .toBe('应用未能重启，已恢复原账号。')
    expect(accountSwitchErrorMessage(new Error('ENOENT: /fake/profile'))).not.toContain('/fake/profile')
    const error = '切换失败，且无法恢复原凭证或项目缓存。请停止操作并使用备份恢复。'
    const html = renderToStaticMarkup(createElement(SwitchAccountConfirmation, {
      account, onCancel: vi.fn(), onConfirm: vi.fn(), busy: false, error
    }))
    expect(html).toContain('role="alert">' + error)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认切换<\/button>/)
  })
})

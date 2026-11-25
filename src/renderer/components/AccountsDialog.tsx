import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { AccountLoginState, AccountView } from '../../shared/limitsTypes'
import type { UsageProviderKind } from '../../shared/types'
import { createAccountLoginSession, loginFailureMessage, loginInProgress } from '../accountLoginSession'
import { useAccountsData } from '../hooks/useAccountsData'
import type { UpdateControls } from '../hooks/useUpdates'
import { accountOriginLabels } from '../limitsPresentation'
import { updateActionLabel, updateStatusLabel, versionLabel } from '../updatePresentation'
import { providerInfo, providers } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import { UsageDialog } from './UsageDialog'

type LoginSession = ReturnType<typeof createAccountLoginSession>

export function AccountsDialog({ onClose, onChanged, updates }: {
  onClose: () => void; onChanged: () => void; updates: UpdateControls
}) {
  const { report, loading, busy, error, read, mutate } = useAccountsData(onChanged)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id: string; mode: 'rename' | 'remove' } | null>(null)
  const [focusTarget, setFocusTarget] = useState<{ id?: string } | null>(null)
  const [login] = useState(() => createAccountLoginSession(window.usageApi))
  const loginSnapshot = useSyncExternalStore(login.subscribe, login.getSnapshot)
  const loginActive = loginInProgress(loginSnapshot.state)
  const handledSuccess = useRef<string | null>(null)
  const closing = useRef(false)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const locked = loading || busy || loginActive || loginSnapshot.cancelling
  const showAdd = adding || loginActive

  useEffect(() => login.connect(), [login])

  useEffect(() => {
    if (loginActive) setAdding(true)
  }, [loginActive])

  const acknowledgeSuccess = useCallback(({ phase, flowId }: AccountLoginState) => {
    if (phase !== 'succeeded' || !flowId || handledSuccess.current === flowId) return
    handledSuccess.current = flowId
    if (!closing.current) {
      setAdding(false)
      setFocusTarget({})
      void read()
    }
    onChanged()
  }, [onChanged, read])

  useEffect(() => { acknowledgeSuccess(loginSnapshot.state) }, [acknowledgeSuccess, loginSnapshot.state])

  useLayoutEffect(() => {
    if (!focusTarget || locked) return
    const next = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-account-action]') ?? [])
      .find((button) => button.dataset.accountAction === focusTarget.id)
    const target = next ?? addTrigger.current
    target?.focus()
    setFocusTarget(null)
  }, [focusTarget, locked])

  async function closeAdd() {
    if (!(await login.cancel()) || closing.current) return
    acknowledgeSuccess(login.getSnapshot().state)
    login.clearFeedback()
    setAdding(false)
    setFocusTarget({})
  }

  async function closeDialog() {
    if (closing.current) return
    closing.current = true
    if (await login.cancel()) {
      // Saving may have committed before cancellation reached the main process.
      acknowledgeSuccess(login.getSnapshot().state)
      onClose()
    } else closing.current = false
  }

  return (
    <UsageDialog title="账号管理" onClose={() => void closeDialog()} busy={busy}>
      <div className="dialog-body accounts-body" aria-busy={loading || busy}>
        <div className="accounts-toolbar">
          <label className="account-toggle">
            <input type="checkbox" role="switch" aria-label="扫描 T3 账号" checked={report?.scanT3 ?? true}
              disabled={!report || locked || showAdd}
              onChange={(event) => {
                const enabled = event.currentTarget.checked
                void mutate(() => window.usageApi.setScanT3(enabled), '无法更新 T3 扫描设置。')
              }} />
            扫描 T3 账号
          </label>
          <button ref={addTrigger} className="action-button" type="button" aria-expanded={showAdd}
            disabled={!report || locked} onClick={() => {
              if (showAdd) void closeAdd()
              else {
                login.clearFeedback()
                setEditing(null)
                setAdding(true)
              }
            }}>
            <Plus size={14} aria-hidden="true" />添加账号
          </button>
        </div>
        {showAdd && (
          <AddAccountForm busy={busy} onCancel={() => void closeAdd()} login={login} snapshot={loginSnapshot}
            addKey={async (displayName, apiKey) => {
              if (await mutate(
                () => window.usageApi.addManualAccount({ provider: 'opencode', displayName, mode: 'apiKey', apiKey }),
                '无法添加账号，请检查 Go API Key 后重试。'
              )) {
                setAdding(false)
                setFocusTarget({})
              }
            }} />
        )}
        {error && <div className="accounts-error" role="alert">
          <p>{error}</p>
          {!report && <button type="button" className="action-button" onClick={() => void read()}>重试</button>}
        </div>}
        {!report && loading ? <p className="price-placeholder" role="status">正在读取账号…</p> :
          report && (report.accounts.length === 0 ? <p className="price-placeholder">未发现账号</p> :
            <ul ref={list} className="account-list" aria-label="账号">
              {report.accounts.map((account, index) => (
                <AccountRow key={account.id} account={account} busy={locked || showAdd}
                  editing={editing?.id === account.id ? editing.mode : null}
                  setEditing={(mode) => setEditing(mode ? { id: account.id, mode } : null)}
                  onToggle={(enabled) => mutate(() => window.usageApi.updateAccount(account.id, { enabled }), '无法更新账号状态。')}
                  onRename={(displayName) => mutate(() => window.usageApi.updateAccount(account.id, { displayName }), '无法重命名账号。')}
                  onRemove={async () => {
                    if (await mutate(() => window.usageApi.removeAccount(account.id),
                      account.origin === 'manual' ? '无法删除此账号。' : '无法移除此账号。')) {
                      setEditing(null)
                      setFocusTarget({ id: report.accounts[index + 1]?.id })
                    }
                  }} />
              ))}
            </ul>)}
        {report != null && report.hiddenAutoCount > 0 && (
          <div className="account-hidden-row">
            <p>已隐藏 {report.hiddenAutoCount} 个自动发现账号</p>
            <button type="button" className="action-button" disabled={locked || showAdd} onClick={async () => {
              if (await mutate(() => window.usageApi.restoreHiddenAccounts(), '无法恢复隐藏的账号。')) setFocusTarget({})
            }}>恢复显示</button>
          </div>
        )}
      </div>
      <footer className="dialog-footer accounts-dialog-footer">
        <span role="status" className="sr-only">{updates.feedback?.text ??
          (updates.state?.status === 'downloading' ? '正在下载更新' : updateStatusLabel(updates.state))}</span>
        <p className={updates.feedback?.error ? 'accounts-error' : undefined}>
          {[
            versionLabel(updates.state?.currentVersion),
            updates.feedback?.text ?? updateStatusLabel(updates.state)
          ].filter(Boolean).join(' · ')}
        </p>
        <button type="button" className="action-button" disabled={updates.disabled} onClick={() => void updates.run()}>
          {updateActionLabel(updates.state, 'footer')}
        </button>
      </footer>
    </UsageDialog>
  )
}

function AccountRow({ account, busy, editing, setEditing, onToggle, onRename, onRemove }: {
  account: AccountView
  busy: boolean
  editing: 'rename' | 'remove' | null
  setEditing: (mode: 'rename' | 'remove' | null) => void
  onToggle: (enabled: boolean) => Promise<boolean>
  onRename: (name: string) => Promise<boolean>
  onRemove: () => Promise<void>
}) {
  const renameTrigger = useRef<HTMLButtonElement>(null)
  const removeTrigger = useRef<HTMLButtonElement>(null)
  const manual = account.origin === 'manual'
  const removeLabel = manual ? '删除' : '移除'
  function closeEditor() {
    const trigger = editing === 'rename' ? renameTrigger : removeTrigger
    setEditing(null)
    requestAnimationFrame(() => trigger.current?.focus())
  }

  return (
    <li className="account-item">
      <div className="account-line">
        <ProviderMark provider={account.provider} className="size-[17px]" />
        <div className="account-ident">
          <strong title={account.displayName}>{account.displayName}</strong>
          <span>{providerInfo[account.provider].label} · {accountOriginLabels[account.origin]}</span>
          {account.dataDir && <span className="account-directory" title={account.dataDir}>{account.dataDir}</span>}
        </div>
        <label className="account-toggle">
          <input type="checkbox" role="switch" aria-label={`启用 ${account.displayName}`}
            checked={account.enabled} disabled={busy} onChange={(event) => void onToggle(event.currentTarget.checked)} />
        </label>
        <button ref={renameTrigger} className="icon-button" type="button" disabled={busy}
          aria-label={`重命名 ${account.displayName}`} title="重命名" aria-expanded={editing === 'rename'}
          onClick={() => setEditing(editing === 'rename' ? null : 'rename')}>
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button ref={removeTrigger} className="icon-button account-remove" type="button" disabled={busy}
          data-account-action={account.id} aria-label={`${removeLabel} ${account.displayName}`} title={removeLabel} aria-expanded={editing === 'remove'}
          onClick={() => setEditing(editing === 'remove' ? null : 'remove')}>
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
      {editing === 'rename' && (
        <form className="account-editor" onSubmit={async (event) => {
          event.preventDefault()
          const name = String(new FormData(event.currentTarget).get('displayName') ?? '').trim()
          if (name && (name === account.displayName || await onRename(name))) closeEditor()
        }}>
          <input aria-label="显示名" className="price-field" name="displayName" maxLength={120}
            defaultValue={account.displayName} required autoFocus disabled={busy}
            onFocus={(event) => event.currentTarget.select()} />
          <button className="action-button" type="button" disabled={busy} onClick={closeEditor}>取消</button>
          <button className="action-button primary-action" type="submit" disabled={busy}>保存</button>
        </form>
      )}
      {editing === 'remove' && (
        <div className="account-editor">
          <p className="min-w-0 grow break-words text-subtle">{manual
            ? `删除「${account.displayName}」并清除已保存的登录凭证？`
            : `从列表移除「${account.displayName}」？（不会改动本机原登录文件）`}</p>
          <button className="action-button" type="button" autoFocus disabled={busy} onClick={closeEditor}>取消</button>
          <button className="action-button remove-action" type="button" disabled={busy} onClick={() => void onRemove()}>{removeLabel}</button>
        </div>
      )}
    </li>
  )
}

function AddAccountForm({ busy, onCancel, login, snapshot, addKey }: {
  busy: boolean
  onCancel: () => void
  login: LoginSession
  snapshot: ReturnType<LoginSession['getSnapshot']>
  addKey: (displayName: string, apiKey: string) => Promise<void>
}) {
  const { state, cancelling, submitting, error } = snapshot
  const active = loginInProgress(state)
  const [selected, setSelected] = useState<UsageProviderKind>(state.provider ?? 'antigravity')
  const [linkError, setLinkError] = useState('')
  const keyField = useRef<HTMLInputElement>(null)
  const codeField = useRef<HTMLInputElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const provider = active && state.provider ? state.provider : selected
  const waitingCode = state.phase === 'waiting_code'
  const waitingBrowser = state.phase === 'waiting_browser'
  const verifying = state.phase === 'verifying' || submitting
  const showBrowserLink = (waitingBrowser || waitingCode) && Boolean(state.authorizationUrl)
  const formError = error || (state.phase === 'failed' ? loginFailureMessage(state) : '') || linkError
  const status = cancelling ? '正在取消登录…' : verifying ? '正在保存凭证…'
    : waitingBrowser ? '请在打开的浏览器窗口中完成授权'
      : waitingCode ? '在浏览器中完成授权后，粘贴授权码。'
        : state.phase === 'starting' ? '正在启动登录…'
          : state.phase === 'cancelled' ? '登录已取消。' : ''

  useLayoutEffect(() => {
    if (waitingCode && !cancelling) codeField.current?.focus()
  }, [waitingCode, cancelling])

  useLayoutEffect(() => {
    if (state.phase === 'starting' && !cancelling) cancelButton.current?.focus()
  }, [state.phase, cancelling])

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || cancelling || verifying) return
    if (waitingCode) {
      const input = codeField.current
      const code = input?.value.trim()
      if (input && code) {
        input.value = ''
        void login.submit(code)
      } else input?.focus()
      return
    }
    if (active || state.phase === 'succeeded') return
    setLinkError('')
    const displayName = String(new FormData(event.currentTarget).get('displayName') ?? '').trim()
    if (provider === 'opencode') {
      const input = keyField.current
      const apiKey = input?.value.trim()
      if (input && apiKey) {
        input.value = ''
        void addKey(displayName, apiKey)
      } else input?.focus()
    } else {
      void login.start({ provider, ...(displayName ? { displayName } : {}) })
    }
  }

  async function openAuthorization() {
    if (cancelling || !state.authorizationUrl) return
    setLinkError('')
    try {
      await window.usageApi.openExternalUrl(state.authorizationUrl)
    } catch {
      const current = login.getSnapshot().state
      if (current.phase === state.phase && current.flowId === state.flowId) setLinkError('无法打开授权页面，请重试。')
    }
  }

  return (
    <form className="account-add-form" onSubmit={onSubmit} autoComplete="off">
      <div className="account-add-grid">
        <label>提供方
          <select className="price-field" value={provider} autoFocus disabled={busy || active || cancelling} onChange={(event) => {
            setSelected(event.currentTarget.value as UsageProviderKind)
            setLinkError('')
            login.clearFeedback()
          }}>
            {providers.map((provider) => <option key={provider} value={provider}>{providerInfo[provider].label}</option>)}
          </select>
        </label>
        <label>显示名（选填）
          <input className="price-field" name="displayName" maxLength={120} disabled={busy || active || cancelling}
            placeholder={providerInfo[provider].label} />
        </label>
      </div>
      {provider === 'opencode' && <label>Go API Key
        <input ref={keyField} className="price-field" type="password" autoComplete="off"
          spellCheck={false} maxLength={8192} required disabled={busy} />
      </label>}
      <p role="status" className={status ? 'account-login-status' : 'sr-only'}>{status}</p>
      {waitingCode && <label>授权码
        <input ref={codeField} className="price-field" type="password" autoComplete="off" spellCheck={false}
          placeholder="粘贴授权页面显示的授权码或完整回调链接" maxLength={8192} required disabled={cancelling || submitting} />
      </label>}
      {formError && <p className="accounts-error" role="alert">{formError}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {showBrowserLink && <button className="action-button" type="button" disabled={cancelling || verifying}
          onClick={() => void openAuthorization()}>{waitingCode ? '重新打开链接' : '打开授权页面'}</button>}
        <button ref={cancelButton} className="action-button" type="button" disabled={busy || cancelling} onClick={onCancel}>取消</button>
        {!waitingBrowser && <button className="action-button primary-action" type="submit"
          disabled={busy || cancelling || verifying || state.phase === 'starting' || state.phase === 'succeeded'}>
          {verifying ? '正在保存凭证…' : state.phase === 'starting' ? '正在启动登录…' : waitingCode ? '完成登录'
            : busy ? '正在处理…' : provider === 'opencode' ? '添加账号' : '浏览器登录'}
        </button>}
      </div>
    </form>
  )
}

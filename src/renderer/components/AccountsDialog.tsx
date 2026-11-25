import { Check, ChevronDown, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent
} from 'react'
import type { AccountLoginState, AccountView } from '../../shared/limitsTypes'
import type { UsageProviderKind } from '../../shared/types'
import { createAccountLoginSession, loginFailureMessage, loginInProgress } from '../accountLoginSession'
import { useAccountsData } from '../hooks/useAccountsData'
import { useAuthorizationCopy } from '../hooks/useAuthorizationCopy'
import type { UpdateControls } from '../hooks/useUpdates'
import { updateActionLabel, updateStatusLabel, versionLabel } from '../updatePresentation'
import { providerInfo, providers } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import { UsageDialog } from './UsageDialog'

type LoginSession = ReturnType<typeof createAccountLoginSession>

const rollbackFailed = '切换失败，且无法恢复原凭证或项目缓存。请停止操作并使用备份恢复。'
const switchErrors = new Set([
  rollbackFailed,
  '应用未能重启，已恢复原账号。',
  '无法写入新凭证，已恢复原账号。',
  '无法确认或备份当前账号，未切换。',
  '无法验证目标凭证或关闭对应应用，未切换。',
  '目标账号或凭证不可用，请刷新后重试。',
  '无法读取目标账号凭证。',
  '默认凭证或项目缓存路径不安全，未切换。',
  '当前无法切换账号。',
  '正在切换账号，请稍候。'
])

export function accountSwitchErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message.replace(/^Error invoking remote method 'usage:switch-account': (?:Error: )?/, '')
    : ''
  return switchErrors.has(message) ? message : '无法切换账号。请确认本机登录状态后再试。'
}

export function AccountsDialog({ onClose, onChanged, updates }: {
  onClose: () => void; onChanged: () => void; updates: UpdateControls
}) {
  const { report, loading, busy, error, read, mutate } = useAccountsData(onChanged)
  const [adding, setAdding] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [switchTarget, setSwitchTarget] = useState<AccountView | null>(null)
  const [switchError, setSwitchError] = useState('')
  const switchBlocked = switchError === rollbackFailed
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
  const updateStatus = updates.state?.status
  const updating = updateStatus === 'checking' || updateStatus === 'downloading'
  const updateResult = updates.feedback?.text ?? (
    updating || updateStatus === 'available' || updateStatus === 'downloaded' ? updateStatusLabel(updates.state) : ''
  )

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

  function openSwitch(account: AccountView) {
    if (switchBlocked) return
    setRemovingId(null)
    setSwitchError('')
    setSwitchTarget(account)
  }

  async function confirmSwitch() {
    if (!switchTarget || busy || switchBlocked) return
    const { id } = switchTarget
    setSwitchError('')
    if (await mutate(
      () => window.usageApi.switchAccount(id),
      accountSwitchErrorMessage,
      setSwitchError
    )) {
      setSwitchTarget(null)
      setFocusTarget({ id })
    }
  }

  return (
    <>
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
                setRemovingId(null)
                setAdding(true)
              }
            }}>
            <Plus size={14} aria-hidden="true" />添加账号
          </button>
        </div>
        {showAdd && (
          <AddAccountForm busy={busy} onCancel={() => void closeAdd()} login={login} snapshot={loginSnapshot}
            addKey={async (apiKey) => {
              if (await mutate(
                () => window.usageApi.addManualAccount({ provider: 'opencode', mode: 'apiKey', apiKey }),
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
        {switchBlocked && !switchTarget && <p className="accounts-error" role="alert">{switchError}</p>}
        {!report && loading ? <p className="price-placeholder" role="status">正在读取账号…</p> :
          report && (report.accounts.length === 0 ? <p className="price-placeholder">未发现账号</p> :
            <ul ref={list} className="account-list" aria-label="账号">
              {report.accounts.map((account, index) => (
                <AccountRow key={account.id} account={account} busy={locked || showAdd}
                  removing={removingId === account.id}
                  setRemoving={(open) => setRemovingId(open ? account.id : null)}
                  onSwitch={() => openSwitch(account)} switchBlocked={switchBlocked}
                  onToggle={(enabled) => mutate(() => window.usageApi.updateAccount(account.id, { enabled }), '无法更新账号状态。')}
                  onRemove={async () => {
                    if (await mutate(() => window.usageApi.removeAccount(account.id),
                      account.origin === 'manual' ? '无法删除此账号。' : '无法移除此账号。')) {
                      setRemovingId(null)
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
        <span role="status" className="sr-only">{updateStatus === 'downloading' ? '正在下载更新' : updateResult}</span>
        <p className={updates.feedback?.error ? 'accounts-error' : undefined}>
          {[
            versionLabel(updates.state?.currentVersion),
            updateResult
          ].filter(Boolean).join(' · ')}
        </p>
        <button type="button" className="action-button" disabled={updates.disabled} onClick={() => void updates.run()}>
          {updating && <LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />}
          {updateActionLabel(updates.state, 'footer')}
        </button>
      </footer>
    </UsageDialog>
    {switchTarget && <SwitchAccountConfirmation account={switchTarget} busy={busy} error={switchError}
      onCancel={() => setSwitchTarget(null)} onConfirm={() => void confirmSwitch()} />}
    </>
  )
}

export function SwitchAccountConfirmation({ account, busy, error, onCancel, onConfirm }: {
  account: AccountView
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  const app = providerInfo[account.provider].label

  useLayoutEffect(() => {
    if (!busy) cancel.current?.focus({ preventScroll: true })
  }, [busy])

  return (
    <UsageDialog title="切换账号？" onClose={onCancel} busy={busy}>
      <div className="account-switch-description" id={descriptionId}>
        <p className="account-switch-target" title={account.displayName}>{account.displayName}</p>
        <p>切换将写入本机默认凭证，并自动重启正在运行的 {app} App。正在运行的命令行会话需要手动重开或刷新。</p>
      </div>
      {error && <p className="accounts-error account-switch-error" role="alert">{error}</p>}
      <div className="confirm-actions">
        <button ref={cancel} className="action-button" type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
        <button className="action-button primary-action" type="button" disabled={busy || error === rollbackFailed}
          aria-describedby={descriptionId} onClick={onConfirm}>
          {busy ? '正在切换…' : '确认切换'}
        </button>
        {busy && <span role="status" className="sr-only">正在切换账号…</span>}
      </div>
    </UsageDialog>
  )
}

export function AccountRow({ account, busy, removing, setRemoving, onSwitch, switchBlocked = false, onToggle, onRemove }: {
  account: AccountView
  busy: boolean
  removing: boolean
  setRemoving: (open: boolean) => void
  onSwitch: () => void
  switchBlocked?: boolean
  onToggle: (enabled: boolean) => Promise<boolean>
  onRemove: () => Promise<void>
}) {
  const removeTrigger = useRef<HTMLButtonElement>(null)
  const manual = account.origin === 'manual'
  const removeLabel = manual ? '删除' : '移除'
  const switchable = !account.current && account.canSwitch && (account.provider === 'codex' || account.provider === 'antigravity')
  function cancelRemove() {
    setRemoving(false)
    removeTrigger.current?.focus()
  }

  return (
    <li className="account-item">
      <div className="account-line">
        <ProviderMark provider={account.provider} className="size-[17px]" />
        <div className="account-ident">
          <strong>{providerInfo[account.provider].label}</strong>
          <div className="account-email-line">
            <span className="account-email" title={account.displayName}>{account.displayName}</span>
            {account.current && <span className="account-current-badge">当前</span>}
          </div>
        </div>
        <div className="account-actions">
          {switchable && <button className="action-button account-switch" type="button" disabled={busy || switchBlocked}
            aria-haspopup="dialog" aria-label={`设为当前：${account.displayName}`} onClick={onSwitch}>设为当前</button>}
          <label className="account-toggle">
            <input type="checkbox" role="switch" aria-label={`启用 ${account.displayName}`}
              checked={account.enabled} disabled={busy} onChange={(event) => void onToggle(event.currentTarget.checked)} />
          </label>
          <button ref={removeTrigger} className="icon-button account-remove" type="button" disabled={busy}
            data-account-action={account.id} aria-label={`${removeLabel} ${account.displayName}`} title={removeLabel}
            aria-expanded={removing} onClick={() => setRemoving(!removing)}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {removing && (
        <div className="account-editor">
          <p className="min-w-0 grow break-words text-subtle">{manual
            ? `删除「${account.displayName}」并清除已保存的登录凭证？`
            : `从列表移除「${account.displayName}」？（不会改动本机原登录文件）`}</p>
          <button className="action-button" type="button" autoFocus disabled={busy} onClick={cancelRemove}>取消</button>
          <button className="action-button remove-action" type="button" disabled={busy} onClick={() => void onRemove()}>{removeLabel}</button>
        </div>
      )}
    </li>
  )
}

function placeProviderMenu(menu: HTMLDivElement, trigger: HTMLButtonElement) {
  if (!menu.matches(':popover-open')) return
  const anchor = trigger.getBoundingClientRect()
  const scroller = trigger.closest('.dialog-body')?.getBoundingClientRect()
  if (scroller && (anchor.bottom <= scroller.top || anchor.top >= scroller.bottom)) {
    menu.hidePopover()
    return
  }
  menu.style.width = `${anchor.width}px`
  if (CSS.supports('position-area: block-end span-inline-end') && CSS.supports('position-try-fallbacks: flip-block')) return

  const edge = 8
  const gap = 6
  const below = Math.max(0, window.innerHeight - edge - anchor.bottom - gap)
  const above = Math.max(0, anchor.top - gap - edge)
  const height = menu.scrollHeight + 2
  const flip = height > below && above > below
  menu.style.maxHeight = `${flip ? above : below}px`
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(edge, Math.min(anchor.left, window.innerWidth - box.width - edge))}px`
  menu.style.top = `${Math.max(edge, flip ? anchor.top - gap - box.height : anchor.bottom + gap)}px`
}

function ProviderSelect({ value, disabled, onChange }: {
  value: UsageProviderKind
  disabled: boolean
  onChange: (provider: UsageProviderKind) => void
}) {
  const labelId = useId()
  const valueId = useId()
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const initialItem = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [activeItem, setActiveItem] = useState(providers.indexOf(value))

  useLayoutEffect(() => {
    if (disabled && menu.current?.matches(':popover-open')) menu.current.hidePopover()
  }, [disabled])

  useEffect(() => {
    if (!open || !trigger.current || !menu.current) return
    const button = trigger.current
    const panel = menu.current
    const scroller = button.closest('.dialog-body')
    const reposition = () => placeProviderMenu(panel, button)
    window.addEventListener('resize', reposition)
    scroller?.addEventListener('scroll', reposition, { passive: true })
    return () => {
      window.removeEventListener('resize', reposition)
      scroller?.removeEventListener('scroll', reposition)
    }
  }, [open])

  function focusItem(index: number) {
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus()
  }

  function closeMenu() {
    menu.current?.hidePopover()
    trigger.current?.focus()
  }

  function handleTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = event.key === 'ArrowDown' ? 0 : providers.length - 1
    if (menu.current?.matches(':popover-open')) focusItem(index)
    else {
      initialItem.current = index
      event.currentTarget.click()
    }
  }

  function handleListKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      closeMenu()
      return
    }
    let index: number
    switch (event.key) {
      case 'ArrowDown': index = (activeItem + 1) % providers.length; break
      case 'ArrowUp': index = (activeItem + providers.length - 1) % providers.length; break
      case 'Home': index = 0; break
      case 'End': index = providers.length - 1; break
      default: return // Enter and Space use the option button's native activation.
    }
    event.preventDefault()
    focusItem(index)
  }

  return (
    <div className="provider-select" onKeyDownCapture={(event) => {
      if (event.key !== 'Escape' || !menu.current?.matches(':popover-open')) return
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    }}>
      <span id={labelId}>提供方</span>
      <button ref={trigger} type="button" className="price-field provider-select-trigger" autoFocus disabled={disabled}
        popoverTarget={menuId} aria-haspopup="listbox" aria-controls={menuId} aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`} onKeyDown={handleTriggerKey}>
        <ProviderMark provider={value} className="size-4 shrink-0" />
        <span id={valueId}>{providerInfo[value].label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div ref={menu} id={menuId} className="provider-select-menu" popover="auto" role="listbox"
        aria-labelledby={labelId} onKeyDown={handleListKey} onToggle={(event) => {
          const panel = event.currentTarget
          const button = trigger.current
          const opened = panel.matches(':popover-open')
          setOpen(opened)
          if (opened && button) {
            placeProviderMenu(panel, button)
            if (panel.matches(':popover-open')) focusItem(initialItem.current ?? providers.indexOf(value))
          }
          initialItem.current = null
        }}>
        {providers.map((entry, index) => (
          <button key={entry} type="button" role="option" aria-selected={entry === value} tabIndex={activeItem === index ? 0 : -1}
            onFocus={() => setActiveItem(index)} onClick={() => { closeMenu(); onChange(entry) }}>
            <ProviderMark provider={entry} className="size-4 shrink-0" />
            <span>{providerInfo[entry].label}</span>
            {entry === value && <Check size={14} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  )
}

function AddAccountForm({ busy, onCancel, login, snapshot, addKey }: {
  busy: boolean
  onCancel: () => void
  login: LoginSession
  snapshot: ReturnType<LoginSession['getSnapshot']>
  addKey: (apiKey: string) => Promise<void>
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
  const authorizationUrl = waitingBrowser || waitingCode ? state.authorizationUrl : null
  const { copied, copyAuthorization } = useAuthorizationCopy(authorizationUrl, state.flowId)
  const formError = error || (state.phase === 'failed' ? loginFailureMessage(state) : '') || linkError
  const status = cancelling ? '正在取消登录…' : verifying ? '正在保存凭证…'
    : waitingBrowser ? '请在浏览器打开上方链接完成授权'
      : waitingCode ? '完成浏览器授权后，在下方粘贴授权码'
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
    if (provider === 'opencode') {
      const input = keyField.current
      const apiKey = input?.value.trim()
      if (input && apiKey) {
        input.value = ''
        void addKey(apiKey)
      } else input?.focus()
    } else {
      void login.start({ provider })
    }
  }

  async function openAuthorization() {
    if (cancelling || verifying || !authorizationUrl) return
    setLinkError('')
    try {
      await window.usageApi.openExternalUrl(authorizationUrl)
    } catch {
      const current = login.getSnapshot().state
      if (current.phase === state.phase && current.flowId === state.flowId) setLinkError('无法打开授权页面，请重试。')
    }
  }

  return (
    <form className="account-add-form" onSubmit={onSubmit} autoComplete="off">
      <ProviderSelect value={provider} disabled={busy || active || cancelling} onChange={(next) => {
        setSelected(next)
        setLinkError('')
        login.clearFeedback()
      }} />
      {provider === 'opencode' && <label>Go API Key
        <input ref={keyField} className="price-field" type="password" autoComplete="off"
          spellCheck={false} maxLength={8192} required disabled={busy} />
      </label>}
      {authorizationUrl && <div className="login-link">
        <div className="login-link-label">
          <span>授权链接</span>
          <span role="status">{copied ? '已复制链接' : '点击输入框复制'}</span>
        </div>
        <div className="login-url-row">
          <input className="price-field login-url-input" type="text" readOnly value={authorizationUrl}
            aria-label="授权链接，点击复制" title="点击复制授权链接"
            onClick={() => void copyAuthorization()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                if (!event.repeat) void copyAuthorization()
              }
            }} />
          <button className="action-button" type="button" disabled={cancelling || verifying}
            onClick={() => void openAuthorization()}>打开</button>
        </div>
      </div>}
      <p role="status" className={status ? 'account-login-status' : 'sr-only'}>{status}</p>
      {waitingCode && <label>授权码
        <input ref={codeField} className="price-field" type="password" autoComplete="off" spellCheck={false}
          placeholder="粘贴授权页面显示的授权码或完整回调链接" maxLength={8192} required disabled={cancelling || submitting} />
      </label>}
      {formError && <p className="accounts-error" role="alert">{formError}</p>}
      <div className="flex flex-wrap justify-end gap-2">
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

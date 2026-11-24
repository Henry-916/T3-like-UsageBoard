import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import type { AccountView } from '../../shared/limitsTypes'
import type { UsageProviderKind } from '../../shared/types'
import { useAccountsData } from '../hooks/useAccountsData'
import { accountOriginLabels } from '../limitsPresentation'
import { providerInfo, providers } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import { UsageDialog } from './UsageDialog'

type AddMode = 'directory' | 'credential' | 'apiKey'

export function AccountsDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { report, loading, busy, error, read, mutate } = useAccountsData(onChanged)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id: string; mode: 'rename' | 'remove' } | null>(null)
  const addTrigger = useRef<HTMLButtonElement>(null)

  function closeAdd() {
    setAdding(false)
    addTrigger.current?.focus()
  }

  return (
    <UsageDialog title="账号管理" onClose={onClose} busy={busy}>
      <div className="dialog-body accounts-body" aria-busy={loading || busy}>
        <div className="accounts-toolbar">
          <label className="account-toggle">
            <input type="checkbox" role="switch" aria-label="扫描 T3 账号" checked={report?.scanT3 ?? true}
              disabled={!report || busy}
              onChange={(event) => {
                const enabled = event.currentTarget.checked
                void mutate(() => window.usageApi.setScanT3(enabled), '无法更新 T3 扫描设置。')
              }} />
            扫描 T3 账号
          </label>
          <button ref={addTrigger} className="action-button" type="button" aria-expanded={adding}
            disabled={!report || busy} onClick={() => {
              setEditing(null)
              setAdding((previous) => !previous)
            }}>
            <Plus size={14} aria-hidden="true" />添加账号
          </button>
        </div>
        {adding && (
          <AddAccountForm busy={busy} onCancel={closeAdd} submit={async (provider, displayName, mode, apiKey) => {
            if (await mutate(
              () => window.usageApi.addManualAccount({ provider, displayName, mode, ...(apiKey ? { apiKey } : {}) }),
              mode === 'directory' ? '无法添加此目录。' : mode === 'credential' ? '无法导入此凭证。' : '无法添加账号。'
            )) {
              setAdding(false)
              requestAnimationFrame(() => addTrigger.current?.focus())
            }
          }} />
        )}
        {error && <div className="accounts-error" role="alert">
          <p>{error}</p>
          {!report && <button type="button" className="action-button" onClick={() => void read()}>重试</button>}
        </div>}
        {loading ? <p className="price-placeholder" role="status">正在读取账号…</p> :
          report && (report.accounts.length === 0 ? <p className="price-placeholder">未发现账号</p> :
            <ul className="account-list" aria-label="账号">
              {report.accounts.map((account) => (
                <AccountRow key={account.id} account={account} busy={busy}
                  editing={editing?.id === account.id ? editing.mode : null}
                  setEditing={(mode) => {
                    if (mode) setAdding(false)
                    setEditing(mode ? { id: account.id, mode } : null)
                  }}
                  onToggle={(enabled) => mutate(() => window.usageApi.updateAccount(account.id, { enabled }), '无法更新账号状态。')}
                  onRename={(displayName) => mutate(() => window.usageApi.updateAccount(account.id, { displayName }), '无法重命名账号。')}
                  onRemove={async () => {
                    if (await mutate(() => window.usageApi.removeManualAccount(account.id), '无法移除此账号。')) {
                      setEditing(null)
                      requestAnimationFrame(() => addTrigger.current?.focus())
                    }
                  }} />
              ))}
            </ul>)}
      </div>
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
        {account.origin === 'manual' && <button ref={removeTrigger} className="icon-button account-remove" type="button" disabled={busy}
          aria-label={`移除 ${account.displayName}`} title="移除" aria-expanded={editing === 'remove'}
          onClick={() => setEditing(editing === 'remove' ? null : 'remove')}>
          <Trash2 size={15} aria-hidden="true" />
        </button>}
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
          <p className="min-w-0 grow break-words text-subtle">移除「{account.displayName}」？</p>
          <button className="action-button" type="button" autoFocus disabled={busy} onClick={closeEditor}>取消</button>
          <button className="action-button remove-action" type="button" disabled={busy} onClick={() => void onRemove()}>移除</button>
        </div>
      )}
    </li>
  )
}

function AddAccountForm({ busy, onCancel, submit }: {
  busy: boolean
  onCancel: () => void
  submit: (provider: UsageProviderKind, displayName: string, mode: AddMode, apiKey?: string) => Promise<void>
}) {
  const [provider, setProvider] = useState<UsageProviderKind>('antigravity')
  const [mode, setMode] = useState<AddMode>('directory')
  const keyField = useRef<HTMLInputElement>(null)

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const displayName = String(new FormData(event.currentTarget).get('displayName') ?? '').trim() || providerInfo[provider].label
    const apiKey = mode === 'apiKey' ? keyField.current?.value.trim() : undefined
    if (mode === 'apiKey' && !apiKey) {
      keyField.current?.focus()
      return
    }
    if (keyField.current) keyField.current.value = ''
    void submit(provider, displayName, mode, apiKey)
  }

  return (
    <form className="account-add-form" onSubmit={onSubmit} autoComplete="off">
      <div className="account-add-grid">
        <label>提供方
          <select className="price-field" value={provider} autoFocus disabled={busy} onChange={(event) => {
            setProvider(event.currentTarget.value as UsageProviderKind)
            setMode('directory')
          }}>
            {providers.map((provider) => <option key={provider} value={provider}>{providerInfo[provider].label}</option>)}
          </select>
        </label>
        <label>显示名
          <input className="price-field" name="displayName" maxLength={120} disabled={busy} placeholder={providerInfo[provider].label} />
        </label>
        {(provider === 'antigravity' || provider === 'opencode') && <label>添加方式
          <select className="price-field" value={mode} disabled={busy}
            onChange={(event) => setMode(event.currentTarget.value as AddMode)}>
            <option value="directory">数据目录</option>
            {provider === 'antigravity' && <option value="credential">导入凭证</option>}
            {provider === 'opencode' && <option value="apiKey">Go API Key</option>}
          </select>
        </label>}
      </div>
      {mode === 'apiKey' && <label>Go API Key
        <input ref={keyField} className="price-field" type="password" autoComplete="off"
          spellCheck={false} maxLength={8192} required disabled={busy} />
      </label>}
      <div className="flex flex-wrap justify-end gap-2">
        <button className="action-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="action-button primary-action" type="submit" disabled={busy}>
          {busy ? '正在处理…' : mode === 'directory' ? '选择目录' : mode === 'credential' ? '选择凭证文件' : '添加账号'}
        </button>
      </div>
    </form>
  )
}

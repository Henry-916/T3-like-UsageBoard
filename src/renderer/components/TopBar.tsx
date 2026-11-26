import { Check, ChevronDown, LoaderCircle, Minus, RefreshCw, Settings2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { UsageProviderKind } from '../../shared/types'
import type { UpdateControls } from '../hooks/useUpdates'
import { showUpdateCapsule, updateActionLabel } from '../updatePresentation'
import { providerInfo, providers, ranges, type UsageRange, type UsageView } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'

export const views = [
  { value: 'cost', label: '费用', shortcut: 'C' },
  { value: 'tokens', label: 'token', shortcut: 'T' },
  { value: 'limits', label: '账号', shortcut: 'A' }
] as const

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: readonly { value: T; label: string; shortcut?: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value}
          title={option.shortcut ? `${option.label} (${option.shortcut})` : undefined}
          onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

const providerOrder = ['codex', 'claude', 'opencode', 'antigravity'] as const satisfies readonly UsageProviderKind[]

function placePopover(panel: HTMLDivElement | null, trigger: HTMLButtonElement | null, alignEnd = false) {
  if (CSS.supports('position-area: block-end span-inline-end') || !panel?.matches(':popover-open') || !trigger) return
  const anchor = trigger.getBoundingClientRect()
  const { width, height } = panel.getBoundingClientRect()
  const edge = 8
  const gap = 6
  const left = alignEnd ? anchor.right - width : anchor.left
  const below = anchor.bottom + gap
  const above = anchor.top - gap - height
  const top = below + height > window.innerHeight - edge && above >= edge ? above : below
  panel.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - width - edge))}px`
  panel.style.top = `${Math.max(edge, Math.min(top, window.innerHeight - height - edge))}px`
}

export function TopBar({ hiddenProviders, range, view, refreshing, maximized, updates, accountsOpen, onHiddenProviders, onRange, onView, onRefresh, onPrices, onAccounts, onWindow }: {
  hiddenProviders: readonly UsageProviderKind[]; range: UsageRange; view: UsageView; refreshing: boolean; maximized: boolean
  updates: UpdateControls
  accountsOpen: boolean
  onHiddenProviders: (providers: UsageProviderKind[]) => void
  onRange: (range: UsageRange) => void
  onView: (view: UsageView) => void
  onRefresh: () => void
  onPrices: () => void
  onAccounts: () => void
  onWindow: (action: 'minimize' | 'toggleMaximize' | 'hide') => void
}) {
  const settingsPanel = useRef<HTMLDivElement>(null)
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  const providerPanel = useRef<HTMLDivElement>(null)
  const providerTrigger = useRef<HTMLButtonElement>(null)
  const initialItem = useRef(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeItem, setActiveItem] = useState(0)
  const visible = providers.filter((entry) => !hiddenProviders.includes(entry))
  const allVisible = visible.length === providers.length
  const filterLabel = allVisible ? '所有提供方'
    : visible.length === 0 ? '无提供方'
    : visible.length === 1 ? providerInfo[visible[0]].label
    : `${visible.length} 个提供方`
  const refreshLabel = view === 'limits' ? '刷新额度' : '刷新用量'
  const maximizeLabel = maximized ? '向下还原' : '最大化'
  const updateStatus = updates.state?.status
  const showUpdate = showUpdateCapsule(updates.state)
  const updating = updateStatus === 'checking' || updateStatus === 'downloading'
  const feedback = !showUpdate && !accountsOpen ? updates.feedback : null

  useEffect(() => {
    if (CSS.supports('position-area: block-end span-inline-end')) return
    function reposition() {
      placePopover(providerPanel.current, providerTrigger.current)
      placePopover(settingsPanel.current, settingsTrigger.current, true)
    }
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [])

  function choose(action: () => void) {
    settingsPanel.current?.hidePopover()
    settingsTrigger.current?.focus()
    action()
  }

  function focusMenuItem(index: number) {
    providerPanel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')[index]?.focus()
  }

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = event.key === 'ArrowDown' ? 0 : providerOrder.length
    const panel = providerPanel.current
    if (panel?.matches(':popover-open')) {
      focusMenuItem(index)
    } else {
      initialItem.current = index
      event.currentTarget.click()
    }
  }

  function onProviderMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const count = providerOrder.length + 1
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape' || event.shiftKey) event.preventDefault()
      event.currentTarget.hidePopover()
      providerTrigger.current?.focus()
      return
    }
    let next: number
    switch (event.key) {
      case 'ArrowDown': next = (activeItem + 1) % count; break
      case 'ArrowUp': next = (activeItem + count - 1) % count; break
      case 'Home': next = 0; break
      case 'End': next = count - 1; break
      default: return
    }
    event.preventDefault()
    focusMenuItem(next)
  }

  function toggleProvider(entry: UsageProviderKind) {
    onHiddenProviders(hiddenProviders.includes(entry)
      ? hiddenProviders.filter((kind) => kind !== entry)
      : [...hiddenProviders, entry])
  }

  return (
    <header className="titlebar">
      <div className="titlebar-leading flex min-w-0 items-center gap-2.5">
        <h1>用量</h1>
        <span className="titlebar-slash" aria-hidden="true">/</span>
        <button ref={providerTrigger} type="button" className="provider-trigger" popoverTarget="provider-panel"
          aria-haspopup="menu" aria-controls="provider-panel" aria-expanded={menuOpen} onKeyDown={onTriggerKey}>
          <span>{filterLabel}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <div id="provider-panel" ref={providerPanel} popover="auto" className="provider-panel"
          role="menu" aria-label="提供方" onKeyDown={onProviderMenuKey} onToggle={(event) => {
            const open = event.currentTarget.matches(':popover-open')
            setMenuOpen(open)
            if (open) {
              placePopover(event.currentTarget, providerTrigger.current)
              focusMenuItem(initialItem.current)
            }
            initialItem.current = 0
          }}>
          <button type="button" role="menuitemcheckbox" aria-checked={allVisible}
            tabIndex={activeItem === 0 ? 0 : -1} onFocus={() => setActiveItem(0)}
            onClick={() => onHiddenProviders(allVisible ? [...providers] : [])}>
            <span className="provider-check" aria-hidden="true">{allVisible && <Check size={14} />}</span>
            所有提供方
          </button>
          <hr className="menu-separator" />
          {providerOrder.map((entry, index) => {
            const checked = !hiddenProviders.includes(entry)
            return (
              <button key={entry} type="button" role="menuitemcheckbox" aria-checked={checked}
                tabIndex={activeItem === index + 1 ? 0 : -1} onFocus={() => setActiveItem(index + 1)}
                onClick={() => toggleProvider(entry)}>
                <span className="provider-check" aria-hidden="true">{checked && <Check size={14} />}</span>
                <ProviderMark provider={entry} className="size-3.5" />
                {providerInfo[entry].label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="titlebar-actions">
        {view !== 'limits' && <Segmented label="时间范围" options={ranges} value={range} onChange={onRange} />}
        <Segmented label="用量视图" options={views} value={view} onChange={onView} />
        <div className="titlebar-tools">
          <span role="status" className="sr-only">{!accountsOpen && (showUpdate
            ? updateStatus === 'downloading' ? '正在下载更新' : updateStatus === 'downloaded'
              ? '更新已下载' : updateActionLabel(updates.state, 'capsule')
            : feedback?.text)}</span>
          {showUpdate ? (
            <button type="button" className="action-button titlebar-update" disabled={updates.disabled}
              onClick={() => void updates.run()}>
              {updating && <LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />}
              <span>{updateActionLabel(updates.state, 'capsule')}</span>
            </button>
          ) : feedback && (
            <div className={`titlebar-update-feedback${feedback.error ? ' is-error' : ''}`}>
              <span title={feedback.text} aria-hidden="true">{feedback.text}</span>
              <button type="button" aria-label="关闭更新提示" title="关闭更新提示" onClick={() => {
                updates.dismissFeedback()
                settingsTrigger.current?.focus()
              }}><X size={12} aria-hidden="true" /></button>
            </div>
          )}
          <button type="button" className="icon-button" aria-label={refreshLabel} title={`${refreshLabel} (R)`}
            aria-busy={refreshing} disabled={refreshing} onClick={onRefresh}>
            <RefreshCw size={15} className={refreshing ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
          </button>
          <button ref={settingsTrigger} type="button" className="icon-button" aria-label="设置" title="设置" popoverTarget="settings-panel">
            <Settings2 size={15} aria-hidden="true" />
          </button>
          <div id="settings-panel" ref={settingsPanel} popover="auto" className="settings-panel" aria-label="设置"
            onToggle={(event) => placePopover(event.currentTarget, settingsTrigger.current, true)}>
            <button type="button" aria-haspopup="dialog" onClick={() => choose(onAccounts)}>账号管理</button>
            <button type="button" aria-haspopup="dialog" onClick={() => choose(onPrices)}>自定义模型价格</button>
            <button type="button" disabled={updates.disabled} onClick={() => choose(() => void updates.run())}>
              {updateActionLabel(updates.state, 'menu')}
            </button>
          </div>
          <div className="window-controls">
            <button type="button" className="icon-button" aria-label="最小化" title="最小化" onClick={() => onWindow('minimize')}>
              <Minus size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button" aria-label={maximizeLabel} title={maximizeLabel}
              onClick={() => onWindow('toggleMaximize')}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.4">
                {maximized ? (
                  <>
                    <rect x="2.5" y="4.75" width="8.75" height="8.75" rx="1.4" />
                    <path d="M5.25 4.75V3.9A1.4 1.4 0 0 1 6.65 2.5h5.45A1.4 1.4 0 0 1 13.5 3.9v5.45a1.4 1.4 0 0 1-1.4 1.4h-.85" />
                  </>
                ) : <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" />}
              </svg>
            </button>
            <button type="button" className="icon-button close-window" aria-label="关闭到托盘" title="关闭到托盘" onClick={() => onWindow('hide')}>
              <X size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}

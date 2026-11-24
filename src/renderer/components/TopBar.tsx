import { ChevronDown, Minus, RefreshCw, Settings2, X } from 'lucide-react'
import { useRef } from 'react'
import { providerInfo, providers, ranges, type ProviderFilter, type UsageRange, type UsageView } from '../usagePresentation'

const views = [
  { value: 'cost', label: '费用', shortcut: 'C' },
  { value: 'tokens', label: 'token', shortcut: 'T' },
  { value: 'limits', label: '限制', shortcut: 'L' }
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

export function TopBar({ provider, range, view, refreshing, onProvider, onRange, onView, onRefresh, onPrices, onAccounts, onWindow }: {
  provider: ProviderFilter; range: UsageRange; view: UsageView; refreshing: boolean
  onProvider: (provider: ProviderFilter) => void
  onRange: (range: UsageRange) => void
  onView: (view: UsageView) => void
  onRefresh: () => void
  onPrices: () => void
  onAccounts: () => void
  onWindow: (action: 'minimize' | 'hide') => void
}) {
  const settingsPanel = useRef<HTMLDivElement>(null)
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  const refreshLabel = view === 'limits' ? '刷新额度' : '刷新用量'
  function choose(action: () => void) {
    settingsPanel.current?.hidePopover()
    settingsTrigger.current?.focus()
    action()
  }

  return (
    <header className="titlebar" data-view={view}>
      <div className="titlebar-leading flex min-w-0 items-center gap-2.5">
        <h1 className="shrink-0 text-sm font-semibold">用量</h1>
        <span className="titlebar-slash" aria-hidden="true">/</span>
        <label className="provider-select">
          <select aria-label="提供方" value={provider} onChange={(event) => onProvider(event.currentTarget.value as ProviderFilter)}>
            <option value="all">所有提供方</option>
            {providers.map((entry) => <option key={entry} value={entry}>{providerInfo[entry].label}</option>)}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </label>
      </div>

      <div className="titlebar-actions">
        {view !== 'limits' && <Segmented label="时间范围" options={ranges} value={range} onChange={onRange} />}
        <Segmented label="用量视图" options={views} value={view} onChange={onView} />
        <button type="button" className="icon-button" aria-label={refreshLabel} title={`${refreshLabel} (R)`}
          aria-busy={refreshing} disabled={refreshing} onClick={onRefresh}>
          <RefreshCw size={15} className={refreshing ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
        </button>
        <button ref={settingsTrigger} type="button" className="icon-button" aria-label="设置" title="设置" popoverTarget="settings-panel">
          <Settings2 size={16} aria-hidden="true" />
        </button>
        <div id="settings-panel" ref={settingsPanel} popover="auto" className="settings-panel" aria-label="设置">
          <button type="button" aria-haspopup="dialog" onClick={() => choose(onAccounts)}>账号管理</button>
          <button type="button" aria-haspopup="dialog" onClick={() => choose(onPrices)}>自定义模型价格</button>
        </div>
        <div className="window-controls">
          <button type="button" className="icon-button" aria-label="最小化" title="最小化" onClick={() => onWindow('minimize')}>
            <Minus size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button close-window" aria-label="关闭到托盘" title="关闭到托盘" onClick={() => onWindow('hide')}>
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  )
}

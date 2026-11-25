import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UsageApi } from '../shared/ipc'
import type { UsageProviderKind } from '../shared/types'
import { AccountsDialog } from './components/AccountsDialog'
import { CostTokenView } from './components/CostTokenView'
import { LimitsView } from './components/LimitsView'
import { PriceOverridesDialog } from './components/PriceOverridesDialog'
import { TopBar } from './components/TopBar'
import { TrayPanel } from './components/TrayPanel'
import { UsageModelDialog } from './components/UsageModelDialog'
import { useLimitsData } from './hooks/useLimitsData'
import { useUpdates } from './hooks/useUpdates'
import { useUsageData } from './hooks/useUsageData'
import { ranges, type UsageModel, type UsageRange, type UsageView } from './usagePresentation'
import './styles/globals.css'

declare global {
  interface Window { usageApi: UsageApi }
}

type Modal = { kind: 'model'; model: UsageModel } | { kind: 'prices'; model?: string } | { kind: 'accounts' }

function App() {
  const [range, setRange] = useState<UsageRange>('30d')
  const [view, setView] = useState<UsageView>('cost')
  const modifiedPreferences = useRef({ window: false, tab: false, hiddenProviders: false })
  const [hiddenProviders, setHiddenProviders] = useState<UsageProviderKind[]>([])
  const hiddenProviderSet = useMemo(() => new Set(hiddenProviders), [hiddenProviders])
  const [modal, setModal] = useState<Modal | null>(null)
  const [windowError, setWindowError] = useState('')
  const [maximized, setMaximized] = useState(false)
  const maximizedRevision = useRef(0)
  const { summary, query, pending, refreshing, failed, refresh, reprice } = useUsageData(range)
  const limits = useLimitsData()
  const updates = useUpdates()
  const activeRefreshing = view === 'limits' ? limits.refreshing : refreshing
  const refreshActive = view === 'limits' ? limits.refresh : refresh
  const seenModels = useMemo(() => [...new Set(summary?.buckets.map((bucket) => bucket.model))], [summary])

  const runWindowAction = useCallback(async (action: 'minimize' | 'toggleMaximize' | 'hide') => {
    setWindowError('')
    try {
      if (action === 'toggleMaximize') {
        const revision = ++maximizedRevision.current
        const next = await window.usageApi.toggleMaximize()
        if (revision === maximizedRevision.current) setMaximized(next)
      } else {
        await window.usageApi[action]()
      }
    } catch {
      const messages = {
        minimize: '无法最小化窗口。',
        toggleMaximize: '无法切换窗口最大化状态。',
        hide: '无法将窗口隐藏到托盘。'
      }
      setWindowError(messages[action])
    }
  }, [])

  useEffect(() => {
    let active = true
    const revision = maximizedRevision.current
    // Native changes supersede any in-flight window state query or action response.
    const unsubscribe = window.usageApi?.onMaximizedChanged?.((next) => {
      if (!active) return
      maximizedRevision.current++
      setMaximized(next)
    })
    void window.usageApi?.isMaximized?.().then((next) => {
      if (active && revision === maximizedRevision.current) setMaximized(next)
    }).catch(() => undefined)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.usageApi.getUiPreferences().then(preferences => {
      if (!active) return
      if (preferences.window && !modifiedPreferences.current.window) setRange(preferences.window)
      if (preferences.tab && !modifiedPreferences.current.tab) setView(preferences.tab)
      if (preferences.hiddenProviders && !modifiedPreferences.current.hiddenProviders) {
        setHiddenProviders([...new Set(preferences.hiddenProviders)])
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  const selectRange = useCallback((next: UsageRange) => {
    modifiedPreferences.current.window = true
    setRange(next)
    void window.usageApi.saveUiPreferences({ window: next }).catch(() => undefined)
  }, [])

  const selectView = useCallback((next: UsageView) => {
    modifiedPreferences.current.tab = true
    setView(next)
    void window.usageApi.saveUiPreferences({ tab: next }).catch(() => undefined)
  }, [])

  const selectHiddenProviders = useCallback((next: UsageProviderKind[]) => {
    modifiedPreferences.current.hiddenProviders = true
    setHiddenProviders(next)
    void window.usageApi.saveUiPreferences({ hiddenProviders: next }).catch(() => undefined)
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat || modal ||
          document.querySelector(':popover-open, dialog[open]')) return
      const target = event.target
      if (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest('input, select, textarea'))) return
      if (event.key === 'Escape') {
        event.preventDefault()
        void runWindowAction('hide')
      } else if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && view !== 'limits') {
        const match = /^(?:Digit|Numpad)([1-4])$/.exec(event.code)
        if (match) {
          event.preventDefault()
          selectRange(ranges[Number(match[1]) - 1].value)
        }
      } else if (!event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        const key = event.key.toLowerCase()
        if (key === 'r' && !activeRefreshing) {
          event.preventDefault()
          void refreshActive()
        } else if (key === 'c' || key === 't' || key === 'l') {
          event.preventDefault()
          selectView(key === 'c' ? 'cost' : key === 't' ? 'tokens' : 'limits')
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeRefreshing, modal, refreshActive, runWindowAction, selectRange, selectView, view])

  const metric = view === 'tokens' ? 'tokens' : 'cost'
  return (
    <div className="app-shell">
      <TopBar hiddenProviders={hiddenProviders} range={range} view={view} refreshing={activeRefreshing} maximized={maximized}
        updates={updates} accountsOpen={modal?.kind === 'accounts'}
        onHiddenProviders={selectHiddenProviders} onRange={selectRange} onView={selectView} onRefresh={refreshActive}
        onPrices={() => setModal({ kind: 'prices' })} onAccounts={() => setModal({ kind: 'accounts' })}
        onWindow={(action) => void runWindowAction(action)} />
      <main className="app-scroll">
        <div className="usage-container">
          {(windowError || (view !== 'limits' && failed)) && (
            <div className="inline-notice notice-error" role="alert">
              {windowError && <p>{windowError}</p>}
              {view !== 'limits' && failed && <div className="flex flex-wrap items-center gap-3">
                <p>{summary ? '无法更新用量，仍显示上次读取的数据。' : '无法读取用量。'}</p>
                <button type="button" className="action-button" onClick={refresh}>重试</button>
              </div>}
            </div>
          )}
          {view === 'limits' ? <LimitsView report={limits.report} hiddenProviders={hiddenProviderSet} loading={limits.loading}
            refreshing={limits.refreshing} failed={limits.failed} onRefresh={limits.refresh} onReport={limits.applyReport} /> :
            summary && query ? <CostTokenView summary={summary} query={query} metric={metric} hiddenProviders={hiddenProviderSet}
              pending={pending} onModel={(model) => setModal({ kind: 'model', model })} /> :
              pending ? <UsageSkeleton /> : null}
        </div>
      </main>
      {modal?.kind === 'model' && summary && query && (
        <UsageModelDialog model={modal.model} buckets={summary.buckets} query={query} hiddenProviders={hiddenProviderSet} metric={metric}
          onClose={() => setModal(null)} onPrice={() => setModal({ kind: 'prices', model: modal.model.model })} />
      )}
      {modal?.kind === 'prices' && (
        <PriceOverridesDialog initialModel={modal.model} models={seenModels} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); reprice() }} />
      )}
      {modal?.kind === 'accounts' && <AccountsDialog updates={updates} onChanged={refresh}
        onClose={() => { updates.dismissFeedback(); setModal(null) }} />}
    </div>
  )
}

function UsageSkeleton() {
  return (
    <div className="usage-overview" aria-busy="true">
      <p role="status" className="sr-only">正在读取用量</p>
      <div className="usage-hero" aria-hidden="true">
        <div className="usage-overview-side">
          <div className="space-y-2"><div className="skeleton h-10 w-32" /><div className="skeleton h-3 w-24" /></div>
          {[0, 1, 2, 3].map((index) => <div key={index} className="space-y-2">
            <div className="skeleton h-3 w-3/4" /><div className="skeleton h-2.5 w-1/2" />
          </div>)}
        </div>
        <div className="flex flex-col gap-3">
          <div className="skeleton h-4 w-20" />
          <div className="skeleton skeleton-chart" />
        </div>
      </div>
      <section>
        <h2 className="section-title">总计</h2>
        <div className="totals-grid mt-2" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((index) => <div key={index} className="space-y-2">
            <div className="skeleton h-3 w-16" /><div className="skeleton h-5 w-14" />
          </div>)}
        </div>
      </section>
    </div>
  )
}

const root = document.getElementById('root')
if (root) {
  const tray = location.hash === '#tray'
  if (tray) document.documentElement.dataset.view = 'tray'
  createRoot(root).render(tray ? <TrayPanel /> : <App />)
}

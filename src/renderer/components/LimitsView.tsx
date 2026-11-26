import { ArrowUpRight, CircleHelp, Clock3, Gauge, LoaderCircle, Ticket, TrendingDown, TrendingUp, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AccountView, ConsumeResetCreditOutcome, LimitAccountIssue, LimitsReport } from '../../shared/limitsTypes'
import type { UsageProviderKind } from '../../shared/types'
import { poolUsageLimits, type PooledLimitAccount, type PooledLimitWindow } from '../../shared/usageLimits'
import {
  formatLimitPercent, limitDateTime, limitIssueGuidance, limitTimeLeft,
  resetBadgeDuration, resetCreditText, resetDetailTime, visibleLimitIssues,
  type LimitIssueReason
} from '../limitsPresentation'
import { providerInfo } from '../usagePresentation'
import { accountSwitchErrorMessage, SwitchAccountConfirmation } from './AccountsDialog'
import { ProviderMark } from './ProviderMark'
import { UsageDialog } from './UsageDialog'
import '../styles/limits.css'

type Anchor = { key: string; button: HTMLButtonElement }
type Selection = Anchor & { mode: 'hover' | 'focus' | 'pinned' }
type ResetTarget = { anchor: Anchor; accountId: string; displayName: string }
type Feedback = { message: string; error: boolean }
// Electron supports the source option before the version of lib.dom used here.
type AnchoredPopover = HTMLDivElement & { showPopover(options: { source: HTMLElement }): void }

const resetMessages: Record<ConsumeResetCreditOutcome, string> = {
  reset: '重置已生效，限额窗口已清零。',
  nothingToReset: '当前没有需要重置的限额窗口。',
  noCredit: '没有可用的重置券。',
  alreadyRedeemed: '该重置券已被使用。'
}

const limitsProviders = ['codex', 'claude', 'opencode', 'antigravity'] as const

const segmentKey = (pool: PooledLimitWindow, account: PooledLimitAccount) =>
  JSON.stringify([pool.provider, pool.kind, pool.windowId, account.id])

// A provider's pill row and every window's segment row share this one account order,
// so a member missing from a window still keeps its column as an inert placeholder.
interface AccountColumn {
  id: string
  displayName: string
  origin: PooledLimitAccount['origin']
  current?: boolean
  canSwitch?: boolean
}

const byAccountOrder = (a: AccountColumn, b: AccountColumn) =>
  Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
  a.displayName.localeCompare(b.displayName, 'zh-CN') || a.id.localeCompare(b.id)

export function LimitsView({ report, hiddenProviders, loading, refreshing, failed, onRefresh, onReport, onOpenAccounts }: {
  report: LimitsReport | null
  hiddenProviders: ReadonlySet<UsageProviderKind>
  loading: boolean
  refreshing: boolean
  failed: boolean
  onRefresh: () => void
  onReport: (report: LimitsReport) => void
  onOpenAccounts: () => void
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(interval)
  }, [])
  const accounts = report?.accounts
  const pools = useMemo(() => poolUsageLimits(accounts ?? [], now), [accounts, now])
  const issues = useMemo(() => visibleLimitIssues(report?.issues, hiddenProviders), [report?.issues, hiddenProviders])
  const issueIds = useMemo(() => new Set(issues.map(({ id }) => id)), [issues])
  const accountViews = useMemo(() => new Map((accounts ?? []).map((account) => [account.id, account])), [accounts])
  const sections = limitsProviders.filter((provider) => !hiddenProviders.has(provider)).map((provider) => {
    const windows = pools.filter((pool) => pool.provider === provider)
    const columns = new Map<string, AccountColumn>()
    for (const pool of windows) {
      for (const account of pool.accounts) if (!columns.has(account.id)) columns.set(account.id, account)
    }
    // An account whose last read failed can have no cached windows at all; keep
    // its pill so the diagnostic stays discoverable instead of disappearing.
    for (const issue of issues.filter((issue) => issue.provider === provider)) {
      if (columns.has(issue.id)) continue
      const view = accountViews.get(issue.id)
      columns.set(issue.id, {
        id: issue.id, displayName: issue.displayName, origin: issue.origin,
        current: view?.current, canSwitch: view?.canSwitch
      })
    }
    return { provider, windows, accounts: [...columns.values()].sort(byAccountOrder) }
  }).filter((section) => section.accounts.length > 0)

  const viewRef = useRef<HTMLElement>(null)
  const popoverRef = useRef<AnchoredPopover>(null)
  const nativeSource = useRef<HTMLButtonElement>(null)
  const creditButton = useRef<HTMLButtonElement>(null)
  const popoverId = useId()
  const [selection, setSelection] = useState<Selection | null>(null)
  const activeRef = useRef<Selection | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const restoringFocus = useRef(false)
  const [confirming, setConfirming] = useState<ResetTarget | null>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<ResetTarget | null>(null)
  const focusAfterDialog = useRef<Anchor | null>(null)
  const [redeeming, setRedeeming] = useState<ReadonlySet<string>>(() => new Set())
  const pending = useRef(new Set<string>())
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [switchTarget, setSwitchTarget] = useState<AccountView | null>(null)
  const [switchBusy, setSwitchBusy] = useState(false)
  const [switchError, setSwitchError] = useState('')
  const detail = selection && findSegment(sections, selection.key)
  const issue = selection && findIssue(issues, selection.key)
  const hasDetail = Boolean(detail || issue)
  const issueAccount = issue
    ? sections.flatMap(({ accounts }) => accounts).find(({ id }) => id === issue.id)
    : undefined

  function clearTimer() {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(() => clearTimer, [])

  function select(next: Selection | null) {
    activeRef.current = next
    setSelection(next)
  }

  function restoreFocus(anchor: Anchor | null) {
    restoringFocus.current = true
    try {
      const target = anchor?.button.isConnected ? anchor.button : viewRef.current
      target?.focus({ preventScroll: true })
    } finally {
      restoringFocus.current = false
    }
  }

  function closePopover(returnFocus = false) {
    clearTimer()
    const previous = activeRef.current
    select(null)
    const panel = popoverRef.current
    restoringFocus.current = true
    try {
      if (panel?.matches(':popover-open')) panel.hidePopover()
      nativeSource.current = null
    } finally {
      restoringFocus.current = false
    }
    if (returnFocus) restoreFocus(previous)
  }

  function delayedClose(anchor: Anchor) {
    clearTimer()
    timer.current = window.setTimeout(() => {
      if (activeRef.current?.key === anchor.key && activeRef.current.mode === 'hover') closePopover()
    }, 120)
  }

  const [keyboardTarget, setKeyboardTarget] = useState<Anchor | null>(null)
  useLayoutEffect(() => {
    const panel = popoverRef.current
    if (!panel) return
    if (!selection || !hasDetail || !selection.button.isConnected) {
      if (selection) closePopover()
      return
    }
    const anchor = selection.button
    // Hover-to-hover movement does not remount the layer. For keyboard/focus
    // activation, give the layer the actual invoker for native Tab ordering.
    if (panel.matches(':popover-open') && selection.mode !== 'hover' && nativeSource.current !== anchor) {
      restoringFocus.current = true
      try { panel.hidePopover() } finally { restoringFocus.current = false }
    }
    if (!panel.matches(':popover-open')) {
      nativeSource.current = anchor
      panel.showPopover({ source: anchor })
    }
    function position() {
      if (!anchor.isConnected || !panel?.matches(':popover-open')) return
      const bounds = anchor.getBoundingClientRect()
      const { width, height } = panel.getBoundingClientRect()
      const viewport = document.documentElement
      const left = Math.max(12, Math.min(
        bounds.left + (bounds.width - width) / 2, viewport.clientWidth - width - 12))
      const above = bounds.top - height - 6
      const below = bounds.bottom + 6
      const issueAnchor = selection?.key.startsWith('issue:')
      const top = issueAnchor ? below : above >= 12 || viewport.clientHeight - below < bounds.top
        ? above : below
      panel.style.left = `${left}px`
      panel.style.top = `${Math.max(12, Math.min(top, viewport.clientHeight - height - 12))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    observer.observe(panel)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [selection, hasDetail])

  useLayoutEffect(() => {
    if (!keyboardTarget) return
    if (keyboardTarget.key === selection?.key && popoverRef.current?.matches(':popover-open')) {
      popoverRef.current.focus({ preventScroll: true })
    }
    setKeyboardTarget(null)
  }, [keyboardTarget, selection])

  useLayoutEffect(() => {
    if (confirming) {
      cancelButton.current?.focus({ preventScroll: true })
      return
    }
    if (!focusAfterDialog.current) return
    const anchor = focusAfterDialog.current
    focusAfterDialog.current = null
    restoreFocus(anchor)
  }, [confirming])

  function openConfirmation(anchor: Anchor, account: PooledLimitAccount) {
    if (pending.current.has(account.id) || confirmRef.current) return
    const target = { anchor, accountId: account.id, displayName: account.displayName }
    confirmRef.current = target
    closePopover(true)
    setConfirming(target)
  }

  function closeConfirmation() {
    const target = confirmRef.current
    if (!target) return
    confirmRef.current = null
    focusAfterDialog.current = target.anchor
    setConfirming(null)
  }

  async function confirmReset() {
    const target = confirmRef.current
    if (!target || pending.current.has(target.accountId)) return
    const { accountId } = target
    pending.current.add(accountId)
    closeConfirmation()
    setRedeeming(new Set(pending.current))
    setFeedback(null)
    try {
      const result = await window.usageApi.consumeResetCredit(accountId)
      onReport(result.report)
      setFeedback({ message: result.warning || resetMessages[result.outcome], error: false })
    } catch (error) {
      const detail = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : ''
      setFeedback({ message: detail ? `无法使用重置券：${detail}` : '无法使用重置券，请稍后重试。', error: true })
    } finally {
      pending.current.delete(accountId)
      setRedeeming(new Set(pending.current))
    }
  }

  async function confirmSwitch() {
    if (!switchTarget || switchBusy) return
    setSwitchBusy(true)
    setSwitchError('')
    try {
      await window.usageApi.switchAccount(switchTarget.id)
      setSwitchTarget(null)
      onRefresh()
    } catch (error) {
      setSwitchError(accountSwitchErrorMessage(error))
    } finally {
      setSwitchBusy(false)
    }
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !popoverRef.current?.matches(':popover-open')) return
    event.preventDefault()
    closePopover(true)
  }

  const interaction: SegmentInteraction = {
    id: popoverId,
    openKey: hasDetail ? selection?.key : undefined,
    enter(anchor) {
      clearTimer()
      const previous = activeRef.current
      if (confirmRef.current || previous?.key === anchor.key ||
        previous?.mode === 'pinned' || popoverRef.current?.contains(document.activeElement)) return
      const show = () => select({ ...anchor, mode: 'hover' })
      if (previous) show()
      else timer.current = window.setTimeout(() => { if (anchor.button.isConnected) show() }, 100)
    },
    leave: delayedClose,
    focus(anchor) {
      if (restoringFocus.current || confirmRef.current || !anchor.button.matches(':focus-visible')) return
      clearTimer()
      if (activeRef.current?.key !== anchor.key || activeRef.current.mode === 'hover') select({ ...anchor, mode: 'focus' })
    },
    blur(anchor, next) {
      if (activeRef.current?.key === anchor.key && activeRef.current.mode === 'focus' &&
        !(next instanceof Node && popoverRef.current?.contains(next))) closePopover()
    },
    click(anchor, keyboard) {
      clearTimer()
      if (activeRef.current?.key === anchor.key && activeRef.current.mode === 'pinned') {
        closePopover(keyboard)
      } else {
        select({ ...anchor, mode: 'pinned' })
        if (keyboard) setKeyboardTarget(anchor)
      }
    },
    keyDown(event, key) {
      if (activeRef.current?.key !== key) return
      handleEscape(event)
      if (event.key === 'Tab' && !event.shiftKey && creditButton.current && !creditButton.current.disabled) {
        event.preventDefault()
        creditButton.current.focus({ preventScroll: true })
      }
    }
  }

  return (
    <section ref={viewRef} tabIndex={-1} aria-label="账号" className="limits-view">
      {failed && (
        <div className="inline-notice flex flex-wrap items-center gap-3" role="alert">
          <p>{sections.length ? '无法更新额度，仍显示上次读取的数据。' : '无法读取额度。'}</p>
          <button type="button" className="action-button" disabled={refreshing} onClick={onRefresh}>重试</button>
        </div>
      )}
      {sections.length === 0 && (loading || refreshing ? (
        <div className="limits-loading" role="status">
          <span className="sr-only">正在读取额度</span>
          <div aria-hidden="true" className="skeleton h-4 w-28" />
          <div aria-hidden="true" className="skeleton h-24 w-full" />
          <div aria-hidden="true" className="skeleton h-24 w-full" />
        </div>
      ) : !failed && <p className="view-placeholder">暂无可用额度</p>)}
      {sections.map((section) => (
        <section key={section.provider} aria-labelledby={`limits-${section.provider}`} className="limits-provider">
          <div className="limits-provider-header">
            <h2 id={`limits-${section.provider}`} className="limits-provider-heading">
              <ProviderMark provider={section.provider} className="size-4" />
              {providerInfo[section.provider].label}
            </h2>
            <div className="limit-account-pills" role="group" aria-label="账号"
              style={{ gridTemplateColumns: `repeat(${section.accounts.length}, minmax(0, 1fr))` }}>
              {section.accounts.map((account) => (
                <LimitAccountPill key={account.id} account={account} provider={section.provider}
                  issue={issues.find((candidate) => candidate.id === account.id)} refreshing={refreshing}
                  interaction={interaction}
                  onSwitch={() => {
                    setSwitchError('')
                    setSwitchTarget({
                      id: account.id, provider: section.provider, displayName: account.displayName,
                      origin: account.origin, enabled: true, current: account.current, canSwitch: account.canSwitch,
                      hasCredential: true
                    })
                  }} />
              ))}
            </div>
          </div>
          {section.windows.map((pool) => (
            <LimitWindowCard key={`${pool.kind}/${pool.windowId}`} pool={pool} now={now} refreshing={refreshing}
              interaction={interaction} columns={section.accounts} issueIds={issueIds} />
          ))}
          {section.provider === 'codex' && <div role="status" className={feedback ? 'limit-reset-feedback' : 'sr-only'}
            data-error={Boolean(feedback?.error)}>{feedback?.message}</div>}
        </section>
      ))}
      {!hiddenProviders.has('codex') && feedback && !sections.some(({ provider }) => provider === 'codex') &&
        <p role="status" className="limit-reset-feedback" data-error={feedback.error}>{feedback.message}</p>}
      <div id={popoverId} ref={popoverRef} className="limit-popover" popover="auto" role="group" tabIndex={-1}
        aria-labelledby={`${popoverId}-title`}
        onToggle={(event) => { if (event.newState === 'closed' && !event.currentTarget.matches(':popover-open')) closePopover() }}
        onKeyDown={(event) => {
          handleEscape(event)
          if (event.key === 'Tab' && event.shiftKey && activeRef.current) {
            event.preventDefault()
            restoreFocus(activeRef.current)
          }
        }}
        onPointerEnter={clearTimer}
        onPointerLeave={() => { if (activeRef.current) delayedClose(activeRef.current) }}
        onBlur={(event) => {
          const active = activeRef.current
          if (!restoringFocus.current && active && event.relatedTarget !== active.button &&
              !event.currentTarget.contains(event.relatedTarget)) closePopover()
        }}>
        {selection && detail && (
          <LimitDetails id={`${popoverId}-title`} account={detail.account} provider={detail.pool.provider} now={now}
            redeeming={redeeming.has(detail.account.id)} creditButton={creditButton}
            onReset={() => openConfirmation(selection, detail.account)} />
        )}
        {selection && issue && (
          <LimitIssueGuide key={issue.id} id={`${popoverId}-title`} issue={issue} account={issueAccount}
            refreshing={refreshing} onRefresh={onRefresh}
            onOpenAccounts={() => { closePopover(); onOpenAccounts() }} />
        )}
      </div>
      {confirming && (
        <UsageDialog title="使用重置券？"
          subtitle={`这将消耗「${confirming.displayName}」的 1 张重置券并立即清零当前限额窗口，操作不可撤销。`}
          onClose={closeConfirmation}>
          <div className="confirm-actions">
            <button ref={cancelButton} type="button" className="action-button" onClick={closeConfirmation}>取消</button>
            <button type="button" className="action-button primary-action" onClick={() => void confirmReset()}>确认使用</button>
          </div>
        </UsageDialog>
      )}
      {switchTarget && (
        <SwitchAccountConfirmation account={switchTarget} busy={switchBusy} error={switchError}
          onCancel={() => { setSwitchTarget(null); setSwitchError('') }} onConfirm={() => void confirmSwitch()} />
      )}
    </section>
  )
}

interface SegmentInteraction {
  id: string
  openKey?: string
  enter(anchor: Anchor): void
  leave(anchor: Anchor): void
  focus(anchor: Anchor): void
  blur(anchor: Anchor, next: EventTarget | null): void
  click(anchor: Anchor, keyboard: boolean): void
  keyDown(event: KeyboardEvent<HTMLButtonElement>, key: string): void
}

function findSegment(sections: { windows: PooledLimitWindow[] }[], key: string) {
  for (const { windows } of sections) {
    for (const pool of windows) {
      const account = pool.accounts.find((account) => segmentKey(pool, account) === key)
      if (account) return { pool, account }
    }
  }
  return null
}

const issueKey = (id: string) => `issue:${id}`

function findIssue(issues: readonly LimitAccountIssue[], key: string) {
  return issues.find(({ id }) => issueKey(id) === key)
}

function LimitWindowCard({ pool, now, refreshing, interaction, columns, issueIds }: {
  pool: PooledLimitWindow
  now: number
  refreshing: boolean
  interaction: SegmentInteraction
  columns: readonly AccountColumn[]
  issueIds: ReadonlySet<string>
}) {
  const titleId = useId()
  const next = pool.nextReset
  const showRecovery = pool.accounts.length > 1 && next && next.recoveryPercent > 0 && Date.parse(next.at) > now
  const shown = new Map(pool.accounts.map((account) => [account.id, account]))
  return (
    <article className="limit-window" aria-labelledby={titleId} style={{ '--limit-color': providerInfo[pool.provider].color } as CSSProperties}>
      <div className="limit-summary">
        <h3 id={titleId} className="limit-window-label">{pool.label}</h3>
        <div className="limit-metric">
          <span className="limit-percent">{Math.round(pool.meanRemainingPercent)}%</span>
          <span className="limit-metric-label">剩余</span>
          {pool.trend && <LimitTrend trend={pool.trend} />}
        </div>
        {showRecovery && <span className="limit-recovery">
          <span aria-hidden="true">↻ </span><span className="sr-only">下次重置恢复</span>+{Math.round(next.recoveryPercent)}%
        </span>}
      </div>
      <div className="limit-accounts" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((column) => {
          const account = shown.get(column.id)
          const hasIssue = issueIds.has(column.id)
          return account
            ? <LimitAccountSegment key={column.id} account={account} now={now} provider={pool.provider}
              accountKey={segmentKey(pool, account)} accountCount={pool.accounts.length}
              hasIssue={hasIssue} refreshing={refreshing} interaction={interaction} />
            : <span key={column.id} className="limit-account-slot" data-issue={hasIssue || undefined}
              data-refreshing={refreshing || undefined} aria-hidden="true" />
        })}
      </div>
    </article>
  )
}

function LimitAccountPill({ account, provider, issue, refreshing, interaction, onSwitch }: {
  account: AccountColumn
  provider: UsageProviderKind
  issue?: LimitAccountIssue
  refreshing: boolean
  interaction: SegmentInteraction
  onSwitch: () => void
}) {
  const name = <span className="limit-pill-name">{account.displayName}</span>
  if (issue) {
    const key = issueKey(account.id)
    const anchor = (button: HTMLButtonElement): Anchor => ({ key, button })
    const warning = refreshing
      ? <LoaderCircle size={13} className="limit-pill-warning motion-safe:animate-spin" aria-hidden="true" />
      : <TriangleAlert size={13} className="limit-pill-warning" aria-hidden="true" />
    return (
      <button type="button" className="limit-account-pill" data-issue="true"
        data-current={account.current ? 'true' : undefined}
        aria-controls={interaction.id} aria-expanded={interaction.openKey === key}
        onPointerEnter={(event) => { if (event.pointerType !== 'touch') interaction.enter(anchor(event.currentTarget)) }}
        onPointerLeave={(event) => { if (event.pointerType !== 'touch') interaction.leave(anchor(event.currentTarget)) }}
        onFocus={(event) => interaction.focus(anchor(event.currentTarget))}
        onBlur={(event) => interaction.blur(anchor(event.currentTarget), event.relatedTarget)}
        onClick={(event) => interaction.click(anchor(event.currentTarget), event.detail === 0)}
        onKeyDown={(event) => interaction.keyDown(event, key)}>
        {name}
        {account.current && <span className="limit-pill-current">当前</span>}
        {warning}
        <span className="sr-only">，额度读取异常</span>
      </button>
    )
  }
  const switchable = !account.current && account.canSwitch && (provider === 'codex' || provider === 'antigravity')
  if (switchable) {
    return (
      <button type="button" className="limit-account-pill" data-switchable="true"
        title={`切换到 ${account.displayName}`} onClick={onSwitch}>
        {name}
        <span className="limit-pill-hint" aria-hidden="true">切换</span>
      </button>
    )
  }
  return (
    <span className="limit-account-pill" data-current={account.current ? 'true' : undefined} title={account.displayName}>
      {name}
      {account.current && <span className="limit-pill-current">当前</span>}
    </span>
  )
}

export function LimitIssueGuide({ id, issue, account, refreshing, onRefresh, onOpenAccounts }: {
  id: string
  issue: LimitAccountIssue
  account?: AccountColumn
  refreshing: boolean
  onRefresh: () => void
  onOpenAccounts: () => void
}) {
  const guidance = limitIssueGuidance(issue, Boolean(account?.current))

  return (
    <>
      <div className="limit-issue-header">
        <h4 id={id}>
          {refreshing
            ? <LoaderCircle size={14} className="limit-pill-warning motion-safe:animate-spin" aria-hidden="true" />
            : <TriangleAlert size={14} className="limit-pill-warning" aria-hidden="true" />}
          <span className="limit-account-name" title={issue.displayName}>{issue.displayName}</span>
        </h4>
        {guidance.installReason && <InstallReasonHelp reason={guidance.installReason} />}
      </div>
      <p className="limit-issue-guidance">{guidance.message}</p>
      {guidance.installUrl && (
        <button type="button" className="limit-install-link"
          onClick={() => void window.usageApi.openExternalUrl(guidance.installUrl!).catch(() => undefined)}>
          <span>{guidance.installUrl}</span>
          <ArrowUpRight size={13} aria-hidden="true" />
        </button>
      )}
      <div className="limit-detail-group limit-issue-actions">
        {guidance.accountManagement && <button type="button" className="limit-reset-action" onClick={onOpenAccounts}>账号管理</button>}
        <button type="button" className="limit-reset-action" aria-disabled={refreshing} aria-busy={refreshing}
          onClick={() => { if (!refreshing) onRefresh() }}>
          {refreshing
            ? <><LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />重试中…</>
            : '重试'}
        </button>
      </div>
    </>
  )
}

export function InstallReasonHelp({ reason }: { reason: LimitIssueReason }) {
  const tipId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ open: boolean; left?: number; top?: number; below?: boolean }>({ open: false })

  useLayoutEffect(() => {
    if (!pos.open || !buttonRef.current || !tipRef.current) return
    function place() {
      const button = buttonRef.current
      const tip = tipRef.current
      if (!button || !tip) return
      const rect = button.getBoundingClientRect()
      const tipWidth = tip.offsetWidth
      const tipHeight = tip.offsetHeight
      const left = Math.round(Math.min(
        Math.max(8, rect.right - tipWidth),
        Math.max(8, window.innerWidth - tipWidth - 8)
      ))
      const below = rect.top - tipHeight - 6 < 8
      const top = Math.round(below ? rect.bottom + 6 : rect.top - tipHeight - 6)
      setPos((current) => !current.open || (current.left === left && current.top === top && current.below === below)
        ? current : { open: true, left, top, below })
    }
    place()
    const close = () => setPos({ open: false })
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [pos.open])

  return (
    <>
      <button ref={buttonRef} type="button" className="limit-issue-why"
        aria-label={reason.title} aria-describedby={pos.open ? tipId : undefined}
        onPointerEnter={(event) => { if (event.pointerType !== 'touch') setPos({ open: true }) }}
        onPointerLeave={() => setPos({ open: false })}
        onFocus={() => setPos({ open: true })}
        onBlur={() => setPos({ open: false })}>
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {pos.open && (
        <span ref={tipRef} id={tipId} role="tooltip" className="limit-why-tip"
          data-placement={pos.below ? 'below' : 'above'}
          style={{
            left: pos.left ?? 8,
            top: pos.top ?? 8,
            visibility: pos.left === undefined ? 'hidden' : 'visible'
          }}>
          <strong>{reason.title}</strong>
          <span>{reason.body}</span>
        </span>
      )}
    </>
  )
}

const trends = {
  ahead: { icon: TrendingUp, label: '消耗偏快' },
  on: { icon: Gauge, label: '消耗平稳' },
  under: { icon: TrendingDown, label: '消耗偏慢' }
}

function LimitTrend({ trend }: { trend: NonNullable<PooledLimitWindow['trend']> }) {
  const { icon: Icon, label } = trends[trend.pace]
  const description = `${label}，按时间均匀使用应剩余 ${formatLimitPercent(trend.expectedRemainingPercent)}`
  return <span className="limit-trend" role="img" aria-label={description} title={description}><Icon size={14} aria-hidden="true" /></span>
}

function LimitAccountSegment({ account, now, provider, accountKey, accountCount, hasIssue, refreshing, interaction }: {
  account: PooledLimitAccount
  now: number
  provider: UsageProviderKind
  accountKey: string
  accountCount: number
  hasIssue: boolean
  refreshing: boolean
  interaction: SegmentInteraction
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [canDrawTick, setCanDrawTick] = useState(false)
  const timeLeft = limitTimeLeft(account, now)
  const timed = timeLeft !== null
  useLayoutEffect(() => {
    const node = button.current
    if (!node || !timed) return
    setCanDrawTick(node.getBoundingClientRect().width >= 6)
    const observer = new ResizeObserver(([entry]) => setCanDrawTick(entry.contentRect.width >= 6))
    observer.observe(node)
    return () => observer.disconnect()
  }, [timed])
  const tick = timed && canDrawTick ? `clamp(3px, ${timeLeft}%, calc(100% - 3px))` : null
  const reset = resetBadgeDuration(account.resetsAt, now)
  const credits = provider === 'codex' ? account.resetCredits ?? 0 : 0
  const remaining = account.remainingPercent
  const refill = Math.min(100 - remaining, (account.recoveryPercent ?? 0) * accountCount)
  const caption = [
    `${account.displayName}，剩余 ${Math.round(remaining)}%`,
    reset ? (reset.startsWith('↻ ') ? `${reset.slice(2)}后重置` : reset) : null,
    credits > 0 ? `${credits} 张重置券` : null,
    account.stale ? '缓存数据' : null
  ].filter(Boolean).join('，')
  const anchor = (element: HTMLButtonElement): Anchor => ({ key: accountKey, button: element })
  const open = interaction.openKey === accountKey

  return (
    <button ref={button} type="button" className="limit-segment" aria-label={caption} title={account.displayName}
      aria-controls={interaction.id} aria-expanded={open} data-open={open}
      data-issue={hasIssue || undefined} data-refreshing={refreshing || undefined}
      style={tick ? { '--limit-tick-at': tick } as CSSProperties : undefined}
      data-pace={Boolean(tick)}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') interaction.enter(anchor(event.currentTarget)) }}
      onPointerLeave={(event) => { if (event.pointerType !== 'touch') interaction.leave(anchor(event.currentTarget)) }}
      onFocus={(event) => interaction.focus(anchor(event.currentTarget))}
      onBlur={(event) => interaction.blur(anchor(event.currentTarget), event.relatedTarget)}
      onClick={(event) => interaction.click(anchor(event.currentTarget), event.detail === 0)}
      onKeyDown={(event) => interaction.keyDown(event, accountKey)}>
      <span className="limit-segment-track" aria-hidden="true">
        <span className="limit-fill" style={{ width: `${remaining}%` }} />
        {refill > 0 && <span className="limit-refill" style={{ width: `${refill}%` }} />}
      </span>
      {tick && <span className="limit-pace-tick" aria-hidden="true" />}
      <span className="limit-segment-content" aria-hidden="true">
        <strong className="limit-account-percent">{Math.round(remaining)}%</strong>
        {(reset || credits > 0 || account.stale) && <span className="limit-badge">
          {reset && <span className="limit-badge-time">{reset}</span>}
          {credits > 0 && <>
            {reset && <span className="limit-badge-muted">·</span>}
            <span className="limit-badge-credit"><Ticket size={12} />{credits}</span>
          </>}
          {account.stale && <Clock3 size={11} className={hasIssue ? 'limit-badge-warning' : 'limit-badge-muted'} />}
        </span>}
      </span>
    </button>
  )
}

export function LimitDetails({ id, account, provider, now, redeeming, creditButton, onReset }: {
  id: string
  account: PooledLimitAccount
  provider: UsageProviderKind
  now: number
  redeeming: boolean
  creditButton: RefObject<HTMLButtonElement | null>
  onReset: () => void
}) {
  const resetAt = resetDetailTime(account.resetsAt, now)
  const checkedAt = limitDateTime(account.checkedAt)
  const timeLeft = limitTimeLeft(account, now)
  const recovery = account.recoveryPercent ?? 0
  const credits = provider === 'codex' ? account.resetCredits ?? 0 : 0

  return (
    <>
      <h4 id={id}>
        <ProviderMark provider={provider} className="size-4" />
        <span className="limit-account-name" title={account.displayName}>{account.displayName}</span>
      </h4>
      <dl className="limit-metrics">
        <Detail label="剩余">{formatLimitPercent(account.remainingPercent)}</Detail>
        {resetAt && <Detail label="重置时间"><time dateTime={account.resetsAt}>{resetAt}</time></Detail>}
        {timeLeft !== null && <Detail label="匀速进度">此时应剩余 {Math.round(timeLeft)}%</Detail>}
        {recovery > 0 && <Detail label="恢复">+{Math.round(recovery)}%（按共享池总额度计算）</Detail>}
        {account.stale && <Detail label="刷新时间">
          {checkedAt ? <time dateTime={account.checkedAt}>{checkedAt}</time> : '时间未知'}
        </Detail>}
        {account.plan && <Detail label="套餐">{account.plan}</Detail>}
      </dl>
      {(credits > 0 || redeeming) && <div className="limit-detail-group limit-reset-row">
        <span>{resetCreditText(credits, account.resetCreditsExpiresAt, now)}</span>
        <button ref={creditButton} className="limit-reset-action" type="button" disabled={redeeming} onClick={onReset}>
          {redeeming ? '重置中…' : '使用重置'}
        </button>
      </div>}
    </>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

import { Clock3, Gauge, RotateCcw, Ticket, TrendingDown, TrendingUp } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { LimitsReport } from '../../shared/limitsTypes'
import { poolUsageLimits, type PooledLimitWindow } from '../../shared/usageLimits'
import { accountOriginLabels, formatLimitPercent, limitDateTime, resetCountdown } from '../limitsPresentation'
import { providerInfo, providers, type ProviderFilter } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'

type PoolAccount = PooledLimitWindow['accounts'][number]

export function LimitsView({ report, provider, loading, refreshing, failed, onRefresh }: {
  report: LimitsReport | null
  provider: ProviderFilter
  loading: boolean
  refreshing: boolean
  failed: boolean
  onRefresh: () => void
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(interval)
  }, [])
  const accounts = report?.accounts
  const pools = useMemo(() => poolUsageLimits(accounts ?? [], now), [accounts, now])
  const available = provider === 'all' ? providers : [provider]
  const sections = available.map((value) => ({
    provider: value, windows: pools.filter((pool) => pool.provider === value && pool.accounts.length > 0)
  })).filter((section) => section.windows.length > 0)

  return (
    <section aria-label="限制" className="limits-view">
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
          <h2 id={`limits-${section.provider}`} className="section-title limits-provider-heading">
            <ProviderMark provider={section.provider} className="size-[17px]" />
            {providerInfo[section.provider].label}
          </h2>
          {section.windows.map((pool) => (
            <LimitWindowCard key={`${pool.kind}/${pool.windowId}`} pool={pool} now={now} />
          ))}
        </section>
      ))}
    </section>
  )
}

function LimitWindowCard({ pool, now }: { pool: PooledLimitWindow; now: number }) {
  const titleId = useId()
  const next = pool.nextReset
  const showRecovery = next && next.recoveryPercent > 0 && Date.parse(next.at) > now
  const recoveryByAccount = new Map(showRecovery ? next.shares.map((share) => [share.accountId, share.recoveryPercent]) : [])
  const color = providerInfo[pool.provider].color

  return (
    <article className="limit-window" aria-labelledby={titleId} style={{ '--limit-color': color } as CSSProperties}>
      <div className="limit-summary">
        <h3 id={titleId} className="limit-window-label">{pool.label}</h3>
        <div className="limit-metric">
          <span className="usage-figure limit-percent">{formatLimitPercent(pool.meanRemainingPercent)}</span>
          <span className="limit-metric-label">剩余</span>
          {pool.trend && <LimitTrend trend={pool.trend} />}
        </div>
        {showRecovery && <span className="limit-recovery" title={`下次重置将恢复 ${formatLimitPercent(next.recoveryPercent)}`}>
          <RotateCcw size={13} aria-hidden="true" />
          <span className="sr-only">下次重置恢复</span>+{formatLimitPercent(next.recoveryPercent)}
        </span>}
      </div>
      <div className="limit-accounts">
        {pool.accounts.map((account) => (
          <LimitAccountSegment key={account.id} account={account} now={now} provider={pool.provider}
            recovery={(recoveryByAccount.get(account.id) ?? 0) * pool.accounts.length} />
        ))}
      </div>
    </article>
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
  return <span className="limit-trend" role="img" aria-label={description} title={description}><Icon size={15} aria-hidden="true" /></span>
}

function LimitAccountSegment({ account, now, provider, recovery }: {
  account: PoolAccount
  now: number
  provider: PooledLimitWindow['provider']
  recovery: number
}) {
  const id = useId()
  const reset = resetCountdown(account.resetsAt, now)
  const resetAt = limitDateTime(account.resetsAt)
  const checkedAt = limitDateTime(account.checkedAt)
  const credits = provider === 'codex' ? account.resetCredits : undefined
  const remaining = Math.min(100, Math.max(0, account.remainingPercent))
  const refill = Math.min(Math.max(0, recovery), 100 - remaining)
  const caption = [
    `${account.displayName}，剩余 ${formatLimitPercent(remaining)}`,
    reset ? (reset === '等待更新' ? reset : `${reset}后重置`) : null,
    credits != null ? `${credits} 张重置券` : null,
    account.stale ? `缓存数据${checkedAt ? `，上次更新 ${checkedAt}` : ''}` : null
  ].filter(Boolean).join('，')

  return (
    <div className="limit-segment-cell">
      <button type="button" className="limit-segment" popoverTarget={id} aria-label={caption}>
        <span className="limit-segment-track" aria-hidden="true">
          <span className="limit-fill" style={{ width: `${remaining}%` }} />
          {refill > 0 && <span className="limit-refill" style={{ left: `${remaining}%`, width: `${refill}%` }} />}
        </span>
        <span className="limit-segment-content" aria-hidden="true">
          <span className="limit-segment-line">
            <span className="limit-account-name">{account.displayName}</span>
            <strong>{formatLimitPercent(remaining)}</strong>
          </span>
          {(reset || credits != null || account.stale) && <span className="limit-segment-meta">
            {reset && <span>{reset === '等待更新' ? reset : `${reset}后重置`}</span>}
            {credits != null && <span className="limit-credit" title={`${credits} 张重置券`}><Ticket size={13} />{credits}</span>}
            {account.stale && <span className="limit-stale" title={checkedAt ? `缓存数据 · ${checkedAt}` : '缓存数据'}>
              <Clock3 size={13} />
            </span>}
          </span>}
        </span>
      </button>
      <div id={id} popover="auto" className="limit-popover" role="group" aria-labelledby={`${id}-title`}>
        <h4 id={`${id}-title`}>{account.displayName}</h4>
        <dl>
          <Detail label="来源">{accountOriginLabels[account.origin]}</Detail>
          {account.plan && <Detail label="套餐">{account.plan}</Detail>}
          <Detail label="剩余额度">{formatLimitPercent(remaining)}</Detail>
          {resetAt && <Detail label="重置时间"><time dateTime={account.resetsAt}>{resetAt}</time></Detail>}
          {credits != null && <Detail label="重置券">{credits} 张</Detail>}
          {account.stale && <Detail label="缓存数据">
            {checkedAt ? <time dateTime={account.checkedAt}>{checkedAt}</time> : '时间未知'}
          </Detail>}
        </dl>
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

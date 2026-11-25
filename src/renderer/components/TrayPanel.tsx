import { ArrowUpRight, LoaderCircle, RotateCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { UsageProviderKind } from '../../shared/types'
import { useLimitsData } from '../hooks/useLimitsData'
import { limitTimeLeft, resetBadgeDuration } from '../limitsPresentation'
import { trayGroups, trayWindowLabel } from '../trayPresentation'
import { providerInfo } from '../usagePresentation'
import { ProviderMark } from './ProviderMark'
import '../styles/tray-panel.css'

export function TrayPanel() {
  const { report, loading, refreshing, failed, refresh } = useLimitsData()
  const [hidden, setHidden] = useState<UsageProviderKind[] | null>(null)
  const [now, setNow] = useState(Date.now)
  const [canScroll, setCanScroll] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const footer = useRef<HTMLElement>(null)

  useEffect(() => {
    let active = true
    let updated = false
    const unsubscribe = window.usageApi.onUiPreferencesUpdate(preferences => {
      if (!active) return
      updated = true
      setHidden(preferences.hiddenProviders ?? [])
    })
    void window.usageApi.getUiPreferences().then(preferences => {
      if (active && !updated) setHidden(preferences.hiddenProviders ?? [])
    }).catch(() => {
      if (active && !updated) setHidden([])
    })
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    const updateTime = () => setNow(Date.now())
    const interval = window.setInterval(updateTime, 15_000)
    window.addEventListener('focus', updateTime)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', updateTime)
    }
  }, [])

  useLayoutEffect(() => {
    const listNode = list.current
    const contentNode = content.current
    const footerNode = footer.current
    if (!listNode || !contentNode || !footerNode) return
    let lastHeight = 0
    function resize() {
      if (!listNode || !contentNode || !footerNode) return
      setCanScroll(listNode.scrollHeight > listNode.clientHeight)
      // Measure the intrinsic list, not the viewport-constrained scroll container.
      const height = Math.ceil(contentNode.getBoundingClientRect().height + footerNode.getBoundingClientRect().height + 2)
      if (height !== lastHeight) {
        lastHeight = height
        void window.usageApi.trayResize(height).catch(() => undefined)
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(listNode)
    observer.observe(contentNode)
    observer.observe(footerNode)
    resize()
    return () => observer.disconnect()
  }, [])

  const groups = useMemo(() => hidden === null ? [] : trayGroups(report?.accounts ?? [], new Set(hidden), now),
    [report?.accounts, hidden, now])
  const pending = loading || hidden === null
  const readFailed = failed || (!groups.length && hidden !== null &&
    report?.issues?.some(issue => !hidden.includes(issue.provider)))

  return (
    <section className="tray-panel" role="dialog" aria-label="托盘额度">
      <div className="tray-scroll" ref={list} tabIndex={canScroll ? 0 : undefined} role="region" aria-label="账号额度">
        <div className="tray-content" ref={content}>
          {openFailed && <p className="tray-notice" role="alert">无法打开主面板。</p>}
          {groups.length === 0 && (
            <p className="tray-empty" role={readFailed && !refreshing ? 'alert' : 'status'}>
              {pending || refreshing ? '正在读取额度…' : readFailed ? '无法读取额度' : '暂无可用额度'}
            </p>
          )}
          {groups.length > 0 && failed && <p className="tray-notice" role="alert">刷新失败，仍显示上次读取的额度。</p>}
          {groups.map(({ provider, accounts }) => (
            <section className="tray-provider" key={provider} aria-labelledby={`tray-${provider}`}>
              <h2 id={`tray-${provider}`}><ProviderMark provider={provider} className="size-4" />{providerInfo[provider].label}</h2>
              {accounts.map(({ account, windows }) => (
                <article className="tray-account" key={account.id}>
                  <h3 className="tray-account-heading">
                    <span className="tray-ellipsis" title={account.displayName}>{account.displayName}</span>
                    {account.current && <span className="account-current-badge">当前</span>}
                  </h3>
                  <ul role="list">
                    {windows.map(({ window, reading }, index) => {
                      const tick = limitTimeLeft(reading, now)
                      const reset = resetBadgeDuration(reading.resetsAt, now)?.replace('分钟', '分')
                      return (
                        <li className="tray-quota" key={`${window.windowId}:${index}`}>
                          <span className="tray-ellipsis tray-quota-label" title={window.label}>{trayWindowLabel(window)}</span>
                          <span className="tray-track" aria-hidden="true" style={{
                            '--tray-remaining': `${reading.remainingPercent}%`,
                            '--limit-tick-at': tick === null ? undefined : `clamp(3px, ${tick}%, calc(100% - 3px))`
                          } as CSSProperties}>
                            {tick !== null && <span className="tray-tick" />}
                          </span>
                          <span className="tray-quota-numbers">
                            <strong title={reading.stale ? '缓存数据' : undefined}>{Math.round(reading.remainingPercent)}%</strong>
                            {reset && <time className="tray-ellipsis" dateTime={reading.resetsAt} title={reset}>{reset}</time>}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </article>
              ))}
            </section>
          ))}
        </div>
      </div>
      <footer className="tray-actions" ref={footer}>
        <button type="button" className="action-button tray-refresh" aria-disabled={refreshing} aria-busy={refreshing}
          aria-label="刷新" onClick={() => { if (!refreshing) void refresh() }}>
          {refreshing ? <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" />
            : <RotateCw size={14} aria-hidden="true" />}
          <span>{refreshing ? '刷新中…' : '刷新'}</span>
        </button>
        <span className="sr-only" role="status">{refreshing && groups.length > 0 ? '正在刷新额度' : ''}</span>
        <button type="button" className="action-button tray-open" onClick={() => {
          setOpenFailed(false)
          void window.usageApi.trayOpenMain().catch(() => setOpenFailed(true))
        }}>打开主面板<ArrowUpRight size={14} aria-hidden="true" /></button>
      </footer>
    </section>
  )
}

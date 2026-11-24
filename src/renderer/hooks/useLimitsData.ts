import { useCallback, useEffect, useRef, useState } from 'react'
import type { LimitsReport } from '../../shared/limitsTypes'

export function useLimitsData() {
  const [report, setReport] = useState<LimitsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [manualRefresh, setManualRefresh] = useState(false)
  const [failed, setFailed] = useState(false)
  const session = useRef(0)
  const updates = useRef(0)
  const inFlight = useRef(false)

  useEffect(() => {
    const active = ++session.current
    const before = updates.current
    const unsubscribe = window.usageApi.onLimitsUpdated((next) => {
      if (session.current !== active) return
      updates.current++
      setReport(next)
      setLoading(false)
      setFailed(false)
    })
    async function readCached() {
      try {
        const cached = await window.usageApi.getLimits()
        if (session.current === active && updates.current === before) setReport(cached)
      } catch {
        if (session.current === active && updates.current === before) setFailed(true)
      } finally {
        if (session.current === active) setLoading(false)
      }
    }
    void readCached()
    return () => { session.current++; unsubscribe() }
  }, [])

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const active = session.current
    const before = updates.current
    setManualRefresh(true)
    setFailed(false)
    try {
      const next = await window.usageApi.refreshLimits()
      if (session.current === active && updates.current === before) setReport(next)
    } catch {
      if (session.current === active && updates.current === before) setFailed(true)
    } finally {
      inFlight.current = false
      if (session.current === active) {
        setManualRefresh(false)
        setLoading(false)
      }
    }
  }, [])

  const applyReport = useCallback((next: LimitsReport) => {
    updates.current++
    setReport(current => current?.checkedAt && (!next.checkedAt || next.checkedAt < current.checkedAt) ? current : next)
    setLoading(false)
    setFailed(false)
  }, [])

  return { report, loading, refreshing: manualRefresh || Boolean(report?.refreshing), failed, refresh, applyReport }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageProviderKind, UsageSummary, UsageSummaryInput } from '../../shared/types'
import { makeUsageQuery, type UsageRange } from '../usagePresentation'

interface UsageData {
  range: UsageRange
  summary: UsageSummary | null
  query: UsageSummaryInput | null
  pending: boolean
  refreshing: boolean
  failed: boolean
}

export function useUsageData(range: UsageRange) {
  const [data, setData] = useState<UsageData>({
    range, summary: null, query: null, pending: true, refreshing: false, failed: false
  })
  const sequence = useRef(0)
  const latest = useRef<{ range: UsageRange; query: UsageSummaryInput } | null>(null)
  const scanning = useRef<Promise<UsageSummary> | null>(null)

  const read = useCallback(async (reason: 'range' | 'refresh' | 'pricing') => {
    const id = ++sequence.current
    const keep = reason !== 'range'
    const query = reason === 'pricing' && latest.current?.range === range
      ? latest.current.query
      : makeUsageQuery(range)
    latest.current = { range, query }
    setData((previous) => ({
      range, query: keep && previous.range === range ? previous.query : null,
      summary: keep && previous.range === range ? previous.summary : null,
      pending: true, refreshing: reason === 'refresh', failed: false
    }))
    let request: Promise<UsageSummary> | undefined
    try {
      if (reason !== 'refresh' && scanning.current) {
        // Use the completed scan snapshot, not the older snapshot returned by an overlapping cached query.
        await scanning.current.catch(() => undefined)
        if (id !== sequence.current) return
      }
      request = window.usageApi.getSummary(query, reason === 'refresh' ? true : undefined)
      if (reason === 'refresh') scanning.current = request
      const summary = await request
      if (id === sequence.current) setData({ range, summary, query, pending: false, refreshing: false, failed: false })
    } catch {
      if (id === sequence.current) setData((previous) => ({ ...previous, pending: false, refreshing: false, failed: true }))
    } finally {
      if (request && scanning.current === request) scanning.current = null
    }
  }, [range])

  useEffect(() => {
    void read('range')
    const unsubscribe = window.usageApi.onRefreshRequested(() => void read('refresh'))
    return () => { sequence.current++; unsubscribe() }
  }, [read])

  const refresh = useCallback(() => void read('refresh'), [read])
  const reprice = useCallback(() => void read('pricing'), [read])

  /**
   * Two-stage model refresh: one provider answers the dialog immediately, then
   * the remaining providers sync the panel quietly without re-locking it.
   */
  const refreshProvider = useCallback(async (provider: UsageProviderKind) => {
    const id = ++sequence.current
    const query = latest.current?.range === range ? latest.current.query : makeUsageQuery(range)
    latest.current = { range, query }
    try {
      const summary = await window.usageApi.getSummary(query, true, provider)
      if (id !== sequence.current) return
      setData({ range, summary, query, pending: false, refreshing: false, failed: false })
    } catch {
      if (id === sequence.current) {
        setData((previous) => ({ ...previous, pending: false, refreshing: false, failed: true }))
      }
      return
    }
    void window.usageApi.getSummary(query, true).then((next) => {
      if (id !== sequence.current) return
      setData({ range, summary: next, query, pending: false, refreshing: false, failed: false })
    }).catch(() => undefined)
  }, [range])

  return { ...(data.range === range ? data : {
    range, summary: null, query: null, pending: true, refreshing: false, failed: false
  }), refresh, reprice, refreshProvider }
}

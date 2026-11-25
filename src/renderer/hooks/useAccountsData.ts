import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountsReport } from '../../shared/limitsTypes'

const readError = '无法读取账号。'

export function useAccountsData(onChanged: () => void) {
  const [report, setReport] = useState<AccountsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const mutating = useRef(false)
  const foregroundRead = useRef(false)
  const refreshPending = useRef(false)
  const readVersion = useRef(0)

  const read = useCallback(async (silent = false) => {
    if (mutating.current || (silent && foregroundRead.current)) {
      refreshPending.current = true
      return
    }
    const version = ++readVersion.current
    const isLatest = () => mounted.current && readVersion.current === version
    if (!silent) {
      foregroundRead.current = true
      setLoading(true)
      setError('')
    }
    try {
      const next = await window.usageApi.getAccounts()
      if (isLatest()) {
        setReport(next)
        if (silent) setError((previous) => previous === readError ? '' : previous)
      }
    } catch {
      if (isLatest() && !silent) setError(readError)
    } finally {
      if (isLatest() && !silent) {
        foregroundRead.current = false
        setLoading(false)
        if (refreshPending.current) {
          refreshPending.current = false
          void read(true)
        }
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void read()
    return () => { mounted.current = false }
  }, [read])

  useEffect(() => {
    // Identity labels may become available only after the online probe.
    return window.usageApi.onLimitsUpdated((limits) => {
      if (!limits.refreshing) void read(true)
    })
  }, [read])

  async function mutate(
    request: () => Promise<AccountsReport | null>,
    errorMessage: string | ((error: unknown) => string),
    onError: (message: string) => void = setError
  ) {
    if (mutating.current || foregroundRead.current) return false
    mutating.current = true
    ++readVersion.current
    setBusy(true)
    setError('')
    try {
      const next = await request()
      if (!next) return false // Native picker canceled.
      if (mounted.current) setReport(next)
      onChanged()
      return true
    } catch (error) {
      // Do not display raw IPC errors, which may include local paths or sensitive input.
      if (mounted.current) onError(typeof errorMessage === 'string' ? errorMessage : errorMessage(error))
      return false
    } finally {
      mutating.current = false
      if (mounted.current) {
        setBusy(false)
        if (refreshPending.current) {
          refreshPending.current = false
          void read(true)
        }
      }
    }
  }

  return { report, loading, busy, error, read, mutate }
}

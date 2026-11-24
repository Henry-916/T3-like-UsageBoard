import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountsReport } from '../../shared/limitsTypes'

export function useAccountsData(onChanged: () => void) {
  const [report, setReport] = useState<AccountsReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const mutating = useRef(false)

  const read = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await window.usageApi.getAccounts()
      if (mounted.current) setReport(next)
    } catch {
      if (mounted.current) setError('无法读取账号。')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void read()
    return () => { mounted.current = false }
  }, [read])

  async function mutate(request: () => Promise<AccountsReport | null>, errorMessage: string) {
    if (mutating.current) return false
    mutating.current = true
    setBusy(true)
    setError('')
    try {
      const next = await request()
      if (!next) return false // Native picker canceled.
      if (mounted.current) setReport(next)
      onChanged()
      return true
    } catch {
      // Do not display raw IPC errors, which may include local paths or sensitive input.
      if (mounted.current) setError(errorMessage)
      return false
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return { report, loading, busy, error, read, mutate }
}

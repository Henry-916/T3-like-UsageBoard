import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateState } from '../../shared/updateTypes'
import { manualUpdateFeedback, updateAction, updateActionFailure, type UpdateFeedback } from '../updatePresentation'

export function useUpdates() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<UpdateFeedback | null>(null)
  const active = useRef(0)
  const revision = useRef(0)
  const latest = useRef<UpdateState | null>(null)
  const inFlight = useRef(false)

  const apply = useCallback((next: UpdateState) => {
    latest.current = next
    setState(next)
  }, [])
  const dismissFeedback = useCallback(() => setFeedback(null), [])

  useEffect(() => {
    const session = ++active.current
    const before = revision.current
    const unsubscribe = window.usageApi.onUpdateStateChanged((next) => {
      if (session !== active.current) return
      revision.current++
      apply(next)
    })
    void window.usageApi.getUpdateState().then((next) => {
      if (session === active.current && before === revision.current) apply(next)
    }).catch(() => undefined)
    return () => { active.current++; unsubscribe() }
  }, [apply])

  const run = useCallback(async () => {
    const action = updateAction(latest.current)
    if (!action || inFlight.current) return
    inFlight.current = true
    const session = active.current
    const before = ++revision.current
    setBusy(true)
    setFeedback(null)
    try {
      if (action === 'install') {
        await window.usageApi.installUpdate()
        if (session === active.current && latest.current?.status === 'error') setFeedback(updateActionFailure(action))
      } else {
        const next = await (action === 'check' ? window.usageApi.checkForUpdates() : window.usageApi.downloadUpdate())
        if (session !== active.current) return
        if (before === revision.current) apply(next)
        if (latest.current) setFeedback(manualUpdateFeedback(action, latest.current))
      }
    } catch {
      if (session === active.current) setFeedback(updateActionFailure(action))
    } finally {
      inFlight.current = false
      if (session === active.current) setBusy(false)
    }
  }, [apply])

  return { state, disabled: busy || !updateAction(state), run, feedback, dismissFeedback }
}

export type UpdateControls = ReturnType<typeof useUpdates>

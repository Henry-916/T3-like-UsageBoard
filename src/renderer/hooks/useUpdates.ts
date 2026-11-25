import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateState } from '../../shared/updateTypes'
import {
  createUpdateFeedbackTimer, manualUpdateFeedback, updateAction, updateActionFailure, type UpdateAction, type UpdateFeedback
} from '../updatePresentation'

export function useUpdates() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<UpdateFeedback | null>(null)
  const active = useRef(0)
  const revision = useRef(0)
  const latest = useRef<UpdateState | null>(null)
  const inFlight = useRef<UpdateAction | null>(null)
  const [feedbackTimer] = useState(() => createUpdateFeedbackTimer(setFeedback))

  const apply = useCallback((next: UpdateState) => {
    const previous = latest.current
    latest.current = next
    setState(next)
    if (next.status === 'checking' || next.status === 'downloading' || next.status === 'available' || next.status === 'downloaded') {
      feedbackTimer.show(null)
    } else {
      const result = manualUpdateFeedback(next, inFlight.current ?? undefined, previous)
      if (result) feedbackTimer.show(result)
    }
  }, [feedbackTimer])
  const dismissFeedback = useCallback(() => feedbackTimer.show(null), [feedbackTimer])

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
    return () => {
      active.current++
      unsubscribe()
      feedbackTimer.clearTimer()
    }
  }, [apply, feedbackTimer])

  const run = useCallback(async () => {
    const action = updateAction(latest.current)
    if (!action || inFlight.current) return
    inFlight.current = action
    const session = active.current
    const before = ++revision.current
    setBusy(true)
    dismissFeedback()
    try {
      if (action === 'install') {
        await window.usageApi.installUpdate()
      } else {
        const next = await (action === 'check' ? window.usageApi.checkForUpdates() : window.usageApi.downloadUpdate())
        if (session !== active.current) return
        if (before === revision.current) apply(next)
      }
    } catch {
      if (session === active.current && before === revision.current) feedbackTimer.show(updateActionFailure(action))
    } finally {
      inFlight.current = null
      if (session === active.current) setBusy(false)
    }
  }, [apply, dismissFeedback, feedbackTimer])

  return { state, disabled: busy || !updateAction(state), run, feedback, dismissFeedback }
}

export type UpdateControls = ReturnType<typeof useUpdates>

import { useEffect, useRef, useState } from 'react'

type CopyRequest = { key: string; result: Promise<void> }

export function copyAuthorizationLink(
  autoCopiedKeyRef: { current: CopyRequest | null },
  copyText: (text: string) => Promise<void>,
  url: string,
  autoCopyKey?: string
) {
  if (autoCopyKey && autoCopiedKeyRef.current?.key === autoCopyKey) return autoCopiedKeyRef.current.result
  const result = Promise.resolve().then(() => copyText(url))
  if (autoCopyKey) autoCopiedKeyRef.current = { key: autoCopyKey, result }
  return result
}

export function useAuthorizationCopy(url: string | null, flowId: string | null) {
  const autoCopiedKeyRef = useRef<CopyRequest | null>(null)
  const feedbackRef = useRef<(() => void) | null>(null)
  const [copied, setCopied] = useState(false)
  const autoCopyKey = flowId && url ? `${flowId}:${url}` : null

  useEffect(() => {
    setCopied(false)
    if (!url) return
    let active = true
    let timeout: ReturnType<typeof setTimeout> | undefined
    function showCopied() {
      if (!active) return
      clearTimeout(timeout)
      setCopied(true)
      timeout = setTimeout(() => setCopied(false), 2000)
    }
    feedbackRef.current = showCopied

    // Strict Mode re-subscribes to the same pending copy rather than issuing another one.
    if (autoCopyKey) void copyAuthorizationLink(autoCopiedKeyRef, (text) => window.usageApi.copyText(text), url, autoCopyKey)
      .then(showCopied, () => undefined)
    return () => {
      active = false
      clearTimeout(timeout)
      feedbackRef.current = null
    }
  }, [autoCopyKey, url])

  async function copyAuthorization() {
    if (!url) return
    const showCopied = feedbackRef.current
    try {
      await copyAuthorizationLink(autoCopiedKeyRef, (text) => window.usageApi.copyText(text), url)
      showCopied?.()
    } catch { /* opening the link still works if the clipboard is unavailable */ }
  }

  return { copied, copyAuthorization }
}

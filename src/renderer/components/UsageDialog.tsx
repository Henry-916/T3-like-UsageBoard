import { X } from 'lucide-react'
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'

export function UsageDialog({ title, subtitle, children, onClose, busy = false, wide = false, headerActions }: {
  title: ReactNode; subtitle?: ReactNode; children: ReactNode; onClose: () => void; busy?: boolean
  wide?: boolean; headerActions?: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useLayoutEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => { node?.close() }
  }, [])
  return (
    <dialog ref={dialog} className={`usage-dialog${wide ? ' wide-dialog' : ''}`}
      aria-labelledby={titleId} onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}>
      <div className="dialog-frame">
        <header className="dialog-header">
          <div className="dialog-header-actions">
            {headerActions}
            <button className="icon-button dialog-close" type="button" aria-label="关闭弹窗" title="关闭 (Esc)"
              disabled={busy} onClick={onClose}><X size={16} aria-hidden="true" /></button>
          </div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </header>
        {children}
      </div>
    </dialog>
  )
}

import { performance } from 'node:perf_hooks'
import type { Rectangle } from 'electron'

export const trayPanelWidth = 360
export const trayPanelMaxHeight = 520
const gap = 6

export function hasTrayBounds(bounds: Rectangle): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 && bounds.height > 0
}

export function debounceTrayClick(onClick: () => void, now = () => performance.now(), intervalMs = 400): () => void {
  let lastClick = -Infinity
  return () => {
    const clickAt = now()
    const elapsed = clickAt - lastClick
    lastClick = clickAt
    if (elapsed >= intervalMs) onClick()
  }
}

export function positionTrayPanel(
  tray: Rectangle, display: { bounds: Rectangle; workArea: Rectangle }, preferredHeight: number
): Rectangle {
  const { bounds, workArea: work } = display
  const right = work.x + work.width
  const bottom = work.y + work.height
  const width = Math.min(trayPanelWidth, work.width)
  const height = Math.min(trayPanelMaxHeight, work.height, Math.max(1, Math.ceil(preferredHeight)))
  let x = right - width - gap
  let y = bottom - height - gap

  const valid = hasTrayBounds(tray)
  const cx = tray.x + tray.width / 2
  const cy = tray.y + tray.height / 2
  if (valid && cx >= bounds.x && cx <= bounds.x + bounds.width && cy >= bounds.y && cy <= bounds.y + bounds.height) {
    const edges = [
      { side: 'bottom', inset: bounds.y + bounds.height - bottom, distance: Math.abs(bottom - cy) },
      { side: 'top', inset: work.y - bounds.y, distance: Math.abs(cy - work.y) },
      { side: 'left', inset: work.x - bounds.x, distance: Math.abs(cx - work.x) },
      { side: 'right', inset: bounds.x + bounds.width - right, distance: Math.abs(right - cx) }
    ]
    // Use the reserved taskbar strip first. Auto-hide leaves no insets; use the nearest edge.
    const reserved = edges.filter(edge => edge.inset > 0)
    const { side } = (reserved.length ? reserved : edges).sort((a, b) => a.distance - b.distance)[0]
    if (side === 'left' || side === 'right') {
      x = side === 'left' ? Math.max(work.x, tray.x + tray.width) + gap
        : Math.min(right, tray.x) - width - gap
      y = cy - height / 2
    } else {
      x = cx - width / 2
      y = side === 'top' ? Math.max(work.y, tray.y + tray.height) + gap
        : Math.min(bottom, tray.y) - height - gap
    }
  }
  return {
    x: Math.round(Math.max(work.x, Math.min(right - width, x))),
    y: Math.round(Math.max(work.y, Math.min(bottom - height, y))),
    width, height
  }
}

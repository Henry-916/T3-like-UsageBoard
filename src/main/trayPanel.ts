import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import type { Point, Rectangle } from 'electron'
import { usageChannels } from '../shared/ipc'
import { hasTrayBounds, positionTrayPanel, trayPanelMaxHeight, trayPanelWidth } from './trayPanelPosition'

interface Options {
  iconPath: string
  rendererUrl?: string
  showMain(): void
}

export function createTrayPanel({ iconPath, rendererUrl, showMain }: Options) {
  let panel: BrowserWindow | undefined
  let anchor: Rectangle | undefined
  let fallbackPoint: Point | undefined
  let preferredHeight = 116
  let requested = false
  let ready = false
  let lastBlurAt = -Infinity
  // Switching writes credentials and restarts the provider app, which may steal focus.
  let switching = false

  function applyBounds(): void {
    const window = panel
    if (!window || !anchor || !fallbackPoint) return
    const display = hasTrayBounds(anchor)
      ? screen.getDisplayMatching(anchor)
      : screen.getDisplayNearestPoint(fallbackPoint)
    const work = display.workArea
    let next = positionTrayPanel(anchor, display, preferredHeight)
    let actual = window.getBounds()
    for (let attempt = 0; attempt < 3; attempt++) {
      if (next.x !== actual.x || next.y !== actual.y || next.width !== actual.width || next.height !== actual.height) {
        window.setBounds(next)
      }
      actual = window.getBounds()
      // A fractional Windows DPI scale can expand an Electron rectangle by a DIP after setBounds().
      const dw = Math.max(0, actual.width - Math.min(trayPanelWidth, work.width))
      const dh = Math.max(0, actual.height - Math.min(trayPanelMaxHeight, work.height))
      const dx = Math.max(work.x - actual.x, Math.min(0, work.x + work.width - actual.x - actual.width + dw))
      const dy = Math.max(work.y - actual.y, Math.min(0, work.y + work.height - actual.y - actual.height + dh))
      if (!dw && !dh && !dx && !dy) return
      next = { x: next.x + dx, y: next.y + dy, width: next.width - dw, height: next.height - dh }
    }
  }

  function hide(): void {
    requested = false
    if (panel?.isVisible()) panel.hide()
  }

  function show(): void {
    if (!requested || !ready || !panel) return
    applyBounds()
    panel.show()
    panel.focus()
  }

  function createWindow(): void {
    const window = new BrowserWindow({
      title: '托盘额度',
      icon: iconPath,
      width: trayPanelWidth,
      height: preferredHeight,
      useContentSize: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#111111',
      roundedCorners: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    panel = window
    ready = false
    applyBounds()
    screen.on('display-metrics-changed', applyBounds)
    screen.on('display-removed', applyBounds)
    window.on('blur', () => {
      if (!switching && requested && window.isVisible()) {
        lastBlurAt = performance.now()
        hide()
      }
    })
    window.on('closed', () => {
      screen.removeListener('display-metrics-changed', applyBounds)
      screen.removeListener('display-removed', applyBounds)
      panel = undefined
      ready = false
      requested = false
    })
    window.once('ready-to-show', () => {
      ready = true
      show()
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-frame-navigate', event => event.preventDefault())
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        window.webContents.send(usageChannels.trayEscape)
      }
    })
    const load = rendererUrl
      ? window.loadURL(new URL('#tray', rendererUrl).href)
      : window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tray' })
    void load.catch(() => {
      if (!window.isDestroyed()) window.destroy()
    })
  }

  return {
    toggle(bounds: Rectangle): void {
      if (requested) {
        hide()
        return
      }
      // On Windows, clicking the tray icon may blur the visible popup before the click arrives.
      if (performance.now() - lastBlurAt < 150) return
      anchor = bounds
      fallbackPoint = screen.getCursorScreenPoint()
      requested = true
      if (panel) show()
      else createWindow()
    },
    hide,
    openMain(): void {
      hide()
      showMain()
    },
    getWindow: () => panel,
    setSwitching(active: boolean): void {
      switching = active
      if (!active && requested && panel && !panel.isDestroyed() && panel.isVisible() && !panel.isFocused()) {
        panel.focus()
      }
    },
    resize(height: number): void {
      if (!Number.isFinite(height) || height <= 0) return
      preferredHeight = Math.min(trayPanelMaxHeight, Math.ceil(height))
      applyBounds()
    },
    send(channel: string, ...args: unknown[]): void {
      if (panel && !panel.isDestroyed() && !panel.webContents.isDestroyed()) panel.webContents.send(channel, ...args)
    }
  }
}

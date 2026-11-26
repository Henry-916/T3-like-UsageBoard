import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usageChannels } from '../src/shared/ipc'
import { createTrayPanel } from '../src/main/trayPanel'

const mocks = vi.hoisted(() => ({ windows: [] as any[], sent: vi.fn() }))
vi.mock('electron', () => {
  class FakeBrowserWindow {
    handlers = new Map<string, (...args: any[]) => void>()
    bounds = { x: 0, y: 0, width: 360, height: 116 }
    visible = false
    focused = false
    webContents = {
      handlers: new Map<string, (...args: any[]) => void>(),
      setWindowOpenHandler: vi.fn(),
      on(name: string, handler: (...args: any[]) => void) { this.handlers.set(name, handler) },
      send: mocks.sent,
      isDestroyed: () => false
    }
    constructor() { mocks.windows.push(this) }
    setBounds(next: typeof this.bounds) { this.bounds = { ...next } }
    getBounds() { return { ...this.bounds } }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    show() { this.visible = true }
    focus() { this.focused = true }
    hide() { this.visible = false; this.focused = false }
    blur() {
      if (!this.focused) return
      this.focused = false
      this.fire('blur')
    }
    isDestroyed() { return false }
    on(name: string, handler: (...args: any[]) => void) { this.handlers.set(name, handler) }
    once(name: string, handler: (...args: any[]) => void) { this.handlers.set(name, handler) }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    fire(name: string, ...args: any[]) { this.handlers.get(name)?.(...args) }
  }
  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getDisplayMatching: () => display,
      getDisplayNearestPoint: () => display,
      getCursorScreenPoint: () => ({ x: 32, y: 32 }),
      on: vi.fn(),
      removeListener: vi.fn()
    }
  }
})

const bounds = { x: 20, y: 20, width: 24, height: 24 }
const open = () => {
  const tray = createTrayPanel({ iconPath: 'icon.png', rendererUrl: 'http://localhost/', showMain() {} })
  tray.toggle(bounds)
  const window = mocks.windows.at(-1)!
  window.fire('ready-to-show')
  return { tray, window }
}

describe('tray panel focus protection', () => {
  beforeEach(() => {
    mocks.windows.length = 0
    mocks.sent.mockClear()
    ;(globalThis as any).__dirname = process.cwd()
  })

  it('auto-hides on blur, except mid-switch, and restores focus after switching', () => {
    const first = open()
    first.window.blur()
    expect(first.window.visible).toBe(false)

    const second = open()
    second.tray.setSwitching(true)
    second.window.blur()
    expect(second.window.visible).toBe(true)
    expect(second.window.isFocused()).toBe(false)
    second.tray.setSwitching(false)
    expect(second.window.isFocused()).toBe(true)
    second.window.blur()
    expect(second.window.visible).toBe(false)
  })

  it('does not refocus a panel dismissed mid-switch', () => {
    const { tray, window } = open()
    tray.setSwitching(true)
    tray.hide()
    tray.setSwitching(false)
    expect(window.visible).toBe(false)
    expect(window.isFocused()).toBe(false)
  })

  it('forwards Escape to the renderer instead of closing the panel itself', () => {
    const { window } = open()
    window.webContents.handlers.get('before-input-event')?.({ preventDefault() {} }, { type: 'keyDown', key: 'Escape' })
    expect(mocks.sent).toHaveBeenCalledWith(usageChannels.trayEscape)
    expect(window.visible).toBe(true)
  })
})

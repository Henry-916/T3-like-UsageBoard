import { describe, expect, it, vi } from 'vitest'
import { debounceTrayClick, positionTrayPanel } from '../src/main/trayPanelPosition'

const bounds = { x: -1920, y: -90, width: 1920, height: 1080 }

describe('tray panel placement (Electron DIP coordinates)', () => {
  it.each([
    { side: 'bottom', workArea: { ...bounds, height: 1040 }, tray: { x: -60, y: 958 }, at: { x: -360, y: 704 } },
    { side: 'top', workArea: { ...bounds, y: -50, height: 1040 }, tray: { x: -60, y: -82 }, at: { x: -360, y: -44 } },
    { side: 'left', workArea: { ...bounds, x: -1880, width: 1880 }, tray: { x: -1912, y: 922 }, at: { x: -1874, y: 750 } },
    { side: 'right', workArea: { ...bounds, width: 1880 }, tray: { x: -32, y: 922 }, at: { x: -406, y: 750 } }
  ])('opens inward from the $side taskbar without crossing the work area', ({ workArea, tray, at }) => {
    expect(positionTrayPanel({ ...tray, width: 24, height: 24 }, { bounds, workArea }, 240))
      .toEqual({ ...at, width: 360, height: 240 })
  })

  it('opens beside the actual icon edge when the auto-hidden bar leaves no inset', () => {
    expect(positionTrayPanel({ x: -40, y: 520, width: 28, height: 24 }, { bounds, workArea: bounds }, 140))
      .toEqual({ x: -406, y: 462, width: 360, height: 140 })
  })

  it.each([
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 8000, y: 40, width: 20, height: 20 }
  ])('falls back to the display work area’s lower right for unusable icon bounds', tray => {
    const workArea = { ...bounds, height: 1040 }
    expect(positionTrayPanel(tray, { bounds, workArea }, 700))
      .toEqual({ x: -366, y: 424, width: 360, height: 520 })
  })

  it('shrinks the entire window to fit a work area smaller than its nominal size', () => {
    const workArea = { x: 500, y: -420, width: 320, height: 310 }
    expect(positionTrayPanel({ x: 0, y: 0, width: 0, height: 0 }, { bounds: workArea, workArea }, 700)).toEqual(workArea)
  })
})

describe('tray click guard', () => {
  it('handles the first click immediately, ignores the second half of a double-click, and later toggles again', () => {
    let time = 0
    const toggle = vi.fn()
    const click = debounceTrayClick(toggle, () => time)
    click()
    expect(toggle).toHaveBeenCalledTimes(1)
    time = 180
    click()
    expect(toggle).toHaveBeenCalledTimes(1)
    time = 580
    click()
    expect(toggle).toHaveBeenCalledTimes(2)
  })
})

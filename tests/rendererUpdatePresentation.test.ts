import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../src/shared/updateTypes'
import {
  createUpdateFeedbackTimer, manualUpdateFeedback, showUpdateCapsule, updateAction, updateActionLabel, updateStatusLabel, versionLabel
} from '../src/renderer/updatePresentation'

const state: UpdateState = { mode: 'nsis', currentVersion: '0.4.0', status: 'idle' }

describe('renderer update presentation', () => {
  it('labels the same update appropriately for the capsule, settings and footer', () => {
    const available: UpdateState = { ...state, status: 'available', latestVersion: 'v0.4.1' }
    expect(updateAction(available)).toBe('download')
    expect(updateActionLabel(available, 'capsule')).toBe('新版本 v0.4.1')
    expect(updateActionLabel(available, 'menu')).toBe('下载更新 v0.4.1')
    expect(updateActionLabel(available, 'footer')).toBe('下载更新')
    expect(updateStatusLabel(available)).toBe('发现新版本 v0.4.1')
  })

  it('disables new actions during requests and renders bounded whole-number progress', () => {
    const downloading: UpdateState = { ...state, status: 'downloading', downloadPercent: 41.6 }
    const checking: UpdateState = { ...state, status: 'checking', manual: true }
    expect(updateAction(checking)).toBeNull()
    expect(showUpdateCapsule(checking)).toBe(true)
    expect(updateActionLabel(checking, 'capsule')).toBe('正在检查…')
    expect(updateActionLabel(checking, 'footer')).toBe('检查中…')
    expect(updateAction(downloading)).toBeNull()
    expect(updateActionLabel(downloading, 'capsule')).toBe('下载中 42%')
    expect(updateActionLabel(downloading, 'menu')).toBe('正在下载 (42%)')
    expect(updateActionLabel({ ...downloading, downloadPercent: 500 }, 'capsule')).toBe('下载中 100%')
  })

  it('separates installer restart from viewing a downloaded portable update', () => {
    const downloaded: UpdateState = { ...state, status: 'downloaded', latestVersion: '0.4.1' }
    expect(updateAction(downloaded)).toBe('install')
    expect(updateActionLabel(downloaded, 'menu')).toBe('重启更新 v0.4.1')
    expect(updateActionLabel(downloaded, 'footer')).toBe('重启并更新')
    expect(updateActionLabel({ ...downloaded, mode: 'portable' }, 'capsule')).toBe('查看新版')
    expect(updateActionLabel({ ...downloaded, mode: 'portable' }, 'footer')).toBe('在文件夹中显示')
  })

  it('localizes known results without echoing server messages or malformed versions', () => {
    const noRelease: UpdateState = { ...state, status: 'up-to-date', manual: true, message: '暂未检测到已发布的新版本' }
    const development = '当前为开发模式，请使用打包版本检查更新'
    expect(manualUpdateFeedback(noRelease)).toEqual({ text: '暂未检测到已发布的新版本' })
    expect(manualUpdateFeedback({ ...state, status: 'up-to-date', manual: true })).toEqual({ text: '已是最新版本' })
    expect(manualUpdateFeedback({ ...state, mode: 'development', manual: true, message: development })).toEqual({ text: development })
    expect(manualUpdateFeedback({ ...state, manual: true })).toBeNull()
    expect(manualUpdateFeedback({ ...state, status: 'error', manual: true, message: 'arbitrary upstream text' }))
      .toEqual({ text: '检查更新失败，请检查网络后重试', error: true })
    expect(updateStatusLabel(state)).toBe('')
    expect(versionLabel('arbitrary server text')).toBe('')
  })

  it('keeps background checking and its terminal results out of the title bar, while allowing a foreground upgrade', () => {
    const background: UpdateState = { ...state, status: 'checking', manual: false }
    expect(showUpdateCapsule(background)).toBe(false)
    expect(updateAction(background)).toBe('check')
    expect(manualUpdateFeedback({ ...background, status: 'up-to-date' })).toBeNull()
    expect(manualUpdateFeedback({ ...background, status: 'error' }, undefined, background)).toBeNull()
  })

  it('uses state transitions to attribute errors from tray actions without renderer in-flight actions', () => {
    const error: UpdateState = { ...state, status: 'error' }
    expect(manualUpdateFeedback(error, undefined, { ...state, status: 'downloading' })).toEqual({
      text: '无法下载更新，请稍后重试', error: true
    })
    expect(manualUpdateFeedback(error, undefined, { ...state, status: 'downloaded' })).toEqual({
      text: '无法打开更新，请重试', error: true
    })
  })

  it('expires after 4 seconds, supports early dismissal, and clears replaced or unmounted timers', () => {
    vi.useFakeTimers()
    try {
      const publish = vi.fn()
      const timer = createUpdateFeedbackTimer(publish)
      const noUpdate = { text: '已是最新版本' }
      timer.show(noUpdate)
      vi.advanceTimersByTime(3999)
      expect(publish).toHaveBeenCalledExactlyOnceWith(noUpdate)
      vi.advanceTimersByTime(1)
      expect(publish).toHaveBeenLastCalledWith(null)

      timer.show(noUpdate)
      vi.advanceTimersByTime(3000)
      timer.show(null)
      expect(publish).toHaveBeenLastCalledWith(null)
      timer.show(noUpdate)
      vi.advanceTimersByTime(1000)
      expect(publish).toHaveBeenLastCalledWith(noUpdate)
      timer.clearTimer()
      vi.advanceTimersByTime(4000)
      expect(publish).toHaveBeenLastCalledWith(noUpdate)
    } finally {
      vi.useRealTimers()
    }
  })
})

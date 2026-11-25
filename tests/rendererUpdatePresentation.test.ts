import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../src/shared/updateTypes'
import { manualUpdateFeedback, updateAction, updateActionLabel, updateStatusLabel, versionLabel } from '../src/renderer/updatePresentation'

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
    expect(updateAction({ ...state, status: 'checking' })).toBeNull()
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
    const noRelease: UpdateState = { ...state, status: 'up-to-date', message: '暂未检测到已发布的新版本' }
    expect(manualUpdateFeedback('check', noRelease)).toEqual({ text: '暂未检测到已发布的新版本' })
    expect(manualUpdateFeedback('check', { ...state, status: 'up-to-date' })).toEqual({ text: '已是最新版本' })
    expect(manualUpdateFeedback('check', { ...state, mode: 'development' })).toEqual({ text: '当前为开发模式，请使用打包版本检查更新' })
    expect(manualUpdateFeedback('check', { ...state, status: 'error', message: 'arbitrary upstream text' }))
      .toEqual({ text: '检查更新失败，请检查网络后重试', error: true })
    expect(updateStatusLabel(state)).toBe('')
    expect(versionLabel('arbitrary server text')).toBe('')
  })
})

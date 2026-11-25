import type { UpdateState } from '../shared/updateTypes'

const noPublishedVersion = '暂未检测到已发布的新版本'
const developmentMode = '当前为开发模式，请使用打包版本检查更新'
const checkFailed = '检查更新失败，请检查网络后重试'

export function versionLabel(version?: string) {
  return version && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    ? `v${version.replace(/^v/, '')}` : ''
}

export function updatePercent(state: UpdateState) {
  return Math.min(100, Math.max(0, Math.round(state.downloadPercent ?? 0))) || 0
}

export function updateActionLabel(state: UpdateState | null, entry: 'menu' | 'footer' | 'capsule') {
  const version = versionLabel(state?.latestVersion)
  const versionSuffix = version ? ` ${version}` : ''
  const portable = state?.mode === 'portable'
  switch (state?.status) {
    case 'checking': return '检查中…'
    case 'available':
      return entry === 'footer' ? '下载更新' : entry === 'menu' ? `下载更新${versionSuffix}` : `新版本${versionSuffix}`
    case 'downloading':
      if (entry === 'footer') return '下载中…'
      return entry === 'menu' ? `正在下载 (${updatePercent(state)}%)` : `下载中 ${updatePercent(state)}%`
    case 'downloaded':
      if (entry === 'footer') return portable ? '在文件夹中显示' : '重启并更新'
      return `${portable ? '查看新版' : '重启更新'}${entry === 'menu' ? versionSuffix : ''}`
    default: return '检查更新'
  }
}

export function updateStatusLabel(state: UpdateState | null) {
  switch (state?.status) {
    case 'checking': return '正在检查更新…'
    case 'available': return `发现新版本 ${versionLabel(state.latestVersion)}`.trimEnd()
    case 'up-to-date': return state.message === noPublishedVersion ? noPublishedVersion : '已是最新版本'
    case 'downloading': return `下载中 ${updatePercent(state)}%`
    case 'downloaded': return state.mode === 'portable' ? '新版已下载' : '更新已下载'
    case 'error':
      if (state.message === '下载更新失败，请重试') return '下载更新失败'
      if (state.message === '安装更新失败，请重试') return '安装更新失败'
      return '检查更新失败'
    case 'idle':
      if (state.message === noPublishedVersion) return noPublishedVersion
      if (state.message === developmentMode) return developmentMode
  }
  return ''
}

export type UpdateAction = 'check' | 'download' | 'install'

export function updateAction(state: UpdateState | null): UpdateAction | null {
  switch (state?.status) {
    case 'checking':
    case 'downloading': return null
    case 'available': return 'download'
    case 'downloaded': return 'install'
    default: return 'check'
  }
}

export interface UpdateFeedback { text: string; error?: boolean }

export function updateActionFailure(action: UpdateAction): UpdateFeedback {
  return { text: action === 'check' ? checkFailed : action === 'download'
    ? '无法下载更新，请稍后重试' : '无法打开更新，请重试', error: true }
}

export function manualUpdateFeedback(action: UpdateAction, state: UpdateState): UpdateFeedback | null {
  if (state.status === 'error') return updateActionFailure(action)
  if (action !== 'check') return null
  if (state.status === 'up-to-date') {
    return { text: state.message === noPublishedVersion ? noPublishedVersion : '已是最新版本' }
  }
  if (state.status === 'idle') {
    return { text: state.mode === 'development' ? developmentMode : noPublishedVersion }
  }
  return null
}

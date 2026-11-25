import { isAbsolute } from 'node:path'
import { app, Menu, Tray } from 'electron'
import { updateConfig } from './configStore'
import type { UpdateState } from '../shared/updateTypes'

interface TrayActions {
  show(): void
  toggle(): void
  refresh(): void
  updateState(): UpdateState
  update(): void
}

export function createTray(iconPath: string, userData: string, actions: TrayActions): Tray & { refreshMenu: () => void } {
  const tray = new Tray(iconPath)
  tray.setToolTip('UsageDashboard')
  tray.on('click', actions.toggle)

  const portable = app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE
  const path = portable && isAbsolute(portable) && /\.exe$/i.test(portable) ? portable : process.execPath
  const args = process.defaultApp ? [`"${app.getAppPath()}"`, '--auto-launch'] : ['--auto-launch']
  const loginItem = { path, args }
  function updateMenu(): void {
    if (tray.isDestroyed()) return
    const state = actions.updateState()
    const version = state.latestVersion ?? state.currentVersion
    const updateLabel = state.status === 'checking' ? '正在检查更新…'
      : state.status === 'available' ? `下载新版本 (v${version})`
        : state.status === 'downloading' ? `正在下载更新 (${Math.round(state.downloadPercent ?? 0)}%)`
          : state.status === 'downloaded' ? (state.mode === 'portable' ? `打开已下载的 v${version}` : `重启并安装 v${version}`)
            : `检查更新 (v${state.currentVersion})`
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主面板', click: actions.show },
      { label: '立即刷新', click: actions.refresh },
      { label: updateLabel, enabled: state.status !== 'downloading' && state.status !== 'checking', click: actions.update },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: app.getLoginItemSettings(loginItem).openAtLogin,
        click: (item) => {
          try {
            app.setLoginItemSettings({ ...loginItem, openAtLogin: item.checked })
            const launchAtLogin = app.getLoginItemSettings(loginItem).openAtLogin
            void updateConfig(userData, config => ({
              ...config, preferences: { ...config.preferences, launchAtLogin }
            })).catch(() => console.warn('UsageDashboard: unable to save launch preference'))
          } catch {
            console.warn('UsageDashboard: unable to update start-at-login')
          }
          updateMenu()
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]))
  }

  updateMenu()
  return Object.assign(tray, { refreshMenu: updateMenu })
}

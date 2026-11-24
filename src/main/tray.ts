import { isAbsolute } from 'node:path'
import { app, Menu, Tray } from 'electron'
import { updateConfig } from './configStore'

interface TrayActions {
  show(): void
  toggle(): void
  refresh(): void
}

export function createTray(iconPath: string, userData: string, actions: TrayActions): Tray {
  const tray = new Tray(iconPath)
  tray.setToolTip('UsageDashboard')
  tray.on('click', actions.toggle)

  const portable = app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE
  const path = portable && isAbsolute(portable) && /\.exe$/i.test(portable) ? portable : process.execPath
  const args = process.defaultApp ? [`"${app.getAppPath()}"`, '--auto-launch'] : ['--auto-launch']
  const loginItem = { path, args }
  function updateMenu(): void {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主面板', click: actions.show },
      { label: '立即刷新', click: actions.refresh },
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
  return tray
}

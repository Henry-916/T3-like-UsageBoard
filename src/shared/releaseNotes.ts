import { APP_VERSION } from './version'

export interface ReleaseNote {
  version: string
  markdown: string
}

/**
 * Only the current version is bundled. The notice is a one-shot upgrade
 * message: settings no longer keeps a history browser.
 */
export const releaseNote: ReleaseNote = {
  version: APP_VERSION,
  markdown: `
### 新增
- **统一价格源：全面接入 models.dev。** 精简快照随包内置，启动即出价；联网后在后台自动拉取最新数据。
- **峰谷计价：预设自带时段规则。** 选择带峰谷的预设后，模型 ID 右侧出现「峰谷」胶囊开关，可随时启停。

### 优化
- **模型详情：单价表更直观。** 问号移到模型名右侧，按「类型 | 价格（美元/M）」两列展示纯数字。
- **模型详情刷新：两阶段极速刷新。** 先快刷当前提供方，再在后台同步其余提供方。
- **费用总览：更简洁。** 总费用与总 token 下方统一只显示会话数。

### 调整
- **更新公告：轻量 Markdown 展示。** 升级后首次打开主面板自动弹出，设置菜单不再提供回看入口。
`.trim(),
}

export function latestReleaseNote(version: string): ReleaseNote | undefined {
  return version === releaseNote.version ? releaseNote : undefined
}

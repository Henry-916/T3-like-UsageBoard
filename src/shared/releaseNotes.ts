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
- **支持峰谷时段计费：** DeepSeek、阿里云百炼、硅基流动等支持错峰定价的模型，现在会按对话发生的实际时间自动区分峰期与谷期计费。「自定义模型价格」中也支持预览预设的峰谷时段与价格，并通过「峰谷」开关随时启停。
- **内置离线模型价格库：** 随应用内置 \`models.dev\` 价格数据，即使不连外网也能开箱识别主流原厂与国内云渠道模型定价；联网状态下会在后台自动同步最新价格。
- **模型详情查看生效单价：** 打开任意模型详情后，悬停标题右侧的 \`?\` 即可查看输入、输出、缓存读写单价表，以及峰谷分档与上下文阶梯价。

### 优化
- **单模型刷新更快：** 在模型详情页点击刷新或按 \`R\` 时，会优先更新当前模型所属平台并增量读取新消息，刚结束对话也能秒级刷出最新统计。
`.trim(),
}

export function latestReleaseNote(version: string): ReleaseNote | undefined {
  return version === releaseNote.version ? releaseNote : undefined
}

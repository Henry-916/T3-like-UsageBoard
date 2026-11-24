# UsageDashboard 当前生效架构与约定

本文档为当前仓库的**单一真值索引（Source of Truth）**。早期历史工单中已被后续版本推翻的设计（例如初版 `#09090b` 背景色、单选提供方、禁止历史扫描已关闭账号等）均以本页及最新 `docs/specs/` 为准。

---

## 1. 项目定位与协作分工

- **项目定位**：从 MIT 协议开源项目 T3 Code（`https://github.com/pingdotgg/t3code`）拆出的独立 Windows 桌面 AI 用量与实时额度看板，仅覆盖 `antigravity`、`opencode`、`codex`、`claude` 四家本地数据源，界面采用简体中文、最小化到系统托盘。
- **版本真值**：唯一版本真值写在 [package.json](../package.json) 的 `version`，经 [version.ts](../src/shared/version.ts) 供托盘与构建复用。
- **协同流程**：
  - **Antigravity**：负责对照参考图 / T3 源码出方案（写入 `docs/specs/NNN-vX.Y.Z-<slug>.md`）、把控架构一致性、运行独立验收与 Git 提交/打标签。
  - **GPT**：按已定稿工单执行代码改动、补齐单元测试、构建 `dist/` Windows 双包并做冷启动验证。

---

## 2. 当前生效的设计与技术规则

### 2.1 视觉与桌面窗口
- **色彩与字体**：OLED 纯黑主画布 `#000000`（`BrowserWindow.backgroundColor` 与 CSS `--color-canvas`）、卡片 `#111111`、`16px` 根字号、全局固定思源宋体优先衬线栈（`"Source Han Serif SC VF"` 等，不设字体切换开关）、主体容器 `max-width: 1024px`。
- **顶栏与窗口控制**：左侧面包屑 `用量` 置灰 + 高亮提供方多选触发器（原生 `popover="auto"` 多选菜单 + `uiPreferences.hiddenProviders` 持久化）；右侧时间窗（`过去 24 小时` / `7 天` / `30 天` / `90 天`）、视图切换（`费用` / `token` / `限制`）均为无外框分段开关（`#0b0b0b` 槽 + `#1e1e1e` 选中态），右侧控制区含刷新、设置及「最小化 / 最大化（向下还原）/ 关闭到托盘」三键与主进程事件双向同步。
- **提供方图标**：[ProviderMark.tsx](../src/renderer/components/ProviderMark.tsx) 中 `Antigravity` 1:1 采用 T3 原版实心多色渐变图标（128×128 PNG data URI）。

### 2.2 账号发现、历史扫描与额度探测（开关解耦）
- **三层发现机制**：
  1. `native`：原生默认目录（`~/.claude`、`~/.codex`、`~/.gemini/{antigravity,antigravity-cli,antigravity-ide,antigravity-backup}`、`~/.config/antigravity`、`%LOCALAPPDATA%\opencode` 等）；
  2. `t3`：只读读取 `~/.t3/userdata/settings.json` 中的 `providerInstances` 及其 profile 目录（受「扫描 T3 账号 / `scanT3`」控制）；
  3. `manual`：应用内手动添加的目录或加密导入凭证（存于 `%APPDATA%/usage-dashboard/accounts/`）。
- **历史统计 vs 实时额度解耦**：
  - [usage/service.ts](../src/main/usage/service.ts)：`native` 与启用 `scanT3` 下的 `t3` 数据目录**始终参与历史费用与 Token 扫描**（不受「账号管理」开关影响，对齐 T3 统计口径）；仅被显式关闭的 `manual` 目录跳过历史扫描。
  - [limits/service.ts](../src/main/limits/service.ts)：「限制」页实时额度探测继续严格尊重 `account.enabled`，关闭本机 `native` 账号即可避免额度页重复或报错。
- **模型归一化与计价**：先执行 `normalizeModelId`（剥离思考强度后缀并映射 Antigravity 路由模型），再按 `providerReportedCost > priceOverrides > LiteLLM (24h 缓存 + 离线兜底) > unpriced` 计价；美元统一输出 `US$`。

### 2.3 限制页与特殊交互
- **Antigravity 额度顺序与自动续期**：
  - [usageLimits.ts](../src/shared/usageLimits.ts) 对 Antigravity 窗口按模型家族优先分组再按时长排序：`Gemini · 5-hour` → `Gemini · Weekly` → `Claude & GPT (shared) · 5-hour` → `Claude & GPT (shared) · Weekly`（其他提供方相对顺序不变）。
  - Antigravity 过期 token 通过隔离临时目录调用 `agy` CLI 串行静默续期，新 token 加密缓存在应用私有 `userData`，绝不修改原始 `~/.t3` 凭证。
  - `limits-cache.json` 持久化最近一次有效读数，冷启动立即恢复旧值后再刷新；报错区按「凭证过期 / 缺少 `agy` CLI / 刷新失败」分类展示，采用琥珀色警告样式。
- **Codex 重置券兑换**：
  - 单行 `32px` 额度条左侧显示同池多账号 `↻ +XX%` 回血预期，白色 `2px` 匀速刻度线使用 `--limit-tick-at` 同时驱动轨道镂空，悬停或键盘打开统一详情 `popover="auto"` 展示各账号余量与重置券。
  - 「使用重置」仅先收起浮层并打开独立的 `使用重置券？` 二次确认弹窗，**默认聚焦「取消」防回车误触**；服务端具备 HTTP 直连优先 + 非 T3 CLI 回退、跨账号别名串行互斥锁、粘性 `idempotencyKey` 防重放及兑换后退避重查。

---

## 3. 硬性安全红线（所有改动与验收必须遵守）

1. **只读保护 `~/.t3`**：严禁写入、修改或删除 `~/.t3` 下任何文件；严禁对 `origin === 't3'` 或解析指向 `~/.t3` 的别名目录拉起可能写回目录状态的外部 CLI。
2. **保护参考原图**：`docs/references/` 下所有参考截图始终保留无损原图，不得有损压缩或改动。
3. **零实弹兑换与脱敏**：任何自动化测试、人工脚本或冷启动验收均**禁止**触发真实的 Codex 重置券兑换；禁止在终端输出、日志或文档中打印 `access_token`、`refresh_token`、API Key 或账号邮箱。

---

## 4. 迭代规范归档索引（`docs/specs/`）

| 序号 | 版本 | 文档 | 主题摘要 |
| --- | --- | --- | --- |
| 001 | `v0.1.0` | [001-v0.1.0-initial.md](specs/001-v0.1.0-initial.md) | 独立桌面端初始架构、4 家解析器、定价与基础 UI 框架 |
| 002 | `v0.2.0` | [002-v0.2.0-antigravity-limits.md](specs/002-v0.2.0-antigravity-limits.md) | Antigravity 隔离自动续期、`limits-cache.json` 持久缓存、分级报错 |
| 003 | `v0.3.0` | [003-v0.3.0-ui-alignment.md](specs/003-v0.3.0-ui-alignment.md) | 6 张参考图 1:1 视觉与交互对齐、Codex 重置券兑换与二次确认 |
| 004 | `v0.3.1` | [004-v0.3.1-polish.md](specs/004-v0.3.1-polish.md) | 历史扫描与开关解耦、窗口最大化/还原按钮、Antigravity 图标与额度分组排序 |

> 后续每轮新需求在 `docs/specs/` 下按 `NNN-vX.Y.Z-<slug>.md` 递增新建；合入并完成版本发布后，如改变了全局默认行为，同步更新本页对应条目。

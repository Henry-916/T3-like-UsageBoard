# T3-like UsageBoard 当前生效架构与约定

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
- **分类条与图标**：[usagePresentation.ts](../src/renderer/usagePresentation.ts) 与 [UsageShareBar.tsx](../src/renderer/components/UsageShareBar.tsx) 的「按类型统计的费用 / token」条带固定按 `输入 → 缓存读取 → 缓存写入 → 输出 → 未拆分` 排列（四档灰度 + `2px` 黑缝，费用视图右侧 `未拆分` 采用斜纹填充）；应用图标母版为 [logo.svg](../resources/logo.svg) 并导出 `16/20/24/32/48/256` 多尺寸 `tray-icon.ico`。
- **顶栏与窗口控制**：左侧面包屑 `用量` 置灰 + 高亮提供方多选触发器（原生 `popover="auto"` 多选菜单 + `uiPreferences.hiddenProviders` 持久化）；右侧时间窗（`过去 24 小时` / `7 天` / `30 天` / `90 天`）、视图切换（`费用` / `token` / `限制`）均为无外框分段开关（`#0b0b0b` 槽 + `#1e1e1e` 选中态），右侧控制区含刷新、设置及「最小化 / 最大化（向下还原）/ 关闭到托盘」三键与主进程事件双向同步。
- **提供方图标**：[ProviderMark.tsx](../src/renderer/components/ProviderMark.tsx) 中 `Antigravity` 1:1 采用 T3 原版实心多色渐变图标（128×128 PNG data URI）。

### 2.2 账号发现、历史扫描、应用内登录、身份归并与快捷切号
- **三层发现机制与精准凭证过滤**：
  1. `native`：原生默认目录及激活凭据槽（Windows 系统凭据槽 `gemini:antigravity` 经 `CredReadW` UTF-8 `cliToken` 解析为 Antigravity `当前` 槽位，`$CODEX_HOME/auth.json` 或 `~/.codex/auth.json` 标记为 Codex `当前` 槽位；另扫描 `~/.gemini/antigravity-acp`、`~/.claude`、`~/.gemini/{antigravity,antigravity-cli,antigravity-ide,antigravity-backup}`、`~/.config/antigravity`、`%LOCALAPPDATA%\opencode` / `~/.local/share/opencode` 等）；
  2. `t3`：只读读取 `~/.t3/userdata/settings.json` 中的 `providerInstances` 及其 profile 目录（受「扫描 T3 账号 / `scanT3`」控制）；
  3. `manual`：应用内直接登录（OAuth / Go API Key）或手动添加，加密单文件凭证存于 `%APPDATA%/t3-like-usageboard/accounts/<id>/`，隔离 CLI home 存于 `%APPDATA%/t3-like-usageboard/profiles/<id>/`。首次启动经 [userDataMigration.ts](../src/main/userDataMigration.ts) 复制旧目录配置与 `Local State`（含 `safeStorage` 密钥），保留旧目录作备份。
  - [accounts/service.ts](../src/main/accounts/service.ts) 在「账号管理」列表与实时额度队列中仅展示持有可用登录凭证的 `native` / `t3` 条目（自动滤除仅有对话历史的空目录、已退出 `~/.claude` 及非 OAuth 实例），并与 `config.hiddenAccountIds` 配合提供「删除 / 移除 / 恢复显示」能力（移除自动发现账号绝不改动原机文件）。
- **邮箱显示、身份归并与列表行**：所有 UI 位置的账号名固定展示不可编辑的规范化邮箱（OpenCode Go 固定为 `OpenCode Go`），经 [identities.ts](../src/main/accounts/identities.ts) 持久化至 `identities.json`，同提供方下相同小写邮箱归并为单行；「账号管理」行采用「提供方图标 + 第一行提供方名 + 第二行邮箱与『当前』胶囊」（已移除来源文字、目录路径和编辑入口）。
- **快捷切换账号（「设为当前」）**：仅支持 Codex 与持有 `cliToken` 的 Antigravity（App / CLI），在 [switchAccount.ts](../src/main/accounts/switchAccount.ts) 经默认聚焦「取消」的二次确认弹窗触发；执行期持有 `limits.exclusiveSwitch` 互斥屏障，先自动加密快照或回写当前激活账号、按需保留 `.bak-usageboard-*` 备份并支持失败回滚，通过 [windowsSwitchProcesses.ts](../src/main/accounts/windowsSwitchProcesses.ts) 精准重启 `OpenAI.Codex`（`ChatGPT.exe` + `app-server`）或 `Antigravity.exe` 进程树（不误杀终端 CLI、`Antigravity IDE` 或 VS Code 下 `agy.exe`）。
- **历史统计 vs 实时额度解耦**：
  - [usage/service.ts](../src/main/usage/service.ts)：`native` 与启用 `scanT3` 下的 `t3` 数据目录（含无凭证历史目录与已隐藏账号目录）**始终参与历史费用与 Token 扫描**，对齐 T3 统计口径；仅被显式关闭的 `manual` 目录跳过历史扫描。
  - [limits/service.ts](../src/main/limits/service.ts)：「限制」页与托盘额度面板严格尊重启用状态；当前账号只探测默认激活槽位，应用内副本在激活期间冻结，切换时再回写以防 refresh token 互挤。
- **应用内隔离登录（[loginManager.ts](../src/main/accounts/loginManager.ts)）**：
  - 「添加账号 → 提供方」采用自绘深色 `ProviderSelect` 下拉组件，选项与触发器均展示对应 `<ProviderMark />` 品牌图标（按 `Esc` 仅收起下拉而不关闭「账号管理」弹窗）；「浏览器登录」仅返回授权链接、**绝不自动拉起系统浏览器**，前端经主进程 `clipboard.writeText` 自动复制链接并在弹窗内展示只读可点击复制输入框（2 秒 `已复制链接` 提示）与显式 `打开` 按钮。
  - `Antigravity`：调用本机/托管 `agy acp --login`（强制 `SSH_CONNECTION` 与独立 `GEMINI_HOME`），经授权码回填后由 `safeStorage` 加密写入 `accounts/<id>/`；
  - `Codex`：调用 `codex -c cli_auth_credentials_store="file" app-server` 在隔离 `profiles/<id>/`（`CODEX_HOME`）完成 ChatGPT OAuth；
  - `Claude Code`：保留宿主浏览器及用户临时目录环境变量、注入 `BROWSER: '__USAGE_DASHBOARD_NO_BROWSER__'` 抑制 CLI 自动打开浏览器并放行 `claude.ai` / `claude.com` / `platform.claude.com` / `console.anthropic.com`，通过 `CLAUDE_CONFIG_DIR` 隔离完成 `claude auth login --claudeai`；
  - `OpenCode`：应用内输入 Go API Key 并经 `safeStorage` 加密存储。
- **模型归一化与计价**：先执行 `normalizeModelId`（剥离思考强度后缀并映射 Antigravity 路由模型），再按 `providerReportedCost > priceOverrides > LiteLLM (24h 缓存 + 离线兜底) > unpriced` 计价；美元统一输出 `US$`。

### 2.3 限制页、托盘额度小面板与特殊交互
- **Antigravity 额度顺序与自动续期**：
  - [usageLimits.ts](../src/shared/usageLimits.ts) 对 Antigravity 窗口按模型家族优先分组再按时长排序：`Gemini · 5-hour` → `Gemini · Weekly` → `Claude & GPT (shared) · 5-hour` → `Claude & GPT (shared) · Weekly`（其他提供方相对顺序不变）。
  - Antigravity 过期 token 通过隔离临时目录调用 `agy` CLI 串行静默续期，新 token 加密缓存在应用私有 `userData`，绝不修改原始 `~/.t3` 凭证。
  - `limits-cache.json` 持久化最近一次有效读数，冷启动立即恢复旧值后再刷新；报错区按「凭证过期 / 缺少 `agy` CLI / 刷新失败」分类展示，采用琥珀色警告样式；限额详情浮层不再展示「来源」行。
- **Codex 重置券兑换**：
  - 单行 `32px` 额度条左侧显示同池多账号 `↻ +XX%` 回血预期，白色 `2px` 匀速刻度线使用 `--limit-tick-at` 同时驱动轨道镂空，悬停或键盘打开统一详情 `popover="auto"` 展示各账号余量与重置券。
  - 「使用重置」仅先收起浮层并打开独立的 `使用重置券？` 二次确认弹窗，**默认聚焦「取消」防回车误触**；服务端具备 HTTP 直连优先 + 非 T3 CLI 回退、跨账号别名串行互斥锁、粘性 `idempotencyKey` 防重放及兑换后退避重查。
- **托盘额度小面板（[tray.ts](../src/main/tray.ts)、[trayPanel.ts](../src/main/trayPanel.ts)、[TrayPanel.tsx](../src/renderer/components/TrayPanel.tsx)）**：
  - 左键单击托盘图标（`400ms` 去抖防双击闪跳）贴近任务栏四向边缘弹出 `360px` 宽（高度自适应、上限 `520px`）独立无边框面板（双击不额外切换主窗），按提供方与邮箱展示紧凑额度条，跟随 `hiddenProviders` 与启用状态，底部提供「刷新」与「打开主面板」；右键菜单首项保留「显示主面板」。

### 2.4 应用更新与分发（[updater.ts](../src/main/updater.ts)）
- **发布源与触发策略**：通过公开 GitHub Releases（当前配置 `Henry-916/T3-like-UsageBoard`）检查新版本；打包后启动延迟 `10s` 首检并每 `4h` 静默复检（404 / 离线及无新版静默忽略，仅在有新版/下载中/就绪时在顶栏显示胶囊）；设置菜单、账号管理页脚与系统托盘菜单均提供手动检查（`manual: true`）、下载与安装入口——手动检查期间在固定顶栏（[TopBar.tsx](../src/renderer/components/TopBar.tsx)）展示 `LoaderCircle` 旋转胶囊（`正在检查…`）并在页脚按钮显示 `检查中…`，无新版/失败提示渲染于固定顶栏 `.titlebar-update-feedback` 胶囊（不随页面滚动、`4s` 自动收起且支持 `×` 手动关闭）。
- **安装版（NSIS）与便携版（Portable）双通道**：
  - **安装版**：接入 `electron-updater`（`autoDownload = false`），安装前经 [index.ts](../src/main/index.ts) `prepareQuitForUpdate()` 协调关闭到托盘状态、清理登录与续期任务并销毁托盘后再调用 `quitAndInstall(false, true)`；
  - **便携版**：直接请求 GitHub Releases API 校验语义版本与可信下载域名，以独占 `.part` 句柄流式下载至系统「下载」目录并校验字节数后原子重命名，最后定位至资源管理器。

---

## 3. 硬性安全红线（所有改动与验收必须遵守）

1. **只读保护 `~/.t3`**：严禁写入、修改或删除 `~/.t3` 下任何文件；严禁对 `origin === 't3'` 或解析指向 `~/.t3` 的别名目录拉起可能写回目录状态的外部 CLI。
2. **保护参考原图**：`docs/references/` 下所有参考截图始终保留无损原图，不得有损压缩或改动。
3. **零实弹兑换与脱敏**：任何自动化测试、人工脚本或冷启动验收均**禁止**触发真实的 Codex 重置券兑换；账号邮箱仅在应用 UI 显示，不得写进终端输出、日志、文档、工单或测试夹具；凭证和授权码不得泄露。

---

## 4. 迭代规范归档索引（`docs/specs/`）

| 序号 | 版本 | 文档 | 主题摘要 |
| --- | --- | --- | --- |
| 001 | `v0.1.0` | [001-v0.1.0-initial.md](specs/001-v0.1.0-initial.md) | 独立桌面端初始架构、4 家解析器、定价与基础 UI 框架 |
| 002 | `v0.2.0` | [002-v0.2.0-antigravity-limits.md](specs/002-v0.2.0-antigravity-limits.md) | Antigravity 隔离自动续期、`limits-cache.json` 持久缓存、分级报错 |
| 003 | `v0.3.0` | [003-v0.3.0-ui-alignment.md](specs/003-v0.3.0-ui-alignment.md) | 6 张参考图 1:1 视觉与交互对齐、Codex 重置券兑换与二次确认 |
| 004 | `v0.3.1` | [004-v0.3.1-polish.md](specs/004-v0.3.1-polish.md) | 历史扫描与开关解耦、窗口最大化/还原按钮、Antigravity 图标与额度分组排序 |
| 005 | `v0.4.0` | [005-v0.4.0-auth-and-updates.md](specs/005-v0.4.0-auth-and-updates.md) | 精准识别本机已登录凭证、账号删除/隐藏、应用内隔离登录与 GitHub Releases 检查更新 |
| 006 | `v0.4.1` | [006-v0.4.1-ux-refinements.md](specs/006-v0.4.1-ux-refinements.md) | 检查更新微动画与固定顶栏胶囊、登录链接自动复制与免自动弹窗、提供方图标下拉 |
| 007 | `v0.5.0` | [007-v0.5.0-rebrand-tray-panel-account-switch.md](specs/007-v0.5.0-rebrand-tray-panel-account-switch.md) | 更名为 T3-like UsageBoard 与新 Logo、userData 迁移、分类条重设计、邮箱归并与快捷切号、托盘额度小面板 |

> 后续每轮新需求在 `docs/specs/` 下按 `NNN-vX.Y.Z-<slug>.md` 递增新建；合入并完成版本发布后，如改变了全局默认行为，同步更新本页对应条目。

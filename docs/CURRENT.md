# T3-like UsageBoard 当前生效架构与约定

本文档为当前仓库的**单一真值索引（Source of Truth）**。早期历史工单中已被后续版本推翻的设计（例如初版 `#09090b` 背景色、单选提供方、禁止历史扫描已关闭账号等）均以本页及最新 `docs/specs/` 为准。

---

## 1. 项目定位与协作分工

- **项目定位**：从 MIT 协议开源项目 T3 Code（`https://github.com/pingdotgg/t3code`）拆出的独立 Windows 桌面 AI 用量与实时额度看板，仅覆盖 `antigravity`、`opencode`、`codex`、`claude` 四家本地数据源，界面采用简体中文、最小化到系统托盘。
- **版本真值**：唯一版本真值写在 [package.json](../package.json) 的 `version`，经 [version.ts](../src/shared/version.ts) 供托盘与构建复用。
- **协同流程**：
  1. **方案阶段（Antigravity）**：Henry 提需求，Antigravity 对照参考图与源码编写/累加方案（`docs/specs/NNN-vX.Y.Z-<slug>.md`），期间不直接修改业务代码；
  2. **执行阶段（GPT）**：Henry 确认开始执行方案后，交由 GPT 按定稿方案完成代码实现与单元测试；
  3. **独立验收与返工（Antigravity ↔ GPT）**：Antigravity 独立审阅代码并跑校验，发现问题则整理返工项交由 GPT 修正，直至验收通过；
  4. **本地提交与打包实测（Antigravity → Henry）**：验收通过后先完成本地 `git commit`（暂不推送/打标），汇总提醒本次改动内容并构建 `dist/` Windows 双包供 Henry 实机验收；
  5. **发布收口（Antigravity）**：Henry 实机验收确认 OK 后，执行 `git push` 推送代码、打 `vX.Y.Z` 标签并发布 GitHub Release。

---

## 2. 当前生效的设计与技术规则

### 2.1 视觉与桌面窗口
- **色彩与字体**：OLED 纯黑主画布 `#000000`（`BrowserWindow.backgroundColor` 与 CSS `--color-canvas`）、卡片 `#111111`、`16px` 根字号、主体容器 `max-width: 1024px`。随包内置 Adobe 思源宋体简体中文可变字体 [`SourceHanSerifSC-VF.otf.woff2`](../src/renderer/assets/fonts/SourceHanSerifSC-VF.otf.woff2)（OFL-1.1 完整许可见 [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md)），[globals.css](../src/renderer/styles/globals.css) 以无 `local()`、`font-display: block` 的独立族名 `"T3UsageBoard Serif SC"` 置于 `--font-sans` 首项并配合 [electron.vite.config.ts](../electron.vite.config.ts) CSP `font-src 'self'`，消除未安装字体电脑回退 `SimSun` 的观感差异（不设字体切换开关）。
- **分类条与图标**：[usagePresentation.ts](../src/renderer/usagePresentation.ts) 与 [UsageShareBar.tsx](../src/renderer/components/UsageShareBar.tsx) 的「按类型统计的费用 / token」条带在 `cost` 与 `tokens` 两种视图下均固定按 `缓存读取 → 缓存创建 → 输入 → 输出` 4 段排列（保留语义原色：25% 深灰 → 45% 中灰 → 70% 浅灰 → `#f4f4f5` 近白 + `2px` 黑缝，已移除 `未拆分` 斜纹分段；[PriceOverridesDialog.tsx](../src/renderer/components/PriceOverridesDialog.tsx) 同步改为 `缓存读取` / `缓存创建`）；应用图标母版为 [logo.svg](../resources/logo.svg) 并导出 `16/20/24/32/48/256` 多尺寸 `tray-icon.ico`。
- **顶栏与窗口控制**：左侧面包屑 `用量` 置灰 + 高亮提供方多选触发器（原生 `popover="auto"` 多选菜单 + `uiPreferences.hiddenProviders` 持久化）；右侧时间窗（`过去 24 小时` / `7 天` / `30 天` / `90 天`）、视图切换（`费用 (C)` / `token (T)` / `账号 (A)`，底层保留 `'limits'` 枚举兼容旧偏好）均为无外框分段开关（`#0b0b0b` 槽 + `#1e1e1e` 选中态），右侧控制区含刷新、设置（含「账号管理 / 自定义模型价格 / 检查更新」）及「最小化 / 最大化（向下还原）/ 关闭到托盘」三键与主进程事件双向同步。费用总览副标题仅展示 `{sessions} 个会话`；模型详情弹窗右上角提供两阶段极速刷新（先快刷当前提供方 + `opencode.db` 增量 `rowid` 游标，再后台静默同步其余提供方，支持 `R` 键），并在存在生效单价时于标题模型名右侧提供 `CircleHelp` 浮层，以共享列轨、统一左对齐的纯数字表格（常规模型为「类型 | 价格（美元/M）」两列，峰谷模型自动切换为「类型 | 峰期（美元/M） | 谷期（美元/M）」三列）展示输入、输出、缓存读取、缓存创建，附上下文阶梯价、`峰期` / `谷期` 本地时段说明与 `自定义价格` 标记（不暴露底层数据源技术术语，支持 `Esc` 分级收起）。
- **应用内更新公告（[releaseNotes.ts](../src/shared/releaseNotes.ts)、[ReleaseNotesDialog.tsx](../src/renderer/components/ReleaseNotesDialog.tsx)）**：内置当版简体中文 Markdown 更新公告，经轻量安全解析（`###` 小节、`- ` 列表、`**加粗**`、`` `行内代码` ``，不使用 `dangerouslySetInnerHTML`）渲染；按 `config.json` 历史配置痕迹与 `preferences.lastSeenVersion` 严格区分全新安装（静默记录当前版本不弹窗）与旧版升级（主面板可见且无其他模态框时自动弹出，托盘小面板与后台静默自启期间不触发）；不保留历史版本列表，顶栏设置菜单不再提供回看入口。
- **提供方图标**：[ProviderMark.tsx](../src/renderer/components/ProviderMark.tsx) 中 `Antigravity` 1:1 采用 T3 原版实心多色渐变图标（128×128 PNG data URI）。

### 2.2 账号发现、历史扫描、应用内登录、身份归并与快捷切号
- **两层发现机制与精准凭证过滤**（已彻底移除 T3 运行时发现、`t3Reader.ts`、`resolveManagedAgy`、`AccountOrigin` `'t3'` 及「扫描 T3 账号 / `scanT3`」开关；旧 `config.json` 的 `scanT3` 与 `limits-cache.json` 的 `'t3'` 旧记录在读取时静默剥离/忽略）：
  1. `native`：原生默认目录及激活凭据槽（Windows 系统凭据槽 `gemini:antigravity` 经 `CredReadW` UTF-8 `cliToken` 解析为 Antigravity `当前` 槽位，`$CODEX_HOME/auth.json` 或 `~/.codex/auth.json` 标记为 Codex `当前` 槽位；另扫描 `~/.gemini/antigravity-acp`、`~/.claude`、`~/.gemini/{antigravity,antigravity-cli,antigravity-ide,antigravity-backup}`、`~/.config/antigravity`、`%LOCALAPPDATA%\opencode` / `~/.local/share/opencode` 等）；
  2. `manual`：应用内直接登录（OAuth / Go API Key）或手动添加，加密单文件凭证存于 `%APPDATA%/t3-like-usageboard/accounts/<id>/`，隔离 CLI home 存于 `%APPDATA%/t3-like-usageboard/profiles/<id>/`。首次启动经 [userDataMigration.ts](../src/main/userDataMigration.ts) 复制旧目录配置与 `Local State`（含 `safeStorage` 密钥），保留旧目录作备份。
  - [accounts/service.ts](../src/main/accounts/service.ts) 在「账号管理」列表与实时额度队列中仅展示持有可用登录凭证的条目（自动滤除仅有对话历史的空目录与已退出 `~/.claude`），并与 `config.hiddenAccountIds` 配合提供「删除 / 移除 / 恢复显示」能力（移除自动发现账号绝不改动原机文件）。
- **邮箱显示、身份归并与全局置顶排序**：所有 UI 位置的账号名固定展示不可编辑的规范化邮箱（OpenCode Go 固定为 `OpenCode Go`），经 [identities.ts](../src/main/accounts/identities.ts) 持久化至 `identities.json`，同提供方下相同小写邮箱归并为单行；「账号管理」行采用「提供方图标 + 第一行提供方名 + 第二行邮箱与『当前』胶囊」（已移除来源文字、目录路径和编辑入口）。同一提供方内 `current === true` 的激活账号在「账号管理」同组第 1 行、主面板「限制」页最左第 1 列与托盘小面板组内第 1 位均全局置顶，其余账号按规范化邮箱字典序稳定排列。
- **快捷切换账号（「设为当前」/「切换」）**：仅支持 Codex 与持有 `cliToken` 的 Antigravity（App / CLI），提供三个切号入口——「账号管理」行内 `设为当前` 弹窗、主面板「限制」页顶部非当前账号胶囊二次确认弹窗、托盘额度小面板行内 `切换` 二次确认条（[ipc.ts](../src/main/ipc.ts) 中 `switchAccount` 校验为 `mainOrTray` 并在托盘切号期间抑制外部 App 重启引发的 `blur` 自动收起）。在 [switchAccount.ts](../src/main/accounts/switchAccount.ts) 均经默认聚焦「取消」的二次确认触发；执行期持有 `limits.exclusiveSwitch` 互斥屏障，先自动加密快照或回写当前激活账号、按需保留 `.bak-usageboard-*` 备份并支持失败回滚，通过 [windowsSwitchProcesses.ts](../src/main/accounts/windowsSwitchProcesses.ts) 精准重启 `OpenAI.Codex`（`ChatGPT.exe` + `app-server`）或 `Antigravity.exe` 进程树（不误杀终端 CLI、`Antigravity IDE` 或 VS Code 下 `agy.exe`）。
- **历史统计 vs 实时额度解耦**：
  - [usage/service.ts](../src/main/usage/service.ts)：`native` 数据目录（含无凭证历史目录与已隐藏账号目录）**始终参与历史费用与 Token 扫描**，对齐 T3 统计口径；仅被显式关闭的 `manual` 目录跳过历史扫描。
  - [limits/service.ts](../src/main/limits/service.ts)：「限制」页与托盘额度面板严格尊重启用状态；当前账号只探测默认激活槽位，应用内副本在激活期间冻结，切换时再回写以防 refresh token 互挤。
- **应用内隔离登录（[loginManager.ts](../src/main/accounts/loginManager.ts)）**：
  - 「添加账号 → 提供方」采用自绘深色 `ProviderSelect` 下拉组件，选项与触发器均展示对应 `<ProviderMark />` 品牌图标（按 `Esc` 仅收起下拉而不关闭「账号管理」弹窗）；「浏览器登录」仅返回授权链接、**绝不自动拉起系统浏览器**，前端经主进程 `clipboard.writeText` 自动复制链接并在弹窗内展示只读可点击复制输入框（2 秒 `已复制链接` 提示）与显式 `打开` 按钮。
  - `Antigravity`：调用本机 `agy acp --login`（强制 `SSH_CONNECTION` 与独立 `GEMINI_HOME`），经授权码回填后由 `safeStorage` 加密写入 `accounts/<id>/`；
  - `Codex`：调用 `codex -c cli_auth_credentials_store="file" app-server` 在隔离 `profiles/<id>/`（`CODEX_HOME`）完成 ChatGPT OAuth；
  - `Claude Code`：保留宿主浏览器及用户临时目录环境变量、注入 `BROWSER: '__USAGE_DASHBOARD_NO_BROWSER__'` 抑制 CLI 自动打开浏览器并放行 `claude.ai` / `claude.com` / `platform.claude.com` / `console.anthropic.com`，通过 `CLAUDE_CONFIG_DIR` 隔离完成 `claude auth login --claudeai`；
  - `OpenCode`：应用内输入 Go API Key 并经 `safeStorage` 加密存储。
- **模型归一化与计价**：OpenCode 与使用非默认 `model_provider`（非 `openai`）的 Codex 会话按小写渠道前缀 `<provider>/<model>`（经 [modelNormalize.ts](../src/shared/modelNormalize.ts) `qualifyModelId` 防重前缀）拆分聚合桶、明细展示与自定义价格；`normalizeModelId` 仅对 `/` 右侧剥离思考强度后缀（[scanCache.ts](../src/main/usage/scanCache.ts) 缓存版本 `v4`，并记录 `opencode.db` 各消息表已扫最大 `rowid` 做增量合并）。[opencodePricing.ts](../src/main/usage/opencodePricing.ts) 仅通过脱敏投影解析器只读热加载本机 `opencode.json` / `opencode.jsonc` 中用户手写的私有渠道 `cost` 覆写（`userRates`，按 `(mtimeMs, size)` 指纹失效），彻底不读 OpenCode `models.json` 或 `opencode.db` 目录缓存。全应用唯一官方定价源为 `models.dev`：[modelsDev.ts](../src/main/usage/modelsDev.ts) 随包内置精简快照 `resources/models-dev-snapshot.json`（`pnpm update:models` 生成），运行时优先读取未满 24h 的 `userData/models-dev-cache.json`，否则立即用旧缓存/内置快照秒回并经主进程 `electron.net.fetch` 在后台去重拉取（`ETag` / `304` / 实验路径 404·5xx 自动降级稳定地址）；[pricing.ts](../src/main/usage/pricing.ts)、[pricePresets.ts](../src/main/usage/pricePresets.ts) 与 [rateModel.ts](../src/main/usage/rateModel.ts) 共享同一快照格式与费率解析器；按 `canonical_id` 建立同厂索引，仅对 `openai-codex/`、`openai-chatgpt/`、`claude-code/`、`dashscope/`、`bedrock/` 做同义渠道转发，未知/私有中转前缀不配自定义单价时一律 `unpriced`，快照日期后缀（`-YYYYMMDD` / `-YYYY-MM-DD`）在同一渠道内回退基础型号。[pricingMultipliers.ts](../src/shared/pricingMultipliers.ts) 按 `UsageRecord.timestampMs` 求值 `utc_days`、`utc_hours`、`date`、`service_tier` 及 `all / any / not`，`fast` 同时匹配 `fast` / `priority` 层级，仅忽略 `not: { holiday }`；含 `region` 等未知条件键的分支一律视为不可满足，绝不把地区加价摊给所有用户。优先级为 `UsageBoard priceOverrides > OpenCode 用户配置单价 > models.dev 快照`（前两项用户显式单价覆盖日志旧 `reportedCostUsd`）；`UsageSummary.modelPrices` 随附当前窗口内已出现模型的生效单价摘要（已生效的纯 `date` 调价同步折算进展示单价）；[aggregation.ts](../src/main/usage/aggregation.ts) 保持模型渠道隔离，**凡查不到单价的模型（除明确上报 `$0` 的免费模型外）一律标记为 `unpriced`（`未定价`）**；美元统一输出 `US$`。
- **价格预设与自定义峰谷计价**：[pricePresets.ts](../src/main/usage/pricePresets.ts) 与计价器共用同一 `models.dev` 精简快照（`version: 6`，含全库 `adoption` 接入计数；`catalog` 仅保留 32 家 Tier A/Tier B 渠道的 ID、`canonical_id`、`release_date`、输出模态，`rates` 覆盖全部已定价渠道），不读取本机 OpenCode 文件，也不使用 LiteLLM；按固定热门顺位收录 Tier A 16 家原厂直营站与 Tier B 16 家主流国内云站/头部网关（过滤其余杂牌中转及各类 `*-coding-plan` / `*-token-plan` / `*-step-plan`），以 `canonical_id` 判定原厂归属并保证每个底层模型仅有唯一 `primary: true` 原厂代表项（国际站优先于 `-cn` 站，跨厂转售仅作非原厂渠道保留）；同 Provider 内区域前缀与 `/routers/` 副本折叠为 `aliases`，同站点不同价子型号独立保留并标记 `derived: true`；热门度按 `release_date` 新鲜度 × 全库 `adoption` 接入广度取 `log2(adoption + 2)` 做对数压缩后按厂内相对计分（子变体权重 `0.25`，`flash` / `lite` / `mini` / `nano` / `haiku` 轻量档权重 `0.85`），剔除纯生图/纯音频/纯视频与向量/重排模型，图文音多模态输出降权 `0.05`；预设直接以 `provider/model` 作为展示名。已删除旧版行下时间编辑子行与草稿代码；[PriceOverridesDialog.tsx](../src/renderer/components/PriceOverridesDialog.tsx) 保持 7 列单行结构：带时段峰谷的预设项在 `入 $...` 左侧显示 `Clock` 小图标，悬停以 `position: fixed` 气泡按 `高峰期（2x）` / `低谷期（0.5x）` → 折算单价 → 本地时段三行展示；点选后在「模型 ID」单元格同行右侧出现紧凑 `role="switch"` 「峰谷」胶囊（整行 `align-items: center` 严格居中），悬停按当前输入框实时基础单价 × `factor` 动态展示峰/谷单价并支持 `Escape` 仅收起气泡，`multipliersEnabled = false` 时胶囊置灰且保存后下次仍保留关闭态。
  - 「选择预设」交互：搜索框为空时对 `providerRank < 10` 的头部原厂各取前两款非衍生正代主力做两轮轮询首屏，再按厂商顺位分块追加其余 `primary` 代表；已填模型 ID 的行打开时自动将完整 `row.model.trim()` 预填进搜索框并单次 `select()` 全选（后续输入不再重复聚焦/全选），非空搜索词走统一搜索（忽略 `- _ . /` 与空格分隔符做容错匹配，按精确 / 前缀 / 原始子串 / 模糊四级相关性排序，普通词优先原厂代表；单段 `<provider>/<model>` 查询会拆出右侧模型名并剥离思考挡位、快照日期与 `-free` 后缀的基础名召回，仅保留对应模型且按「同渠道精确 → 同渠道基础款 → 同渠道前缀 → 跨渠道精确 → 跨渠道基础款 → 其余模糊命中」排序，不再拼接无关兜底模型）；下拉项仅在模型 ID 实际横向截断时，于列表外以 `position: fixed` 视口夹紧的自绘气泡展示完整名称（不使用原生 `title`，默认上方、空间不足翻至下方），鼠标移出、列表滚动、搜索词变化、关闭菜单或窗口 `resize` / `blur` 时立即清除；预设菜单固定 `560px` 宽，选项行高 `30px`、间距 `2px`，按最多 `9` 整行（`342px`）量化高度，视口不足时以 `rowsFit` 取整行数精确收缩，消除底部半行裁切。

### 2.3 账号页、托盘额度小面板与特殊交互
- **主面板「账号」页（原「限制」页）顶部对齐账号胶囊栏与额度条**：
  - 每个提供方标题右侧按两列主栅格同行渲染有序账号胶囊栏（`current` 居最左第 1 列，胶囊 `line-height: 1.4` 完整容纳邮箱下延笔画；下方各窗口额度列严格按同一完整账号列序对齐，缺失项渲染空占位槽），下方 `32px` 额度条内不再重复显示邮箱，仅展示剩余百分比与徽章；非当前可切换的 Codex / Antigravity 胶囊常态无常驻按钮、悬停/聚焦浮现 `切换` 轻提示，点击弹出默认聚焦「取消」的二次确认切号弹窗；存在凭证过期 / 缺少 `agy` CLI / 刷新失败 `issue` 的账号胶囊禁用切号并常驻琥珀色警告图标（刷新中切换为琥珀色旋转 `LoaderCircle`），其列下额度条采用暗琥珀 45° 斜纹警示态与细琥珀内描边（刷新中叠加横向流光动画），悬停/聚焦/点击弹出精简诊断浮层（`cli_missing` 附官方安装页链接 `https://antigravity.google/product/antigravity-cli`，`manual` 过期账号附「账号管理」入口，并提供保焦「重试」按钮）。
- **Antigravity 额度顺序、窗口命名与自动续期**：
  - Codex 会话窗口标签统一为 `5-Hour`（搭配 `Weekly` / `Monthly`）；[usageLimits.ts](../src/shared/usageLimits.ts) 对 Antigravity 窗口按模型家族优先分组再按时长排序：`Gemini · 5-hour` → `Gemini · Weekly` → `Claude & GPT (shared) · 5-hour` → `Claude & GPT (shared) · Weekly`（其他提供方相对顺序不变）。
  - Antigravity 过期 token 通过隔离临时目录调用 `agy` CLI 串行静默续期，新 token 加密缓存在应用私有 `userData`，绝不修改本机外部或 `~/.t3` 目录文件。
  - `limits-cache.json` 持久化最近一次有效读数，冷启动立即恢复旧值后再刷新；已移除页面底部全局黄色警告栏，改为异常账号始终保留在提供方邮箱胶囊栏（即使无缓存窗口读数），通过胶囊常驻警告图标与悬浮诊断浮层分级展示「凭证过期 / 缺少 `agy` CLI / 刷新失败」恢复引导；限额详情浮层不再展示「来源」行。
- **Codex 重置券兑换**：
  - 单行 `32px` 额度条左侧显示同池多账号 `↻ +XX%` 回血预期，白色 `2px` 匀速刻度线使用 `--limit-tick-at` 同时驱动轨道镂空，悬停或键盘打开统一详情 `popover="auto"` 展示各账号余量与重置券。
  - 「使用重置」仅先收起浮层并打开独立的 `使用重置券？` 二次确认弹窗，**默认聚焦「取消」防回车误触**；服务端具备 HTTP 直连优先 + CLI 回退、跨账号别名串行互斥锁、粘性 `idempotencyKey` 防重放及兑换后退避重查。
- **托盘额度小面板（[tray.ts](../src/main/tray.ts)、[trayPanel.ts](../src/main/trayPanel.ts)、[TrayPanel.tsx](../src/renderer/components/TrayPanel.tsx)）**：
  - 左键单击托盘图标（`400ms` 去抖防双击闪跳）贴近任务栏四向边缘弹出 `360px` 宽（高度自适应、上限 `520px`）独立无边框面板（双击不额外切换主窗），采用四列固定槽位对齐（窗口短标签 + 进度条与匀速刻度 + 右对齐百分比 + 右对齐本地绝对重置时刻 `HH:mm` / `周XHH:mm` / `M/D HH:mm`，其中 `1 <= days <= 7`（含同星期几相差 7 天）统一走 `周XHH:mm`，无重置时间保留空占位槽），`current` 账号组内第 1 位显示，移除行内原生 `title` 与整行焦点捕获，改为面板顶层自绘暗色微提示按目标单元格独立命中（额度条撑满行高热区并支持满血无计时反馈、百分比精确 1 位小数、`周XHH:MM` 悬浮显示 `MM月DD日 周XHH:MM`、窗口简称/超长邮箱与重置券独立提示）、Codex 重置券只读徽章（不在小面板直接兑换）及行内二次确认切号（默认聚焦 `取消`、支持 `Esc` 分级取消与切号期 `blur` 保护），底部提供「刷新」与「打开主面板」；右键菜单首项保留「显示主面板」。

### 2.4 应用更新与分发（[updater.ts](../src/main/updater.ts)）
- **发布源与触发策略**：通过公开 GitHub Releases（当前配置 `Henry-916/T3-like-UsageBoard`）检查新版本；打包后启动延迟 `10s` 首检并每 `4h` 静默复检（404 / 离线及无新版静默忽略，仅在有新版/下载中/就绪时在顶栏显示胶囊）；设置菜单、账号管理页脚与系统托盘菜单均提供手动检查（`manual: true`）、下载与安装入口——手动检查期间在固定顶栏（[TopBar.tsx](../src/renderer/components/TopBar.tsx)）展示 `LoaderCircle` 旋转胶囊（`正在检查…`）并在页脚按钮显示 `检查中…`，无新版/失败提示渲染于固定顶栏 `.titlebar-update-feedback` 胶囊（不随页面滚动、`4s` 自动收起且支持 `×` 手动关闭）。
- **安装版（NSIS）与便携版（Portable）双通道**：
  - **安装版**：接入 `electron-updater`（`autoDownload = false`），安装前经 [index.ts](../src/main/index.ts) `prepareQuitForUpdate()` 协调关闭到托盘状态、清理登录与续期任务并销毁托盘后再调用 `quitAndInstall(false, true)`；
  - **便携版**：直接请求 GitHub Releases API 校验语义版本与可信下载域名，以独占 `.part` 句柄流式下载至系统「下载」目录并校验字节数后原子重命名，最后定位至资源管理器。

---

## 3. 硬性安全红线（所有改动与验收必须遵守）

1. **防御性保护 `~/.t3`**：尽管已移除所有 T3 运行时读取逻辑，[cli.ts](../src/main/limits/probes/cli.ts)（`safeCliDirectory` / `resolveAgyCli`）与 [switchAccount.ts](../src/main/accounts/switchAccount.ts)（`assertSwitchPath`）中拒绝写入或在 `~/.t3` 下拉起外部 CLI 的物理路径安全护栏仍须保留；严禁写入、修改或删除 `~/.t3` 下任何文件。
2. **保护参考原图**：`docs/references/` 下所有参考截图始终保留无损原图，不得有损压缩或改动。
3. **零实弹兑换、配置投影与脱敏**：任何自动化测试、人工脚本或冷启动验收均**禁止**触发真实的 Codex 重置券兑换；读取 `opencode.json` / `opencode.jsonc` 时仅投影提取模型 ID 与 `cost` 数值，严禁解码、缓存、打印或传递 `apiKey`、`headers`、`baseURL`、`options`；账号邮箱仅在应用 UI 显示，不得写进终端输出、日志、文档、工单或测试夹具；凭证和授权码不得泄露。

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
| 008 | `v0.5.1` | [008-v0.5.1-bundled-serif-font.md](specs/008-v0.5.1-bundled-serif-font.md) | 内置思源宋体可变字体、清空 T3 运行时代码、未定价不估算与 4 段费用条、当前账号置顶、限制页胶囊切号与托盘小面板精修 |
| 009 | `v0.5.2` | [009-v0.5.2-provider-qualified-models-and-opencode-pricing.md](specs/009-v0.5.2-provider-qualified-models-and-opencode-pricing.md) | 按上游 Provider 拆分模型统计（`<provider>/<model>`）、只读热加载 OpenCode 本地与目录定价、严格渠道隔离计价 |
| 010 | `v0.5.3` | [010-v0.5.3-ui-refinements.md](specs/010-v0.5.3-ui-refinements.md) | 分类条重排改名（`缓存读取 → 缓存创建 → 输入 → 输出`）、托盘「指哪显哪」悬浮与 `MM月DD日 周XHH:MM`、`账号 (A)` 改名与胶囊行高修复、移除「映射到」并引入每模型唯一的原厂价格预设、OpenCode `opencode.db` v3 目录计价、预设菜单 `560px` 整行量化、托盘 7 天 `周X` 修正与异常胶囊诊断浮层 |
| 011 | `v0.5.4` | [011-v0.5.4-whats-new-and-pricing-details.md](specs/011-v0.5.4-whats-new-and-pricing-details.md) | 全局统一 models.dev 内置快照与后台热更、峰谷预设图标与同行胶囊开关、Markdown 更新公告、模型详情两列单价表与两阶段刷新、费用总览会话数精简 |

> 后续每轮新需求在 `docs/specs/` 下按 `NNN-vX.Y.Z-<slug>.md` 递增新建；合入并完成版本发布后，如改变了全局默认行为，同步更新本页对应条目。

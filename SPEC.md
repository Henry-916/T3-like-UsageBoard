# UsageDashboard 独立桌面用量看板 — 开发方案

## 1. 项目定位与范围
将开源项目 `https://github.com/pingdotgg/t3code`（MIT 协议）中的 **Usage（用量）面板**拆出为独立的 Windows 桌面程序。

- **桌面形态**：Electron 桌面应用，关闭窗口默认最小化到系统托盘；**单击托盘图标直接显示/隐藏主面板窗口**；右键托盘菜单提供「显示主面板 / 立即刷新 / 开机自启 / 退出」。
- **支持的数据源（仅 4 家）**：
  - `antigravity`（Antigravity）
  - `opencode`（OpenCode）
  - `codex`（Codex）
  - `claude`（Claude Code）
- **核心视图（3 个主页面 + 3 个弹窗）**：
  1. **费用页（Cost）**：总费用、按提供方拆分与日/小时曲线、总计 5 项、按费用类型分段条、按模型/按天明细。
  2. **token 页（Tokens）**：总 token、按提供方拆分与日/小时曲线、总计 5 项、按 token 类型分段条、按模型/按天明细。
  3. **限制页（Limits）**：多账号池化额度条（5h / Weekly / 模型专属窗口）、下次重置倒计时、重置恢复量（`+XX%` + 斜线预览）、Codex 重置券数量显示、账号详情气泡。
  4. **模型详情弹窗**：单模型趋势图、百万 token 均价、缓存命中率、未定价模型快捷跳转设价。
  5. **自定义价格与模型映射弹窗**：手动覆盖单价、设置模型别名映射（Map to）。
  6. **账号与数据源管理弹窗**：展示自动发现的账号（标记来源：`原生` / `T3` / `手动`）、支持开关/重命名、支持手动新增/导入凭证或目录。
- **明确不做**：多台机器/多环境选择、CLIProxyAPI hub、Cursor/Grok/Pi/Muse、Effect-TS、i18n 多语言框架（界面直接做简体中文）。
- **开源协议合规**：项目根目录放置 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`，保留 T3 Code MIT 版权声明（`Copyright (c) 2026 T3 Tools Inc.`）。

---

## 2. 技术栈与目录结构

- **Runtime & 打包**：Electron 39+（内置 Node 22/24，原生支持 `node:sqlite` `DatabaseSync`，**禁止引入 `better-sqlite3` 等需本地编译的 C++ 插件**）、`electron-vite`、`electron-builder`（产出 Windows NSIS 安装包 + Portable 便携版）。
- **语言与校验**：全项目纯 TypeScript（`async/await`，不使用 Effect-TS），运行期数据校验用 `zod`。
- **前端**：React 19 + Tailwind CSS v4 + `lucide-react` + 极简无头弹层（Radix UI 或 Base UI）。**图表直接移植 T3 的零依赖纯 SVG 平滑曲线组件**，不引入 Recharts/ECharts。
- **进程通信**：Electron `ipcMain.handle` + `preload` `contextBridge` 暴露类型安全的 `window.usageApi`（不额外起本地 HTTP Server）。
- **本地存储（`app.getPath("userData")`）**：
  - `config.json`：手动账号配置、是否扫描 T3 目录开关、账号别名/禁用状态、`priceOverrides`、`modelAliases`、界面偏好（上次 tab、时间窗、开机自启）。
  - `scan-cache.json`：文件 `(mtimeMs, size)` 增量扫描缓存 + 92 天历史记录快照（防止 Claude Code 30 天自动清日志导致历史丢失）。
  - `litellm-rates-cache.json`：LiteLLM 价格表本地 24h 缓存；同时在 `resources/fallback-rates.json` 打包一份离线兜底快照。

```text
UsageDashboard/
├── electron.vite.config.ts
├── electron-builder.yml
├── resources/
│   ├── tray-icon.ico / tray-icon.png
│   └── fallback-rates.json          # LiteLLM 价格离线兜底快照
├── src/
│   ├── shared/                      # Main / Preload / Renderer 共享类型与纯算法
│   │   ├── types.ts                 # UsageSummary / UsageBucket / LimitsReport / AccountConfig
│   │   ├── modelNormalize.ts        # 思考强度后缀合并与模型归一化
│   │   ├── usageFormat.ts           # 移植自 T3 usageFormat.ts
│   │   ├── usageMerge.ts            # 移植自 T3 usageMerge.ts
│   │   └── usageLimits.ts           # 移植自 T3 usageLimits.ts（去 effect/DateTime）
│   ├── main/
│   │   ├── index.ts                 # 应用生命周期、单实例锁、无边框暗色主窗口
│   │   ├── tray.ts                  # 系统托盘、单击显隐、右键菜单、开机自启
│   │   ├── ipc.ts                   # IPC handlers 注册
│   │   ├── configStore.ts           # config.json 原子读写
│   │   ├── accounts/
│   │   │   ├── discovery.ts         # 原生目录 + 只读 ~/.t3 扫描 + 手动账号合并
│   │   │   └── t3Reader.ts          # 只读解析 ~/.t3/userdata/settings.json 与 antigravity profiles
│   │   ├── usage/
│   │   │   ├── service.ts           # 扫描调度器、增量缓存、历史留存与聚合入口
│   │   │   ├── scanCache.ts         # scan-cache.json 读写与过期清理
│   │   │   ├── pricing.ts           # LiteLLM 价格拉取/缓存/查询/缓存节省额计算
│   │   │   ├── aggregation.ts       # 按 IANA 时区聚合到天/小时 + effort 合并
│   │   │   ├── transcriptReader.ts  # 流式 JSONL 扫描器
│   │   │   └── readers/
│   │   │       ├── claude.ts        # Claude Code JSONL 解析
│   │   │       ├── codex.ts         # Codex JSONL 累计差分解析
│   │   │       ├── opencode.ts      # OpenCode SQLite (node:sqlite) + 旧 JSON 解析
│   │   │       └── antigravity.ts   # Antigravity SQLite + protobuf 解析
│   │   └── limits/
│   │       ├── service.ts           # 并发探测调度、5 分钟自动刷新、失败保留上次快照
│   │       └── probes/
│   │           ├── antigravity.ts   # Google OAuth 刷新 + retrieveUserQuotaSummary
│   │           ├── codex.ts         # wham/usage + reset-credits / 回退 codex app-server
│   │           ├── claude.ts        # oauth/usage / 回退 claude CLI get_usage
│   │           └── opencode.ts      # opencode.ai/zen/go/v1/usage
│   ├── preload/
│   │   └── index.ts                 # contextBridge.exposeInMainWorld("usageApi", ...)
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── styles/globals.css       # 深色主题变量、衬线大数字、tabular-nums、斜线阴影纹理
│       ├── hooks/
│       │   ├── useUsageData.ts
│       │   └── useLimitsData.ts
│       └── components/
│           ├── TopBar.tsx           # 顶栏：提供方筛选、时间窗、费用/token/限制切换、刷新、设置、窗口控制
│           ├── CostTokenView.tsx    # 费用页 & token 页主体
│           ├── UsageProviderChart.tsx  # 纯 SVG 单调三次样条平滑曲线图 + hover tooltip
│           ├── TotalsStrip.tsx      # 5 列总计指标横条
│           ├── UsageShareBar.tsx    # 横向分段占比条 + 底部图例
│           ├── BreakdownTable.tsx   # 模型 / 天 明细列表（带行内占比底线）
│           ├── UsageModelDialog.tsx # 单模型详情弹窗
│           ├── LimitsView.tsx       # 限制页（移植 UsageLimitsPooled.tsx）
│           ├── PriceOverridesDialog.tsx # 自定义模型单价 & 别名映射
│           └── AccountsDialog.tsx   # 账号发现状态 + 手动增删改弹窗
└── tests/                           # Vitest 单元测试（解析器、effort 合并、定价、额度池化）
```

---

## 3. T3 Code 源码移植映射表

参考仓库：`https://github.com/pingdotgg/t3code`（本地参考副本在 `C:/Users/24701/AppData/Local/Temp/t3code-src`）。

| 目标模块 | T3 参考源文件 | 迁移方式 |
|---|---|---|
| 类型契约 | `packages/contracts/src/usage.ts`<br>`packages/contracts/src/providerUsageLimits.ts` | 去掉 `effect/Schema` 和多环境/hub 字段，转为纯 TS `interface` + `zod` |
| 格式化与合并 | `packages/shared/src/usageFormat.ts`<br>`packages/shared/src/usageMerge.ts` | **几乎原样拷贝**，删掉非 4 家 provider 枚举即可 |
| 额度池化算法 | `packages/shared/src/usageLimits.ts` | **直接移植核心算法**，将 `effect/DateTime` 替换为原生 `Date` / `Date.parse` |
| 定价与聚合 | `apps/server/src/usage/usagePricing.ts`<br>`apps/server/src/usage/usageAggregation.ts` | **直接移植**，在聚合入口插入思考强度归一化函数 `normalizeModelId` |
| JSONL 扫描器 | `apps/server/src/usage/usageTranscriptReader.ts`<br>`apps/server/src/usage/usageScanCache.ts` | 改用 `node:fs/promises` + `readline` / chunk 流式读取，保留按文件 mtime/size 缓存与去重语义 |
| Claude 解析 | `apps/server/src/provider/Drivers/claudeUsage.ts` | 保留 `parseClaudeRecord`（含 `messageId:requestId` 去重取最大值、`advisor_message` 拆分、`cacheCreation1hTokens`） |
| Codex 解析 | `apps/server/src/provider/Drivers/codexUsage.ts` | 保留状态机（累计快照差分、baseline 归零重算、`turn_context` / `thread_settings_applied` 追踪模型和 speed） |
| OpenCode 解析 | `packages/provider-opencode/src/server/usage.ts` | 保留 `parseOpenCodeMessage` 与 `node:sqlite` 分页查 `opencode.db` + 兼容旧 JSON 目录 |
| Antigravity 解析 | `apps/server/src/provider/Drivers/antigravityUsageReader.ts` | **完整保留手写 protobuf wire 解码器**、`MODEL_IDS` 映射表、以及 `node:sqlite` 分页读对话 DB（注意对 usage subarray 做 `.slice()` 防内存滞留） |
| 4 家额度探测 | `apps/server/src/provider/antigravityUsageLimits.ts`<br>`apps/server/src/provider/codexUsageLimits.ts`<br>`apps/server/src/provider/claudeUsageLimits.ts`<br>`apps/server/src/usage/cliproxyApi.ts`（参考直连 HTTP 头与端点）<br>`packages/provider-opencode/src/server/usageLimits.ts` | 改写为纯 `fetch` + `async/await`；Codex/Claude 支持直连 OAuth 接口并带本地 CLI 回退 |
| 图表与额度条 UI | `apps/web/src/components/usage/UsageProviderChart.tsx`<br>`apps/web/src/components/usage/UsageLimitsPooled.tsx`<br>`apps/web/src/components/usage/UsageShareBar.tsx`<br>`apps/web/src/components/usage/UsageModelDialog.tsx`<br>`apps/web/src/components/usage/UsagePriceOverrides.tsx` | 去掉 `gt-react`、T3 atom 状态、多环境逻辑，保留核心 SVG 曲线算法、池化进度条与斜线阴影渲染 |

---

## 4. 关键技术规格

### 4.1 思考强度（Effort）合并规则
用户在「明细」与「模型详情」中不区分同一模型的不同思考强度。在 `UsageAggregator` 处理每条 `UsageRecord` 时（位于 `modelAliases` 之前）执行 `normalizeModelId(provider, rawModel)`：
1. Antigravity 路由别名先映射：
   - `gemini-pro-orchestrator-neon` → `gemini-4-neon`
   - `gemini-pro-orchestrator-g1-pro` → `gemini-4-argon`
   - `/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/` → `gemini-3.5-flash`
   - `gemini-3.7-flash-safety-le` → `gemini-3.7-flash`
2. 统一剥离思考强度后缀（不区分大小写，允许重复剥离一次）：
   - `-(?:extra-low|xhigh|very-high|high|medium|low|minimal|tiered|thinking|control|agent|orchestrator)$`
   - 示例：`gemini-3.6-flash-high` / `gemini-3.6-flash-medium` / `gemini-3.6-flash-low` → 统一归为 `gemini-3.6-flash`。
3. 合并后，同一模型所有思考强度的 token、估算费用、缓存节省和会话数全部汇总在同一行；若用户还配置了自定义 `modelAliases`（Map to），再在其后生效。

### 4.2 三层混合账号与数据发现机制
1. **Layer 1：原生目录自动发现**
   - **Claude Code**：`CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `projects/`（历史 JSONL）与 `.credentials.json`（额度凭证）。
   - **Codex**：`CODEX_HOME` 或 `~/.codex` 下的 `sessions/`、`archived_sessions/`（历史 JSONL）与 `auth.json`（额度凭证）。
   - **OpenCode**：`OPENCODE_DATA_DIR`（逗号分隔）或 `XDG_DATA_HOME/opencode` 或 `~/.local/share/opencode`（Windows 同步检查 `%LOCALAPPDATA%\opencode`）下的 `opencode.db` 与 `auth.json`。
   - **Antigravity**：`ANTIGRAVITY_DATA_DIR`（逗号分隔）或 `~/.gemini/{antigravity,antigravity-cli,antigravity-ide,antigravity-backup}`、`~/.config/antigravity` 下的 `conversations/` 与 token 文件。
2. **Layer 2：只读扫描本机 T3 Code 目录（默认开启，可切换关闭）**
   - 只读解析 `~/.t3/userdata/settings.json` 中的 `providerInstances`（**严格只读，绝不写回 T3 目录内任何文件**）。
   - 提取 `driver` 为 `antigravity` / `codex` / `claudeAgent` / `opencode` 的实例配置，保留其 `displayName`（例如 `Antigravity-Fofinha`、`Antigravity-Henry916`、`Antigravity-yifan`）、自定义 `homePath` 与环境变量。
   - 对每个 Antigravity 实例，按 T3 规则定位 profile 目录：`~/.t3/userdata/providers/antigravity/<sha256(instanceId)>/antigravity-acp/`，分别扫描其中的 `conversations/` 历史和 `acp_token.json` / `antigravity-oauth-token`。
3. **Layer 3：应用内手动账号管理（独立于 T3）**
   - 在 `AccountsDialog` 中支持：
     - 查看所有已发现账号（来源标签：`原生` / `T3` / `手动`）、启用/禁用开关、自定义显示名。
     - 手动新增账号：
       - **Antigravity**：导入 `acp_token.json` 或 `antigravity-oauth-token` 文件（复制到应用自己的 `userData/accounts/`），或指定自定义数据目录。
       - **Codex / Claude Code**：指定自定义 Home 目录（含 `auth.json` / `.credentials.json` 与会话目录）。
       - **OpenCode**：指定自定义数据目录或填写 OpenCode Go API Key。
4. **跨来源去重**
   - **历史记录去重**：按真实目录路径（`fs.realpath`）去重，共享同一目录的账号只扫描一次。
   - **额度池去重**：Antigravity 按 Google `oauth2/v2/userinfo` 返回的 `id` 做 SHA-256 指纹去重；Codex 按 `chatgpt_account_id` / `accountId` 去重；Claude 按账号标识去重。同一账号在原生和 T3 同时存在时只计一次。

### 4.3 四家实时额度探测协议（Limits 页）
所有探测并发执行，单账号超时 15 秒；**单次探测失败时保留该账号上次成功的快照（`keepLastGoodReadings`）并在 tooltip 标明上次更新时间**，不能导致整个 Limits 页空白。

1. **Antigravity**：
   - 若存在 `acp_token.json`：POST `https://oauth2.googleapis.com/token` 用 `refresh_token` 换 `access_token`（仅缓存在内存中，不修改磁盘文件）。
   - 否则读取 `antigravity-oauth-token` 中的未过期 `access_token`。
   - 请求 `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`（`oauth-business` 优先 `cloudcode-pa.googleapis.com`，双端点合并），带 `User-Agent: antigravity/hub/2.24.0 (aidev_client; os_type=<platform>; arch=<arch>; cl=963137146)` 与 `{ project }`；若无返回则回退 `fetchAvailableModels`。
   - 窗口分组遵循 T3 逻辑：`gemini-argon-*`、`gemini-carbon-*`、`gemini-*`、`3p-*`（显示为 `Claude & GPT (shared)`），区分 `5-hour` 与 `Weekly`。
2. **Codex**：
   - **首选直连**：读取 `auth.json` 中的 OAuth access token，请求：
     - `GET https://chatgpt.com/backend-api/wham/usage`（Header 含 `Authorization: Bearer <token>`、`OpenAI-Beta: codex-1`、`Originator: Codex Desktop`、`Chatgpt-Account-Id`）
     - `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`（筛选 `reset_type === "codex_rate_limits"` 且 `status === "available"` 且未过期的重置券数量）
   - **回退方案**：若 `auth.json` 无可用 token 或返回 401，短生命周期拉起本地 `codex app-server` 通过 stdio JSON-RPC 调用 `account/rateLimits/read` 后立即关闭子进程。
3. **Claude Code**：
   - **首选直连**：读取 `.credentials.json` 中的 `claudeAiOauth.accessToken`，请求 `GET https://api.anthropic.com/api/oauth/usage`（Header 含 `Authorization: Bearer <token>`、`anthropic-beta: oauth-2025-04-20`、`User-Agent: claude-code/2.1.273`），解析 `five_hour`、`seven_day`、`limits`（model_scoped）、`extra_usage`/`spend`。
   - **回退方案**：若无本地凭证文件或 401，尝试调用本机 `claude` CLI 获取 usage，无订阅或纯 API Key 时静默标记不支持，不在 Limits 页报红。
4. **OpenCode**：
   - 依次从 `opencode.db`（`credential` 表 `integration_id IN ('opencode','opencode-go')`）、`auth.json`（`opencode-go`）、环境变量 `OPENCODE_API_KEY` 或手动配置中取 Key。
   - 请求 `GET https://opencode.ai/zen/go/v1/usage`（Bearer Token），解析 `rolling` / `weekly` / `monthly`；返回 403 表示非 Go 订阅，静默隐藏。

### 4.4 定价逻辑（Offline-First）
- 来源：`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`（24h 缓存，请求超时 8 秒）。
- **国内网络容错**：若拉取失败或超时，自动降级到 `litellm-rates-cache.json`，首次运行无缓存则降级到随包内置的 `resources/fallback-rates.json`，顶部仅在完全无价格表时轻提示。
- 支持用户自定义单价（`priceOverrides`）与模型映射（`modelAliases`），优先级：`providerReportedCost > priceOverrides > LiteLLM > unpriced`。

---

## 5. UI 视觉与交互规范

整体视觉直接对齐 T3 Code 暗色用量面板，**严格遵守极简信息密度：不加多余副标题、卡片说明文字或装饰性徽章，用字号层级、对齐和色条本身传达信息**。

- **配色与字体**：
  - 背景：`#09090b`（主画布）、`#111113`（卡片/弹窗表面）、边框 `rgba(255,255,255,0.08)`。
  - Provider 固定色值：Antigravity `#8c7bd1`、OpenCode `#5b9bbd`、Codex `#e4e4e7`、Claude Code `#d97757`。
  - 主指标大数字使用衬线体或高辨识度 display 字体，所有表格数值与百分比统一 `font-variant-numeric: tabular-nums`。
- **顶栏（单行，集成拖拽区 `webkit-app-region: drag`）**：
  - 左：`用量` / `所有提供方 ▾`（下拉筛选单个或全部提供方）
  - 右：时间窗口分段开关（`过去 24 小时` / `7 天` / `30 天` / `90 天`，在限制页隐藏）+ 视图切换（`费用` / `token` / `限制`）+ 刷新图标 + 设置菜单图标（打开「账号管理」「自定义模型价格」）+ 最小化 / 关闭（缩托盘）按钮。
- **费用 / token 页**：
  - 上半区：左列显示总额 + 会话数 + 按当前指标排序的提供方清单（圆点 + 图标 + 名称 + 会话数 + 占比/另一维度值 + 右对齐主指标）；右列纯 SVG 平滑曲线面积图（`过去 24 小时` 按小时粒度，其余按天粒度；支持 hover 竖线与浮层）。
  - 中部「总计」：5 列平铺（处理的 token、缓存的输入、未缓存的输入、输出、缓存节省）。
  - 中下部「按类型统计」：横向分段进度条 + 底部紧凑色块图例（费用页：输入 / 缓存读取 / 输出 / 其他；token 页：输入 / 缓存读取 / 缓存写入 / 输出）。
  - 下部「明细」：右上切换 `模型` / `天`。模型表每行含序号、图标 + 归一化后的模型名 + 名称下方占比细色条、费用、占比、token；点击行弹出 `UsageModelDialog`。
- **限制页**：
  - 按提供方分块，每个窗口一张横向卡片：
    - 左区：窗口名（如 `Gemini · Weekly`）+ 池化剩余大百分比（如 `44% 剩余`）+ 消耗速度箭头 + 下次重置回血提示（如 `↺ +33%`）。
    - 右区：等宽多账号分段进度条，每段内展示账号名、剩余%、倒计时、斜线阴影（`repeating-linear-gradient`）表示下次重置恢复段、Codex 重置券图标+数字；hover 或点击段落弹出详情 Popover（账号名、套餐、精确重置时间、数据来源）。
- **快捷键**：`C` / `T` / `L` 切视图，`Ctrl+Shift+1/2/3/4` 切 24h/7d/30d/90d，`R` 刷新，`Esc` 关弹窗或最小化到托盘。

---

## 6. 分阶段交付与验收标准

建议按以下 5 个里程碑推进，每完成一阶段验证后再进入下一阶段：

1. **Phase 1 — Electron + 托盘骨架**
   - 初始化 `electron-vite` + React 19 + Tailwind v4 + TypeScript 工程与 IPC 类型层。
   - **验收**：`pnpm dev` 启动暗色无边框窗口；点关闭按钮隐藏到系统托盘而不退出；单击托盘图标立即唤起/隐藏窗口；右键菜单可完全退出；单实例锁生效（重复启动聚焦已有窗口）。
2. **Phase 2 — 账号发现 + 4 家历史解析 + 定价聚合**
   - 实现原生目录发现 + 只读 `~/.t3` 解析 + 4 家历史解析器 + 增量缓存 + LiteLLM 价格表（含离线兜底）+ 思考强度归一化。
   - **验收**：Vitest 单元测试覆盖 4 家解析器、effort 合并（如 `gemini-3.6-flash-high/medium/low` 合并为一条）、定价与缓存节省计算；在真实本机数据上跑通扫描并输出正确的 `UsageSummary` JSON。
3. **Phase 3 — 费用页 & token 页完整 UI**
   - 实现顶栏筛选、纯 SVG 平滑曲线图、5 列总计、分段占比条、模型/天明细表、`UsageModelDialog`、`PriceOverridesDialog`。
   - **验收**：24h/7d/30d/90d 与提供方筛选切换流畅；曲线 hover 数值与明细汇总一致；修改自定义单价或模型映射后无需重启即时重算并持久化。
4. **Phase 4 — 实时额度探测 + 限制页 + 账号管理**
   - 实现 4 家额度探测、指纹去重、`usageLimits` 池化计算、限制页多账号进度条（含斜线重置预览与 Codex 重置券计数）、`AccountsDialog` 手动增删改与后台 5 分钟静默刷新。
   - **验收**：本机多 Antigravity 账号与 Codex 账号正确池化展示且不重复计数；断网或单账号失效时不崩溃并保留上次读数；手动导入账号或关闭 T3 扫描开关立即生效。
5. **Phase 5 — 细节打磨与 Windows 打包**
   - 补齐快捷键、开机自启、异常降级提示、MIT 版权声明，配置 `electron-builder`。
   - **验收**：`pnpm typecheck && pnpm test && pnpm build` 全绿；打出的 Windows 安装包/便携版冷启动与托盘常驻正常。

---

## 7. 给执行模型的关键避坑提醒

1. **SQLite 只读打开且防锁死**：读 `opencode.db` 和 Antigravity 对话 DB 必须使用 `new DatabaseSync(dbPath, { readOnly: true })` 并执行 `PRAGMA busy_timeout = 100`，扫描完立刻 `.close()`，避免锁住正在运行的 OpenCode / Antigravity。
2. **绝不修改 `~/.t3` 目录**：只读读取 `~/.t3/userdata/settings.json` 与 token 文件；Antigravity 刷新得到的短期 `access_token` 仅放内存缓存，不回写磁盘。
3. **Antigravity 大 BLOB 防 OOM**：单行 generation 元数据可能数 MB，务必保持按行分页查询（`LIMIT 1` / `LIMIT 64`），并在提取 usage 字节段后立刻 `.slice()` 独立拷贝，避免整行 Buffer 滞留内存。
4. **Windows 路径与编码**：展开 `~` 时优先取 `os.homedir()`；路径去重统一先 `path.resolve` + `fs.realpath` 并在 Windows 上做大小写规范化（`.toLowerCase()`）。
5. **不引入原生编译依赖**：不要装 `better-sqlite3`、`keytar`、`ffi-rs`；仅依赖 Electron 内置的 `node:sqlite` 与 Node 标准库，确保 Windows 打包零编译故障。

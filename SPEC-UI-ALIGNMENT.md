# UsageDashboard UI 1:1 视觉与交互对齐改造方案

## 1. 背景与视觉差异总览

基于 `references/` 下 6 张 `2560 × 1528` 原图截图（1:1 无损像素裁剪比对）及 T3 Code 源码核查，当前 `UsageDashboard` 与目标效果的主要视觉及交互差异集中在以下五个维度：

| 参考图 | 对应视图与重点细节 |
| :--- | :--- |
| `references/屏幕截图 2026-11-24 002218.png` | 「限制」页全貌：Codex 单账号池 + Antigravity 3 账号共享池、`32px` 单行进度条、匀速进度白线、右侧内嵌倒计时/重置券胶囊 |
| `references/屏幕截图 2026-11-24 002356.png` | 「token」页全貌：全局思源宋体数字、`800M` Y 轴刻度、`11月18日` X 轴刻度、「按类型统计的 token」首尾半圆胶囊条 |
| `references/屏幕截图 2026-11-24 002402.png` | 「费用」页全貌：`US$427.35` 主数字（`36px` `600`）+ `API 估算 ⓘ`、`总计` 五列指标、`按类型统计的费用` 零值过滤图例 |
| `references/屏幕截图 2026-11-24 105711.png` | 「限制」页悬停详情 Popover 与底部琥珀色账号过期警告框 |
| `references/屏幕截图 2026-11-24 105730.png` | 「费用」页折线图鼠标悬停垂直参考线与毛玻璃跟随 Tooltip（含 `ProviderMark` 图标） |
| `references/屏幕截图 2026-11-24 105746.png` | 顶栏面包屑配色（暗灰 `用量` / 亮白 `所有提供方`）与自定义多选提供方复选下拉菜单 |

### 差异根因汇总
1. **字体与字号层级割裂**：参考图全局使用 `Source Han Serif SC VF`（`16px` 根字号 + `-webkit-font-smoothing: antialiased` + `tabular-nums`），文字与大数字同源；当前实现全局使用 `"Segoe UI Variable Text", "Microsoft YaHei UI"` 无衬线黑体，却仅在 `.usage-figure` 上硬编码了 `Georgia` + `-0.055em` 负字距，且概览主数字（`~50px` `400`）和「总计」数字（`21px` `600`）与参考图（`36px` `600` / `16px` `500`）层级失衡。
2. **色彩与材质偏差**：参考图为 `#000000` 纯黑 OLED 画布、无描边深色分段器（`#0b0b0b` 槽 + `#1e1e1e` 滑块）、透明底细描边卡片、琥珀色警告框（`#281900`）与毛玻璃图表浮层；当前为 `#09090b`/`#111113` 偏灰实心面板与双层描边分段按钮。
3. **页面容器与顶栏筛选交互**：参考图内容容器为 `max-width: 1024px` (`max-w-5xl`) 居中；面包屑 `用量` 为暗灰、`所有提供方` 为亮白，点击弹出带 `✓` 与品牌图标的多选下拉菜单（勾选后保持菜单不关闭）；当前为 `1200px` 容器、主次颜色颠倒，且使用原生单选 `<select>`。
4. **「限制」页进度条结构差异**：参考图为 `32px` 高单行紧凑进度条、单账号池隐藏条内冗余名称/百分比、右侧内嵌深色胶囊（`↻ 3 小时 19 分钟 · 🎫 2`）、`clip-path` 透明切槽 + `2px` 亮白匀速进度竖线（Pace Tick）、共享悬停详情 Popover 与底部琥珀色异常警告框；当前为 `48px` 双行高框、重复显示 `Codex` 与百分比、且缺少匀速进度竖线与悬停 Popover。
5. **「费用 / token」页细节差异**：`US$` 货币前缀、提供方副文案、`ⓘ` 未定价浮泡、折线图毛玻璃跟随 Tooltip（使用 `ProviderMark` 品牌图标）、首尾半圆胶囊占比条（过滤 0 值项），以及 `过去 24 小时` 下自动切换 `模型 | 小时` 明细表。

---

## 2. 全局设计令牌：字体、纯黑配色与容器布局

### 2.1 字体栈与排版层级（`src/shared/types.ts`、`src/renderer/styles/globals.css`）

1. **配置项扩展（[`src/shared/types.ts`](src/shared/types.ts#L150-L154)）**：
   ```ts
   export const uiPreferencesSchema = z.object({
     tab: z.enum(['cost', 'tokens', 'limits']).optional(),
     window: z.enum(['24h', '7d', '30d', '90d']).optional(),
     hiddenProviders: z.array(providerSchema).optional()
   })
   ```
   - 不增加额外字体切换选项与 `fontStyle` 偏好，界面固定采用思源宋体（`Source Han Serif SC VF`）衬线字体栈。

2. **全局字体栈与抗锯齿（[`src/renderer/styles/globals.css`](src/renderer/styles/globals.css)）**：
   ```css
   @theme {
     --font-sans: "Source Han Serif SC VF", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", Georgia, serif;
   }

   html {
     font-size: 16px;
     -webkit-font-smoothing: antialiased;
   }
   ```
   - **彻底移除 `.usage-figure` 上独立的 `font-family: Georgia, "Times New Roman", serif` 与 `letter-spacing: -.055em`**，所有标题、正文、按钮、图表、表格及大数字均统一继承 `var(--font-sans)`，数字元素统一开启 `font-variant-numeric: tabular-nums`。

3. **字号与字重规范表**：

| 区域 | 字号 (`px` / `rem`) | 行高 | 字重 (`font-weight`) | 颜色 / 特性 |
| :--- | :--- | :--- | :--- | :--- |
| 概览主数字（`US$450.20` / `1.60B`） | `36px` / `2.25rem` | `2.5rem` | `600` | `#f5f5f5`，`tabular-nums` |
| 限制卡片主百分比（`91%` / `62%`） | `30px` / `1.875rem` | `2.25rem` | `600` | `#f5f5f5`，`tabular-nums` |
| 「总计」5 项指标数值（`1.68B`） | `16px` / `1rem` | `1.5rem` | `500` | `#f5f5f5`，`tabular-nums` |
| 区块标题 / 提供方标题 / 窗口名 | `14px` / `0.875rem` | `1.25rem` | `500` | `#f5f5f5` |
| 正文 / 提供方排行名称与金额 / 明细行 | `14px` / `0.875rem` | `1.4` | `400` / 金额 `500` | `#f5f5f5` / 次级 `#818181` |
| 副标题 / 表头 / 坐标轴 / Popover 正文 | `12px` / `0.75rem` | `1.35` | `400` | `#818181` |
| 紧凑徽章（限制条右端胶囊、会话数） | `11px` / `0.6875rem` | `1.2` | `400`（券数 `600`） | `#f5f5f5`，`tabular-nums` |

### 2.2 纯黑 OLED 色彩令牌与容器尺寸

1. **主进程窗口背景色（[`src/main/index.ts`](src/main/index.ts#L38)）**：
   - 将 `BrowserWindow` 配置中的 `backgroundColor` 由 `'#09090b'` 改为 `'#000000'`，消除冷启动闪烁灰底。

2. **CSS 变量令牌（源自参考图无损像素取色与 T3 暗色板）**：
   ```css
   :root {
     color-scheme: dark;
     --color-canvas: #000000;
     --color-panel: #111111;
     --color-popover: #0f0f0f;
     --color-ink: #f5f5f5;
     --color-subtle: #818181;
     --color-divider: #191919;
     --color-card-border: rgb(255 255 255 / 0.08);
     --color-row-divider: rgb(255 255 255 / 0.05);
     --control: #111111;
     --control-active: #1e1e1e;
     --hover: #141414;
     --focus: #346bf1;
     --segmented-track: #0b0b0b;
     --segmented-thumb: #1e1e1e;
     --warning: #fe9a00;
     --warning-ink: #ffb900;
     --warning-surface: #281900;
     --warning-border: rgb(254 154 0 / 0.32);
     --color-error: #ff6467;
   }
   ```
   - **细滚动条**：滚动条宽度收敛至 `6px`，轨道透明，滑块常规 `rgb(255 255 255 / 0.36)`、悬停 `rgb(255 255 255 / 0.45)`、圆角 `999px`。
   - **内容容器宽度**：`.usage-container` 改为 `max-width: 1024px; margin: 0 auto; padding: 24px 24px 48px;`，`.usage-overview` 纵向间距 `gap: 24px;`。

---

## 3. 顶栏（TopBar）与多选提供方筛选菜单

参考 `references/屏幕截图 2026-11-24 105746.png` 改造 [`src/renderer/components/TopBar.tsx`](src/renderer/components/TopBar.tsx)、[`src/renderer/main.tsx`](src/renderer/main.tsx) 与 [`src/renderer/styles/globals.css`](src/renderer/styles/globals.css)：

1. **面包屑主次配色反转与布局**：
   - 顶栏底边 `border-bottom: 1px solid var(--color-divider)`，纯黑背景 `var(--color-canvas)`，高度 `48px`，左右内边距 `padding-inline: 20px 10px`。
   - `<h1>用量</h1>`：`font-size: 14px; font-weight: 500; color: var(--color-subtle);`（暗灰 `#818181`）。
   - 分隔符 `/`：`color: #525252; font-size: 14px;`，左右间距 `10px`。

2. **多选提供方复选下拉菜单（替换原生 `<select>`）**：
   - `App` 与 `TopBar` 的提供方筛选状态从单选 `provider: ProviderFilter` 升级为 **`hiddenProviders: UsageProviderKind[]`**（默认 `[]`），通过 `saveUiPreferences({ hiddenProviders })` 自动持久化。
   - **触发器按钮**：无边框行内按钮，`font-size: 14px; font-weight: 500; color: var(--color-ink);`，右侧 `ChevronDown`（`14px`，常态 `opacity: 0.6`，hover / focus-visible / 弹窗展开时 `opacity: 1`）。
   - **触发器显示文案**：
     - `hiddenProviders.length === 0` -> `所有提供方`
     - `visible.length === 0` -> `无提供方`
     - `visible.length === 1` -> `providerInfo[visible[0]].label`
     - `visible.length >= 2`（但未全选） -> `${visible.length} 个提供方`
   - **下拉浮层定位与交互（`popover="auto"`）**：
     - 放在触发器紧邻后续节点；支持 `@supports (position-area: block-end span-inline-end)` 时使用 `inset: auto; position-area: block-end span-inline-end; position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline; margin-top: 6px;`，并在 `@supports not (position-area: block-end)` 场景下通过 `toggle` 事件按触发器 `getBoundingClientRect()` 计算并夹紧 `left`/`top`（`position: fixed; inset: auto; margin: 0;`），避免 Electron 无 `position-area` 环境飘移或裁切。
     - 必须声明 `-webkit-app-region: no-drag;` 保证 Electron 标题栏拖拽区域不吞掉鼠标悬停与点击事件。
     - 面板外观：`min-width: 184px; padding: 4px; border-radius: 8px; background: #111111; border: 1px solid #242424; box-shadow: 0 18px 44px -18px rgb(0 0 0 / 0.85);`。
     - 菜单项结构（排序：`codex`、`claude`、`opencode`、`antigravity`，或保持 `providers` 一致顺序）：
       1. 首行：`role="menuitemcheckbox"`，`aria-checked={hiddenProviders.length === 0}`，左侧固定 `16px` 宽度勾选槽（选中渲染 `<Check size={14} />`），文案 `所有提供方`；点击切换全选 / 全不选，**不关闭菜单**。
       2. 原生 `<hr className="menu-separator" />`（`border: 0; border-top: 1px solid #222222; margin: 4px -4px;`）。
       3. 各提供方项：`role="menuitemcheckbox"`，`aria-checked={!hiddenSet.has(kind)}`，左侧 `16px` 勾选槽 + `<ProviderMark provider={kind} className="size-3.5" />` + 提供方名称；点击切换该提供方的显示状态，**保持菜单展开不关闭**。
     - 键盘与焦点：支持 `ArrowDown` / `ArrowUp` / `Home` / `End` 在可聚焦项间切换，`Space` 切换勾选不关闭，`Escape` 关闭并将焦点恢复到触发按钮。

3. **去边框深色分段切换器（`.segmented`）**：
   - 容器：`background: var(--segmented-track)`（`#0b0b0b`），**`border: 0`**，`border-radius: 8px`，`padding: 2px`，`gap: 2px`。
   - 按钮：`min-width: 0; height: 24px; padding-inline: 10px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--color-subtle);`。
   - 悬停态：`background: rgb(255 255 255 / 0.04); color: var(--color-ink);`。
   - 激活态 `[aria-pressed="true"]`：`background: var(--segmented-thumb)`（`#1e1e1e`），`color: var(--color-ink)`，**`box-shadow: none`**。

4. **右侧操作区与窗口控制按钮**：
   - 移除 `.window-controls` 左侧的通高竖向分割线和 `47px` 矩形块。
   - 刷新、设置、最小化、关闭统一采用紧凑无框圆角图标按钮（`30px × 30px`，`border-radius: 6px`，图标 `15px`），保持统一视觉节奏；`.close-window:hover` 维持柔和暗红 hover 背景提示。
   - `#settings-panel` 保持简洁，仅保留「账号管理」和「自定义模型价格」。

---

## 4. 「限制 (Limits)」视图重构（对齐参考图 1、4）

涉及文件：[`src/renderer/components/LimitsView.tsx`](src/renderer/components/LimitsView.tsx)、[`src/renderer/limitsPresentation.ts`](src/renderer/limitsPresentation.ts)、[`src/shared/usageLimits.ts`](src/shared/usageLimits.ts)。

### 4.1 区块与卡片结构
- `.limits-view` 纵向间距 `gap: 32px`；每个提供方块 `.limits-provider` 内标题与卡片间距 `gap: 12px`。
- 提供方标题：`16px` `ProviderMark` + `14px` `font-weight: 500` 名称（如 `Codex`、`Antigravity`）。
- 窗口卡片 `.limit-window`：
  - `display: grid; grid-template-columns: 11rem minmax(0, 1fr); align-items: center; gap: 12px 24px; padding: 16px;`
  - `background: transparent;`、`border: 1px solid var(--color-card-border);`、`border-radius: 8px;`
  - 窄屏回退（`< 700px`）：单列上下排布。
- 左侧摘要列（`.limit-summary`）：
  - 窗口名（`14px`，`font-weight: 500`，`#f5f5f5`）。
  - 主指标行：`Math.round(pool.meanRemainingPercent)%`（`30px`，`font-weight: 600`，`tabular-nums`，`#f5f5f5`）+ `剩余`（`14px`，`#818181`）+ 趋势图标（`14px`，`#818181`：`ahead -> TrendingUp`，`on -> Gauge`，`under -> TrendingDown`）。
  - **多账号池恢复提示去重**：仅当 **`pool.accounts.length > 1 && showRecovery`** 时渲染 `↻ +${Math.round(next.recoveryPercent)}%`（`12px`，`font-weight: 500`，`#f5f5f5`）；**单账号池（如 Codex）禁止在左下角重复显示 `+XX%`**。

### 4.2 单行 `32px` 进度条、匀速进度竖线（Pace Tick）与右侧深色胶囊

- 账号列容器：`.limit-accounts` 使用等宽分栏 `grid-template-columns: repeat(${pool.accounts.length}, minmax(0, 1fr)); gap: 4px;`。
- 单个分段按钮 `.limit-segment`：
  - 固定单行高度：**`height: 32px; min-height: 32px;`**，`border-radius: 6px;`。
  - **移除常态内边框**（`box-shadow: none`），仅在 `[data-open="true"]` 或 `:hover` 时高亮 `1px` 微弱内描边 `inset 0 0 0 1px rgb(255 255 255 / 0.14)`，`:focus-visible` 绘制 2px 焦点环。
- **匀速进度竖线与 `clip-path` 透明切槽**：
  - 在 `LimitsView.tsx` 中为每个分段计算 `timeLeft`：
    若 `account.resetStatus === 'upcoming' && account.resetsAt && account.windowDurationMins && account.windowDurationMins > 0`：
    $$
    \text{timeLeft} = \text{clamp}\left(0,\; 100,\; \frac{\text{Date.parse}(account.resetsAt) - now}{account.windowDurationMins \times 60\_000} \times 100\right)
    $$
    否则为 `null`。
  - 借助 `ResizeObserver` 检查分段按钮宽度 `width >= 6`（避免极窄断点绘制出错）。当 `timeLeft !== null` 且宽度充足时：
    - `at = clamp(3px, ${timeLeft}%, calc(100% - 3px))`
    - `left = calc(${at} - 3px)`，`right = calc(${at} + 3px)`
    - 按钮轨道背景（不被 `clip-path` 裁切，保留 `:focus-visible` 焦点环）：
      ```ts
      {
        backgroundColor: 'transparent',
        backgroundImage: `linear-gradient(to right, var(--control) ${left}, transparent ${left}, transparent ${right}, var(--control) ${right})`
      }
      ```
      （无 `timeLeft` 时使用纯底色 `backgroundColor: var(--control)` `#111111`。）
    - 内部条带容器 `.limit-segment-track` 使用外扩 1px 的 `clip-path` 切出中间 6px 透明槽口，确保圆角抗锯齿不被破坏：
      ```ts
      {
        clipPath: `polygon(-1px -1px, ${left} -1px, ${left} calc(100% + 1px), ${right} calc(100% + 1px), ${right} -1px, calc(100% + 1px) -1px, calc(100% + 1px) calc(100% + 1px), -1px calc(100% + 1px))`
      }
      ```
    - 竖线节点 `<span aria-hidden="true" className="limit-pace-tick" style={{ left: at }} />`：
      `position: absolute; top: 2px; bottom: 2px; width: 2px; transform: translateX(-50%); border-radius: 999px; background: var(--color-ink); pointer-events: none;`（层级在填充条之上、前景文字与深色胶囊之下）。
- **填充条与右侧恢复斜纹**：
  - `.limit-fill`：`left: 0; width: ${remaining}%; border-radius: 6px; background: var(--limit-color); opacity: 0.35;`。
  - `.limit-refill`（当 `remaining < 100 && refill > 0`）：**贴右对齐 `right: 0`**（不要再从 `left: remaining%` 起），`width: ${Math.min(100 - remaining, refill)}%; opacity: 0.20;`，斜纹平铺采用全像素背景砖避免 45° 锯齿：
    ```css
    background-image: repeating-linear-gradient(135deg, transparent 0 1px, var(--limit-color) 1px 2px, transparent 2px 50%);
    background-size: 7px 7px;
    ```
- **单行前景排布（`.limit-segment-content`）**：
  - `position: relative; display: flex; align-items: center; gap: 6px; height: 100%; padding-inline: 8px; font-size: 12px; overflow: hidden;`
  - 设 `showAccountName = pool.accounts.length > 1`：
    - 当 `showAccountName === true`（多账号共享池）：渲染 `<span className="limit-account-name">{account.displayName}</span>`（`min-width: 0; truncate; font-weight: 500; color: #f5f5f5`）+ `<span className="shrink-0 font-semibold text-[#f5f5f5] tabular-nums">{Math.round(remaining)}%</span>`。
    - 当 `showAccountName === false`（单账号池，如 Codex）：**条内不渲染账号名和百分比**（消除与左列的重复文本）。
  - **右侧内嵌深色胶囊**（仅当存在倒计时、`credits` 或 `account.stale` 时渲染，`margin-inline-start: auto`）：
    - 样式：`display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 2px 6px; border-radius: 4px; background: rgb(0 0 0 / 0.85); color: #f5f5f5; font-size: 11px; line-height: 1.25; white-space: nowrap; font-variant-numeric: tabular-nums; overflow: hidden;`
    - **倒计时文案规范**（在 `limitsPresentation.ts` 新增 `resetBadgeDuration(value, now)`，单位与数字间加半角空格、去「后重置」、用「分钟」）：
      - 剩余 `<= 0`：`即将重置`
      - `days > 0`：`↻ ${days} 天 ${hours} 小时`（如 `↻ 4 天 15 小时`、`↻ 5 天 23 小时`）
      - `hours > 0`：`↻ ${hours} 小时 ${minutes} 分钟`（如 `↻ 3 小时 19 分钟`）
      - 否则：`↻ ${Math.max(1, minutes)} 分钟`（如 `↻ 2 分钟`）
    - **重置券**：仅 `provider === 'codex' && credits != null && credits > 0` 时渲染；若前有倒计时，渲染 `<span aria-hidden="true" className="text-[#818181]">·</span>`，接着 `<span className="inline-flex items-center gap-0.5 font-semibold"><Ticket size={12} />{credits}</span>`。
    - **缓存时钟标记**：若 `account.stale`，在胶囊内末尾渲染 `<Clock3 size={11} className="text-[#818181]" />`。

### 4.3 共享悬停 / 点击详情 Popover（对齐参考图 4）

参考 `references/屏幕截图 2026-11-24 105711.png` 替换当前每格独立写死的点击 Popover：
- **单一共享浮层 + 悬停预览**：全页仅挂载一个浮动详情层，支持鼠标悬停（`onPointerEnter` / `onPointerLeave`，悬停开启延迟 ~100ms、移开延迟 ~120ms，指针移入 Popover 本体不关闭）及点击 / 键盘聚焦切换；移动鼠标到相邻账号段时直接平滑切换内容与锚定坐标，不出现双气泡叠加。
- **定位与尺寸**：优先锚定在对应进度条上方居中（`side="top", gap=6px`），上方空间不足自动翻转到下方，左右夹紧视口边缘；`width: 288px (18rem); max-width: calc(100vw - 24px); padding: 12px 14px; border-radius: 10px; background: var(--color-popover); border: 1px solid #262626; box-shadow: 0 18px 44px rgb(0 0 0 / 0.85); font-size: 12px;`。
- **四段式内容分组**（组与组之间 `margin-top: 10px; padding-top: 10px; border-top: 1px solid #1f1f1f;`，键值两列 `grid-template-columns: 4.5rem minmax(0, 1fr); gap: 4px 12px;`）：
  1. **头部**：`<ProviderMark provider={provider} className="size-4" />` + `account.displayName`（`14px font-medium #f5f5f5`）。
  2. **账号元信息组**：
     - `套餐`（存在 `account.plan` 时）：显示对应套餐名称（Codex 映射为完整订阅名称如 `ChatGPT Plus Subscription`，详见 4.5 节）
     - `已登录` / `来源`：`原生` / `T3` / `手动`
  3. **额度详情组**：
     - `剩余`：`${formatLimitPercent(remaining)}`（建议整数或保留 1 位小数对齐主数字，如 `62%`）
     - `重置时间`（存在 `resetsAt` 时）：若为同一日历日展示 `HH:mm · 还需 ${duration}`（如 `14:16 · 还需 3 小时 19 分钟`），跨日展示 `M月D日 HH:mm · 还需 ${duration}`
     - `匀速进度`（存在 `timeLeft` 时）：`此时应剩余 ${Math.round(timeLeft)}%`
     - `恢复`（当该段下次重置对当前池恢复贡献 `segmentRecovery > 0` 时）：`+${Math.round(segmentRecovery)}%（按共享池总额度计算）`
     - `缓存数据`（`account.stale === true` 时）：上次更新时间戳
  4. **重置券组**（`provider === 'codex' && (account.resetCredits ?? 0) > 0` 时）：左侧显示 `已存 ${credits} 个 · ${expiresDuration}后过期`（无过期时间则显示 `已存 ${credits} 个`），右侧放置「使用重置」按钮；点击先关闭 Popover 再弹出二次确认弹窗（完整协议与状态流转详见 4.5 节）。

### 4.4 琥珀色异常警告框（对齐参考图 4）

- **位置**：当 `sections.length > 0`（界面上已有可见额度卡片）时，账号级异常框（`visibleIssues`）放置在提供商区块**下方**（与参考图 4 `Antigravity` 过期的 3 个账号提示位于 Codex 卡片下方一致）；当 `sections.length === 0` 时放置在页面顶部。
- **样式**：
  ```css
  .limit-warning-alert {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--warning-border);
    border-radius: 12px;
    background: var(--warning-surface);
    color: var(--warning-ink);
    font-size: 13px;
    line-height: 1.5;
  }
  ```
  - 左侧首行固定 `<TriangleAlert size={16} className="mt-0.5 shrink-0 text-[#fe9a00]" />`。
  - 中间为 `role="status"` 的 `<ul role="list">` 文案列表（沿用已有 `visibleLimitIssues` 与 `limitIssueText`，其中 `visibleLimitIssues` 需改为接收 `hiddenProviders: ReadonlySet<UsageProviderKind>` 进行多选过滤）。
  - 右侧保留「重试」按钮，采用深琥珀背景与边框适配警告框视觉。
  - 空态占位条件不变：仅 `sections.length === 0 && visibleIssues.length === 0 && !failed && !loading && !refreshing` 时展示 `暂无可用额度`。

### 4.5 Codex 套餐名称映射与重置券兑换全链路（对齐参考图 4 `105711.png`）

#### A. Codex 套餐名称映射（[`src/main/limits/probes/codex.ts`](src/main/limits/probes/codex.ts)）
新增 `codexPlanLabel(planType: string | undefined)` 将原始 `plan_type` / `planType` 映射为完整展示名称（对齐参考图 4 中的 `ChatGPT Plus Subscription`）：
- `'free'` -> `'ChatGPT Free Subscription'`
- `'go'` -> `'ChatGPT Go Subscription'`
- `'plus'` -> `'ChatGPT Plus Subscription'`
- `'pro'` -> `'ChatGPT Pro 200 Subscription'`
- `'prolite'` -> `'ChatGPT Pro 100 Subscription'`
- `'promax'` -> `'ChatGPT Pro 500 Subscription'`
- `'self_serve_business_prolite'` -> `'ChatGPT Business Premium Subscription'`
- `'team' | 'self_serve_business_usage_based' | 'business'` -> `'ChatGPT Business Subscription'`
- `'ent26' | 'enterprise_cbp_automation' | 'enterprise_cbp_usage_based' | 'enterprise'` -> `'ChatGPT Enterprise Subscription'`
- `'edu' | 'edu_plus' | 'edu_pro'` -> `'ChatGPT Edu Subscription'`
- `'unknown'` -> `'ChatGPT Subscription'`
- 其他非空字符串保留原值。

#### B. 重置券过期时间与 ID 采集（[`src/shared/limitsTypes.ts`](src/shared/limitsTypes.ts)、[`src/main/limits/probes/codex.ts`](src/main/limits/probes/codex.ts)、[`src/main/limits/limitsCache.ts`](src/main/limits/limitsCache.ts)、[`src/shared/usageLimits.ts`](src/shared/usageLimits.ts)、[`src/main/limits/service.ts`](src/main/limits/service.ts)）
1. 在 `LimitsProbeResult`（`kind: 'ok'` 分支）、`LimitAccountReading`、`PooledLimitAccount` 及 `limitsCache.ts` 持久化 Schema 中保留 `resetCredits?: number`，并新增可选字段：
   - `resetCreditsExpiresAt?: string`（最快过期的一张可用重置券 ISO 时间）
   - `nextResetCreditId?: string`（最快过期的一张可用重置券 ID）
2. 在 [`src/main/limits/probes/codex.ts`](src/main/limits/probes/codex.ts) 中采集详情：
   - HTTP `readCredits`（`GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`）：筛选 `credit?.reset_type === 'codex_rate_limits' && credit.status === 'available' && Date.parse(expires_at) > now` 的可用券，**按 `Date.parse(expires_at)` 升序排序**，提取：
     - `resetCredits: available.length`
     - `nextResetCreditId: text(available[0]?.id)`
     - `resetCreditsExpiresAt: iso(text(available[0]?.expires_at))`
   - CLI `fromCli`（`account/rateLimits/read` 返回的 `result.rateLimitResetCredits`）：筛选 `credit?.resetType === 'codexRateLimits' && credit.status === 'available' && (number(credit.expiresAt) ?? 0) > nowSec`，按 `expiresAt` 升序提取相同三项（`iso(credit.expiresAt * 1000)`）。
3. 在 `service.ts` 探测写入、`limitsCache.ts` 恢复与 `poolUsageLimits` 中完整透传 `resetCreditsExpiresAt` 与 `nextResetCreditId`。

#### C. 主进程重置券消耗服务与双通道协议（新增 `src/main/limits/codexResetCredit.ts` 或内聚于 `codex.ts` + `service.ts`）
1. **共享类型扩展（[`src/shared/limitsTypes.ts`](src/shared/limitsTypes.ts)）**：
   ```ts
   export type ConsumeResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

   export interface ConsumeResetCreditResult {
     outcome: ConsumeResetCreditOutcome
     report: LimitsReport
     warning?: string
   }
   ```
2. **防重放幂等键与单账号串行锁**：
   - 按规范化凭证目录/账号路径（`canonicalPath(account.credentialPaths?.[0] ?? account.dataDir ?? account.id)`）维护单账号 `concurrency = 1` 互斥锁与 `pendingIdempotencyKey: string | null`。
   - 首次发起消耗生成 `idempotencyKey = randomUUID()` 并保存至 `pendingIdempotencyKey`。
   - **关键防重复扣券机制**：若遇到网络超时、中断或临时 5xx 错误，**保留当前 `pendingIdempotencyKey`** 供下一次重试复用；只有收到明确的业务结果（`reset` / `nothingToReset` / `noCredit` / `alreadyRedeemed`）或确定的 4xx 失败时，才清空 `pendingIdempotencyKey`。
3. **双通道兑换实现（严格保持 `~/.t3` 只读）**：
   - **优先直连 HTTP 通道**（兼容 `native`、`t3`、`manual` 全部账号，仅只读读取 `auth.json`）：
     1. 从 `credentialCandidates(account)` 读取 `tokens.access_token` 及可选 `tokens.account_id ?? tokens.chatgpt_account_id`。
     2. 若未传入 `creditId`（或为稳妥确认当前最新券），先请求 `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` 取按过期时间升序第一张可用 `codex_rate_limits` 券 `id`（若为空数组直接返回 `'noCredit'`）。
     3. 发送 `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume`（`20_000 ms` 超时，`redirect: 'error'`）：
        - Headers：`Authorization: Bearer ${token}`、`Content-Type: application/json`、`OpenAI-Beta: codex-1`、`Originator: Codex Desktop`（及存在时的 `Chatgpt-Account-Id`）。
        - Body：`JSON.stringify({ redeem_request_id: idempotencyKey, credit_id: creditId })`。
        - 响应 `{ code: 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed' }` 映射为 `'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'`。
   - **安全 CLI 回退通道**（当无 OAuth token 或直连返回 HTTP `401` 时）：
     1. 检查 `safeCliHome(account)`：若账号属于 `t3` 或路径指向 `~/.t3`，**严禁拉起 CLI 进程**，直接返回友好错误 `'Codex 登录凭证已过期，请在 T3 Code 中重新登录后重试'`。
     2. 若为合法外部 `native` / `manual` 目录且通过 `resolveCli('codex')` 解析到原生 `codex.exe`，通过 `exchangeCli`（`20_000 ms` 超时，`cliEnvironment('CODEX_HOME', dataDir)`）发送：
        - `{ id: 1, method: 'initialize', params: { clientInfo: { name: 'usage-dashboard', version: APP_VERSION } } }`
        - 收到 `id: 1` 响应后发送 `{ method: 'initialized' }` 与 `{ id: 2, method: 'account/rateLimitResetCredit/consume', params: { idempotencyKey, ...(creditId ? { creditId } : {}) } }`
        - 校验并提取 `result.outcome`（`'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'`）。
4. **兑换后自动重刷确认（`LimitsService.consumeResetCredit(accountId)`）**：
   - 兑换前记录目标账号旧的 `checkedAt`（`beforeCheckedAt`）。
   - 当 `outcome === 'reset'` 时，立即执行 `refresh()`；若首次刷新因上游延迟未能拿到最新有效读数或仍为 `stale: true`，使用指数退避最多额外重试 3 次（间隔 `1s`、`2s`），确保进度条及时更新为 `100%` 且券数同步扣减；若 3 次重刷后仍无法确认最新读数，返回 `{ outcome, report, warning: '重置券已生效，但暂时无法确认最新额度，请稍后手动刷新。' }`。
5. **IPC 与 Preload 暴露（[`src/shared/ipc.ts`](src/shared/ipc.ts)、[`src/preload/index.ts`](src/preload/index.ts)、[`src/main/ipc.ts`](src/main/ipc.ts)）**：
   - `usageChannels` 新增 `consumeResetCredit: 'usage:consume-reset-credit'`。
   - `UsageApi` 新增 `consumeResetCredit(accountId: string): Promise<ConsumeResetCreditResult>`。
   - `src/main/ipc.ts` 校验 `ownWindow(event)` 与 `accountId` 非空字符串后调用 `limits.consumeResetCredit(accountId)`。

#### D. 前端 Popover 重置券行与二次确认弹窗（[`src/renderer/components/LimitsView.tsx`](src/renderer/components/LimitsView.tsx)、[`src/renderer/limitsPresentation.ts`](src/renderer/limitsPresentation.ts)）
1. **Popover 第 4 组布局（对齐参考图 `105711.png`）**：
   - 当 `provider === 'codex' && (account.resetCredits ?? 0) > 0` 时展示：
     - 左侧灰字（`#818181`，`tabular-nums`）：
       - 存在有效 `account.resetCreditsExpiresAt` 时：`已存 ${credits} 个 · ${expiresDuration}后过期`（例如 **`已存 2 个 · 7 天 19 小时后过期`**，复用带半角空格的 `X 天 X 小时` / `X 小时 X 分钟` 时长格式）。
       - 不存在过期时间时：`已存 ${credits} 个`。
     - 右侧按钮（`margin-inline-start: auto`）：紧凑描边按钮（`height: 26px; padding-inline: 10px; border-radius: 6px; border: 1px solid #2e2e32; background: #161618; color: #f5f5f5; font-size: 12px;`），常态文案 **`使用重置`**，兑换中禁用显示 `重置中…`。
2. **二次确认模态框（防误触，挂载在 Popover 外部同级节点）**：
   - 点击 Popover 中的「使用重置」按钮时：**先立即关闭当前 Popover**（避免浏览器 top-layer 弹窗叠加遮挡），再打开确认对话框（复用 `UsageDialog`）：
     - 标题：`使用重置券？`
     - 说明：`这将消耗「${account.displayName}」的 1 张重置券并立即清零当前限额窗口，操作不可撤销。`
     - 底部按钮：`取消`（描边按钮）+ `确认使用`（主操作按钮）。
   - 用户点击「确认使用」后，关闭确认框并调用 `window.usageApi.consumeResetCredit(account.id)`（完成后同步更新外层 `report` 状态，同时保持全局单账号并发互斥锁定）；在对应提供方区域下方渲染 `role="status"` 状态反馈文本：
     - `'reset'` -> 若存在 `warning` 则展示 `warning`，否则展示 `重置已生效，限额窗口已清零。`
     - `'nothingToReset'` -> `当前没有需要重置的限额窗口。`
     - `'noCredit'` -> `没有可用的重置券。`
     - `'alreadyRedeemed'` -> `该重置券已被使用。`
     - 失败异常 -> 显示明确中文或后端失败提示。

---

## 5. 「费用 / token」视图重构（对齐参考图 2、3、5）

### 5.1 货币 `US$` 格式统一（[`src/shared/usageFormat.ts`](src/shared/usageFormat.ts#L1-L12)）
- 将 `CURRENCY` 与图表 `usd` 格式化统一设为 `zh-CN` 区域下的 `currencyDisplay: 'symbol'`（默认导出 `US$` 前缀）：
  ```ts
  const CURRENCY = new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
  ```
  - 输出效果：`US$450.20`、`US$0.00`、`US$2,072.18`，与 6 张参考图完全吻合。

### 5.2 概览左侧摘要与文案对齐（[`src/renderer/components/CostTokenView.tsx`](src/renderer/components/CostTokenView.tsx)、[`src/renderer/components/TotalsStrip.tsx`](src/renderer/components/TotalsStrip.tsx)）
- 主数字下方副标题固定为 `${formatCount(sessions)} 个会话`（费用页追加 ` · API 估算`）。
- 当 `metric === 'cost' && values.unpricedRecords > 0 && !values.costUnknown` 时，不在副标题末尾拼接 `· 不含未定价用量`，而是渲染一个 `12px` `<Info size={12} />` 气泡按钮：悬停或聚焦时展示简洁提示「API 估算不含未定价记录（${formatPercent(unpricedShare)}）」。
- 提供方排行：
  - 每个提供方行名与金额均为 `14px`、`font-weight: 500`（`#f5f5f5`），会话数 `11px`（`#818181`）；下方副文案为 `占费用的 ${formatPercent(share)} · ${tokens} token` 或 `占 token 的 ${formatPercent(share)} · ${cost}`。
  - 左侧小圆点大小 `size-2 (8px)`，`ProviderMark` 大小 `size-4 (16px)`。
- 趋势图标题对齐：`每天费用` / `每天处理的 token`（`24h` 模式下为 `每小时费用` / `每小时处理的 token`）。
- `TotalsStrip` 保持 5 列，标题 `总计`（`14px` `font-weight: 500`），标签 `12px` `#818181`，数值 `16px` `font-weight: 500` `#f5f5f5`。

### 5.3 折线图毛玻璃 Tooltip 与坐标轴对齐（[`src/renderer/components/UsageProviderChart.tsx`](src/renderer/components/UsageProviderChart.tsx)）
1. **坐标轴格式**：
   - Y 轴美元格式器由 `notation: 'compact', currencyDisplay: 'narrowSymbol'` 改为常规 `currencyDisplay: 'symbol'`（带 `US$` 前缀、`minimumFractionDigits: 2`），刻度直接显示 `US$100.00`、`US$50.00`、`0`（参考图 3、5）；token 保持 `800M`、`600M`、`400M`、`200M`、`0`。
   - X 轴按天格式化采用 `month: 'short', day: 'numeric'`（或拼接 `${month}月${day}日`），稳定输出 `11月18日`、`11月21日`、`11月24日`。
   - Y 轴线色：`0` 基线 `rgb(255 255 255 / 0.14)`，其余网格线 `rgb(255 255 255 / 0.08)`。
2. **悬停交互与毛玻璃 Tooltip（对齐参考图 5）**：
   - 移除悬停时曲线节点上的 `.ud-usage-chart-point` 小圆点，仅绘制垂直参考线（`stroke="#818181"`，`strokeWidth={1}`，`vectorEffect="non-scaling-stroke"`）。
   - Tooltip 改为**随鼠标 `(localX, localY)` 动态定位**并自动向左侧/上方翻转以避免超出绘图区。
   - **毛玻璃卡片样式**：
     ```css
     .ud-usage-chart-tip {
       background: rgb(17 17 17 / 0.84);
       backdrop-filter: blur(16px) saturate(1.08);
       border: 1px solid rgb(255 255 255 / 0.10);
       border-radius: 12px;
       padding: 8px 10px;
       min-width: 152px;
       font-size: 12px;
       box-shadow: 0 12px 32px rgb(0 0 0 / 0.55);
     }
     ```
   - **行内容**：每行左侧将纯色圆点 `<i>` 替换为 **`<ProviderMark provider={id} className="size-3" />`（`12px` 品牌图标）** + 灰字名称，右侧亮白等宽数值；底部分隔线为 `1px solid #1f1f1f`，`总计` 行文字与数字保持克制 `font-weight: 500`（`#f5f5f5`）。

### 5.4 按类型统计分段胶囊条（[`src/renderer/components/UsageShareBar.tsx`](src/renderer/components/UsageShareBar.tsx)、[`src/renderer/usagePresentation.ts`](src/renderer/usagePresentation.ts)）
- 标题明确为：`按类型统计的费用` / `按类型统计的 token`（弹窗内沿用模型维度标题）。
- **费用分段补全**：在 [`src/renderer/usagePresentation.ts`](src/renderer/usagePresentation.ts#L80-L95) 中，为 `metric === 'cost'` 补齐 `{ label: '缓存写入', value: cost.cacheWrite, intensity: 72 }`（在「缓存读取」之后、「输出」之前），与 token 维度四类输入输出严格对应。
- **零值过滤**：`UsageShareBar` 的进度条与下方图例列表均仅渲染 `value > 0` 的 `visible` 分段，**不再显示 `US$0.00` 或 `0` 的空图例项**。
- **胶囊造型**：
  ```css
  .share-bar { display: flex; height: 8px; gap: 2px; background: transparent; }
  .share-bar span { min-width: 4px; height: 100%; border-radius: 2px; }
  .share-bar span:first-child { border-top-left-radius: 999px; border-bottom-left-radius: 999px; }
  .share-bar span:last-child { border-top-right-radius: 999px; border-bottom-right-radius: 999px; }
  ```
- 图例项仅包含 `8px × 8px` 色块（`border-radius: 2px`）、灰色标签名和亮白等宽数值（`font-weight: 400`）。

### 5.5 明细表增强（[`src/renderer/components/BreakdownTable.tsx`](src/renderer/components/BreakdownTable.tsx)）
- 接收 `query: UsageSummaryInput` 以判断当前是否处于小时粒度（`hourly = query.resolution === 'hour'`）：
  - 右上角切换器第二项在 `hourly === true` 时显示 `小时`，否则显示 `天`。
  - 时间明细表在 `hourly === true` 时按 `bucket.hourStart` 倒序聚合展示整点/时段（如 `10:00`），列头为 `小时`；按天模式下按 `bucket.day` 倒序展示（日期格式统一为 `11月24日`），列头为 `天`。
  - 时间明细表各提供方列后，合计费用列标题固定为 **`总计`**，末尾列为 `token`。
- 模型明细表首列表头 `#` 右侧直接为 `模型`，表格内容保持左侧 `ProviderMark`（`14px`）+ 模型名，下方 `2px` 细条保持 `max-width: 192px`，右侧三列为 `费用`、`占比`、`token`，行底分隔线改用更轻薄的 `var(--color-row-divider)`。

---

## 6. 涉及修改文件一览与验收清单

### 涉及文件清单

| 文件 | 变更内容 |
| :--- | :--- |
| [`src/shared/types.ts`](src/shared/types.ts) | 扩展 `uiPreferencesSchema`（新增 `hiddenProviders`） |
| [`src/shared/limitsTypes.ts`](src/shared/limitsTypes.ts) | 扩展 `resetCreditsExpiresAt`、`nextResetCreditId` 与 `ConsumeResetCreditResult` 类型 |
| [`src/shared/ipc.ts`](src/shared/ipc.ts) & [`src/preload/index.ts`](src/preload/index.ts) | 新增 `consumeResetCredit` IPC 通道与 `UsageApi.consumeResetCredit` 方法 |
| [`src/shared/usageLimits.ts`](src/shared/usageLimits.ts) | 透传 `resetCreditsExpiresAt` 与 `nextResetCreditId` 到 `PooledLimitAccount` |
| [`src/shared/usageFormat.ts`](src/shared/usageFormat.ts) | `formatUsd` 改为 `zh-CN` `USD`（输出 `US$` 前缀） |
| [`src/main/index.ts`](src/main/index.ts) & [`src/main/ipc.ts`](src/main/ipc.ts) | `BrowserWindow.backgroundColor` 改为 `'#000000'`；注册 `usage:consume-reset-credit` handler |
| [`src/main/limits/probes/codex.ts`](src/main/limits/probes/codex.ts) & `codexResetCredit.ts`（或同目录模块） | 实现 `codexPlanLabel`、重置券过期时间采集、防重放互斥锁、HTTP `/consume` 与非 T3 CLI 回退 |
| [`src/main/limits/limitsCache.ts`](src/main/limits/limitsCache.ts) & [`src/main/limits/service.ts`](src/main/limits/service.ts) | 缓存持久化 `resetCreditsExpiresAt` / `nextResetCreditId`；新增 `consumeResetCredit` 兑换与自动重刷确认 |
| [`src/renderer/styles/globals.css`](src/renderer/styles/globals.css) | 固定 `Source Han Serif SC VF` 衬线字体栈、`#000000` OLED 配色、无边框分段器、`1024px` 容器、`32px` 单行限制条、`limit-pace-tick`、毛玻璃浮层与琥珀色警告框 |
| [`src/renderer/main.tsx`](src/renderer/main.tsx) | 接管 `hiddenProviders` 多选过滤并传递重置券兑换动作 |
| [`src/renderer/usagePresentation.ts`](src/renderer/usagePresentation.ts) | 费用分段补齐 `缓存写入`，调整百分比/文案辅助函数 |
| [`src/renderer/limitsPresentation.ts`](src/renderer/limitsPresentation.ts) | 改造 `visibleLimitIssues` 适配多选 `hiddenProviders`；新增 `↻ X 小时 X 分钟` 与重置券过期时长格式化 |
| [`src/renderer/components/TopBar.tsx`](src/renderer/components/TopBar.tsx) | 修正面包屑主次颜色、原生 `<select>` 替换为多选提供方复选弹出菜单、精简窗口控制 |
| [`src/renderer/components/LimitsView.tsx`](src/renderer/components/LimitsView.tsx) | `32px` 单行条、单账号隐藏条内冗余信息、`clip-path` 切槽 + 匀速进度竖线、共享悬停 Popover、重置券使用按钮与二次确认弹窗、底部琥珀色警告框 |
| [`src/renderer/components/CostTokenView.tsx`](src/renderer/components/CostTokenView.tsx) | 对齐 `ⓘ` 未定价浮泡、副文案与图表标题文案 |
| [`src/renderer/components/TotalsStrip.tsx`](src/renderer/components/TotalsStrip.tsx) | 调整总计指标排版字号与字重（依赖 `globals.css` 与组件类配合） |
| [`src/renderer/components/UsageShareBar.tsx`](src/renderer/components/UsageShareBar.tsx) | 过滤 0 值分段与图例，支持首尾半圆胶囊与悬停占比气泡 |
| [`src/renderer/components/UsageProviderChart.tsx`](src/renderer/components/UsageProviderChart.tsx) | Y 轴 `US$` 完整刻度、X 轴 `11月18日` 格式、跟随鼠标毛玻璃 Tooltip + `ProviderMark` |
| [`src/renderer/components/BreakdownTable.tsx`](src/renderer/components/BreakdownTable.tsx) | `24h` 模式切换为「小时」明细聚合，统一 `天`/`小时` 与 `总计` 表头 |
| [`src/renderer/components/UsageModelDialog.tsx`](src/renderer/components/UsageModelDialog.tsx) | 同步 `UsageShareBar` 新属性与一致字体层级 |
| `tests/usageFormat.test.ts`、`tests/limitsPresentation.test.ts`、`tests/codexLimits.test.ts`、`tests/limitsService.test.ts` 等 | 更新 `US$` 前缀、多选过滤、`↻` 倒计时与 0 值过滤断言；补齐 `codexPlanLabel`、重置券过期解析、双通道 `/consume`、粘性幂等键复用、`~/.t3` CLI 禁止启动及兑换后自动重刷测试 |

### 验收清单
1. **静态与自动化检查**：
   - `pnpm typecheck`：0 错误。
   - `pnpm test`：全部单元测试通过（覆盖 `US$` 格式化、提供方多选过滤、`LimitsView` 单账号/多账号条与匀速进度计算、琥珀色异常栏、`UsageShareBar` 零值隐藏、24h 小时明细表，以及 Codex 套餐名称映射、重置券过期采集与防重复兑换全链路）。
   - `pnpm package:win`：Windows 安装版与便携版正常构建。
2. **视觉 1:1 复核**：
   - 保持 `references/` 与 `~/.t3` 不变，启动应用逐页核对「费用」「token」「限制」主界面、多选提供方菜单、限制条悬停 Popover（含 `已存 X 个 · X 后过期` 与「使用重置」确认流）、图表悬停毛玻璃 Tooltip 与参考图的一致性（单元测试全程使用 mock 验证兑换逻辑，切勿对真实账号发送真实兑换请求导致误扣券）。

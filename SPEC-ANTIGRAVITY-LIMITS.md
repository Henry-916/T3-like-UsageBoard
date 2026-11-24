# Antigravity 额度自动续期与异常可见性改造方案

## 1. 背景与问题根因

通过代码排查与本机真实凭据实测，当前 UsageDashboard 的「限制」标签页不显示 Antigravity 额度的根本原因如下：

1. **新版 CLI Token 无 OAuth Client 信息且仅 1 小时有效**
   - T3 Code 多账号模式及新版 `agy` 1.5.x 生成的凭证文件为 `antigravity-oauth-token`（位于 `~/.t3/userdata/providers/antigravity/<sha256(instanceId)>/antigravity-acp/`）。
   - 该文件内含 `token.access_token`、`token.refresh_token`、`token.expiry`，但**不包含** OAuth `client_id` / `client_secret`（区别于旧版 `acp_token.json`）。因此无法直接调用 `https://oauth2.googleapis.com/token` 进行 HTTP 刷新，每次仅依赖外部会话写回，有效期为 1 小时。
   - 当前 [`src/main/limits/probes/antigravity.ts`](src/main/limits/probes/antigravity.ts#L145-L148) 检测到 `Date.parse(token.expiry) <= now + 60_000` 后直接返回 `{ kind: 'failed' }`。
2. **缺少本地持久化缓存与失败反馈，导致冷启动静默消失**
   - [`src/main/limits/service.ts`](src/main/limits/service.ts#L92-L96) 仅在内存中保留历史读数 (`readings`)。程序重启冷启动时若某提供商首次探测全部失败，会直接执行 `readings.delete(id)`。
   - [`src/shared/limitsTypes.ts`](src/shared/limitsTypes.ts#L44-L48) 中的 `LimitsReport` 与 [`src/renderer/components/LimitsView.tsx`](src/renderer/components/LimitsView.tsx) 未承载单账号失败原因，致使前端仅渲染成功的 Codex 区块，Antigravity 完全静默消失。
3. **尚未解析本机 `agy` 可执行文件**
   - [`src/main/limits/probes/cli.ts`](src/main/limits/probes/cli.ts) 目前仅解析 `codex` 与 `claude`，尚未解析 Windows 默认安装的 `%LOCALAPPDATA%\agy\bin\agy.exe`、PATH 中的 `agy.exe` / `antigravity.exe` 或 T3 托管运行时。

### 本机实测验证结论（2026-11-24）

已在隔离临时目录中对本机过期凭证完成真实链路验证：
- 将 `~/.t3/.../antigravity-oauth-token` 复制到临时目录 `<tempDir>/antigravity-acp/`，配合 `{"auth":{"type":"oauth-personal"}}` 及隔离环境变量，拉起 `agy.exe acp --gemini-dir <tempDir> --app-data-dir antigravity-acp --disable-telemetry --include-default-customizations=false`。
- 通过 JSON-RPC 仅执行 **`initialize`（~0.3s） + `authenticate`（`{ "methodId": "oauth-personal" }`，~6s）**：
  - `agy` 静默刷新并将新的 `access_token` 与 `expiry` 写回临时目录中的 `antigravity-oauth-token`（无需调用 `session/new`，也不会拉起浏览器）。
  - 用刷新的 `access_token` 请求 `https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` 返回 HTTP `200`，成功获取全部额度桶（总耗时 ~8s）。
  - 源 `~/.t3` 文件的 `mtime` 完全不变。

---

## 2. 改造目标与硬性约束

### 目标
1. **后台静默自动续期**：在用户完全不打开 T3 Code 的情况下，借助本机 `agy` CLI 在隔离临时沙盒中自动续期 `antigravity-oauth-token`，并加密缓存新 token 以实现重启后 1 小时内零进程冷启动。
2. **重启冷启动立即可见**：持久化上次成功的额度读数到本地缓存（`limits-cache.json`），冷启动先渲染带缓存标识的历史读数，同时后台刷新并更新。
3. **单账号失败不再静默**：向前端透传账号级过期/异常状态（区分凭证彻底失效、缺少 `agy` CLI 与普通网络失败），配合一键重试。

### 硬性约束
- **严格只读 `~/.t3`**：绝对禁止修改或写回 `~/.t3` 目录下的任何文件（包括 `antigravity-oauth-token`、`settings.json` 等）。
- **零原生 C++ 插件**：继续使用 Node.js 内置模块与 Electron `safeStorage` 异步加密。
- **不打印任何敏感信息**：`access_token`、`refresh_token`、用户邮箱与凭证原文禁止出现在 `console.*`、错误消息或日志中。
- **Windows 子进程安全**：严禁使用 `shell: true`，严禁执行 `.cmd` / `.bat` / `.ps1` / pnpm shim；所有 `.exe` 必须先校验 `MZ`/`PE` 文件头。
- **后台无弹窗**：禁止在刷新过程中拉起浏览器；若 `agy` 返回需要人工交互登录（如 `-32000` 或输出登录链接），立即中止子进程并标记凭证失效。

---

## 3. 架构与模块改造清单

### 模块 1：`agy` CLI 路径解析（[`src/main/limits/probes/cli.ts`](src/main/limits/probes/cli.ts)）

保持现有 `resolveCli('codex' | 'claude')` 与 `resolveWindowsCli` 对 `~/.t3` 的隔离拒绝逻辑不变，在其基础上新增 `resolveAgyCli`（及导出 Windows 辅助解析函数便于单测）：

```ts
export interface ResolveAgyOptions {
  scanT3?: boolean
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
}

export async function resolveAgyCli(options?: ResolveAgyOptions): Promise<string | undefined>
```

#### 解析优先级
1. **Windows (`platform === 'win32'`)**
   - 扫描 `env.PATH` 各目录（**跳过** `PNPM_HOME` / `%LOCALAPPDATA%\pnpm` 等 pnpm shim 目录），依次检测 `agy.exe`、`antigravity.exe`。
   - 检测官方/常用原生安装路径：
     - `join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')`（若 `LOCALAPPDATA` 缺失则回退 `join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')`）
     - `join(home, '.local', 'bin', 'agy.exe')`
   - 以上外部路径沿用 `nativeWindowsExecutable`（校验 `realpath`、非 `~/.t3`、`MZ`/`PE` 头）。
   - 若以上均未找到且 **`scanT3 !== false`**：只读探测 T3 Code 托管的 Antigravity CLI 目录：
     - 根目录：`join(home, '.t3', 'userdata', 'tools', 'antigravity-acp', `win32-${arch}`)`
     - 读取 `active.json`，Zod 校验 `releaseId` 符合 `/^[a-f0-9]{64}$/`。
     - 读取 `join(versionsDir, releaseId, '.install-complete.json')`，校验：
       - `releaseId` 匹配；
       - `executable.name === 'agy.exe'` 且 `Number.isSafeInteger(executable.bytes) && executable.bytes > 0`；
       - `versionsDir`、`releaseDir`、`.install-complete.json` 与 `agy.exe` 均非符号链接（`lstat` 验证）；
       - `agy.exe` 文件大小等于 `executable.bytes` 且通过 `MZ`/`PE` 头校验（此处允许读取 `~/.t3/userdata/tools/antigravity-acp/...` 下的只读二进制，因为运行时的 `cwd`、`GEMINI_HOME` 与 `TEMP`/`TMP` 将被强制重定向至系统临时目录）。
2. **POSIX (`platform !== 'win32'`)**
   - 扫描 `env.PATH` 中的 `agy`、`antigravity`（校验 `access(..., constants.X_OK)` 且非 `~/.t3`）。
   - 检测 `join(home, '.local', 'bin', 'agy')`。
   - 若 `scanT3 !== false`，同样只读回退解析 `~/.t3/userdata/tools/antigravity-acp/${platform}-${arch}/active.json` 指向的 `antigravity` 可执行文件。

---

### 模块 2：Antigravity 加密 Token 缓存（新增 `src/main/limits/antigravityTokenCache.ts`）

用于持久化沙盒续期拿到的 `access_token`、`refresh_token` 与 `expiry`，避免重启后在 1 小时有效期内重复启动 `agy.exe`，同时在内存和磁盘上安全隔离多账号凭证。

#### 存储与加密
- 文件路径：`join(userData, 'antigravity-tokens.bin')`
- 复用 [`src/main/index.ts`](src/main/index.ts#L89-L93) 的 `safeStorage` `encrypt` / `decrypt` 回调，将整份 JSON 加密后以临时文件 + `rename` 原子写盘，并用模块/实例级串行写队列防止并发覆盖。
- 若未传入 `userData`、`encrypt`/`decrypt` 或系统 `safeStorage` 不可用，自动退化为进程内内存 `Map`，不得抛错阻塞探测。

#### 缓存键值设计
- 使用 `sha256` 对来源标识做键：
  - 若提供来源凭证路径：`cacheKey = sha256(`${pathKey(canonicalCredentialPath)}\0${sourceRefreshToken}`)`
  - 若无路径（如纯内存单测）：`cacheKey = sha256(`mem\0${sourceRefreshToken}`)`
- 注意：**把 `sourceRefreshToken` 包含在 Key 中**可以自动保证一旦用户在 T3 Code 或外部重新登录更换了账号/授权，旧缓存立即自然失效，不会张冠李戴。
- 缓存条目结构（Zod 校验）：
  ```ts
  export interface CachedAntigravityToken {
    accessToken: string
    refreshToken?: string // 保存续期后最新的 refresh_token，应对后续可能出现的 token 轮换
    expiry: string
    updatedAt: number
  }
  ```
- 接口建议：
  - `getValid(key: string, now?: number): Promise<CachedAntigravityToken | undefined>`：仅当 `Date.parse(entry.expiry) > now + 60_000` 时返回，否则不返回 `accessToken`（但可通过 `getEntry(key)` 取回上次轮换的 `refreshToken` 用于下次续期种子）。
  - `set(key: string, entry: CachedAntigravityToken): Promise<void>`：同时顺带清理超过 30 天未更新的陈旧条目。
  - `invalidate(key: string): Promise<void>`：发生 401 或彻底过期时清除该条目。

---

### 模块 3：沙盒 `agy acp` 自动续期与 Antigravity 探测重构（[`src/main/limits/probes/antigravity.ts`](src/main/limits/probes/antigravity.ts)）

#### 依赖注入与工厂化
- 新增工厂函数 `createAntigravityProbe(deps?: AntigravityProbeDeps)`，并继续导出默认 `probeAntigravity(account, ctx)` 以兼容既有直接调用与单元测试。
- `deps` 支持注入：
  - `tokenCache?: AntigravityTokenCache`
  - `getScanT3?: () => Promise<boolean>`（在 [`src/main/index.ts`](src/main/index.ts) 中读取 `configStore` 的 `scanT3`）
  - `resolveCli?: typeof resolveAgyCli`
  - `renewCliToken?: (params: CliRenewParams) => Promise<CliRenewOutcome>`（默认实现为下文沙盒 `agy acp` 调用，方便单测 mock 而不拉真实子进程）
  - `now?: () => number`

#### `cliToken` 解析 Schema 调整
当前 [`src/main/limits/probes/antigravity.ts`](src/main/limits/probes/antigravity.ts#L15) 为：
```ts
const cliToken = z.object({ token: z.object({ access_token: text, refresh_token: z.string().trim().optional(), expiry: text }) })
```
需增强兼容：
- 保留原对象的完整结构（或用 `.passthrough()` / 记录原始 `stored`），因为 `antigravity-oauth-token` 还包含顶层 `auth_method`、`id_token_email` 以及 `token.token_type`、`token.expires_in` 等字段，复制进沙盒时应尽量保持完整字段结构。
- `token.expiry` 允许为可选字符串（若缺失按已过期处理）。

#### 三级 Token 获取与续期状态机
当凭证匹配 `cliToken` 格式时：
1. **Tier 1 — 源文件未过期**：
   - `Date.parse(token.expiry ?? '') > now + 60_000` -> 直接使用 `token.access_token`。
2. **Tier 2 — 本地加密缓存命中**：
   - 源文件已过期，且 `token.refresh_token` 非空。
   - 查询 `tokenCache.getValid(cacheKey, now)`：若命中 -> 直接使用 `cached.accessToken`（不启动进程）。
3. **Tier 3 — 全局串行锁 + 沙盒 CLI 自动续期**：
   - 若无 `token.refresh_token` -> 无法续期，直接返回 `{ kind: 'failed', reason: 'expired' }`。
   - 进入模块/实例级**并发度 = 1 的串行互斥队列**：
     - （避免 3 个 Antigravity 账号同时刷新时并行解包 3 个 PyInstaller `agy.exe` 进程导致 Windows 卡顿与端口/临时目录争抢。）
     - **Double-Check**：拿到互斥锁后先检查 `ctx.signal.aborted`，并再查一次 `tokenCache.getValid(cacheKey, now())`，若已有有效缓存则直接返回。
     - 调用 `resolveCli({ scanT3 })`；若未找到 -> 返回 `{ kind: 'failed', reason: 'cli_missing' }`。
     - 执行沙盒续期（单次 CLI 调用独立设置 `25_000 ms` 内部超时，并与 `ctx.signal` 联动取消）：
       1. 创建隔离目录：
          - `tempDir = await mkdtemp(join(tmpdir(), 'usage-agy-'))`
          - `acpDir = join(tempDir, 'antigravity-acp')`
          - `workDir = join(tempDir, 'cwd')`
       2. 写入沙盒配置与凭证副本：
          - `join(acpDir, 'settings.json')`：`${JSON.stringify({ auth: { type: authMethod } })}\n`（其中 `authMethod` 取 `account.limitsEnv?.ANTIGRAVITY_AUTH_METHOD || storedAuthMethod || 'oauth-personal'`）。
          - `join(acpDir, 'antigravity-oauth-token')`：复制原始凭证 JSON，若缓存中存有更新后的 `refreshToken` 则覆盖 `token.refresh_token`，写入沙盒目录。
       3. 构造干净环境变量：
          - 白名单大小写无关保留基础系统变量与代理/TLS 变量：`PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `WINDIR`, `HOMEDRIVE`, `HOMEPATH`, `COMSPEC`, `PATHEXT`, `LANG`, `LC_ALL`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`。
          - 显式禁止透传宿主模型或浏览器变量：`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_*`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`, `DISPLAY`, `WAYLAND_DISPLAY`, `BROWSER`, `ELECTRON_RUN_AS_NODE`。
          - 强制隔离变量：
            - `GEMINI_HOME = tempDir`
            - `AGY_ACP_FORCE_FILE_STORAGE = '1'`
            - `AGY_CLI_DISABLE_AUTO_UPDATE = '1'`
            - `TEMP = tempDir`, `TMP = tempDir`, `TMPDIR = tempDir`
            - 当 `authMethod === 'oauth-personal'` 时设置 `SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0'`（触发 `agy` 非交互文件存储模式，杜绝弹浏览器）。
       4. 启动并执行 ACP JSON-RPC 最小握手：
          - 参数：`['acp', '--gemini-dir', tempDir, '--app-data-dir', 'antigravity-acp', '--disable-telemetry', '--include-default-customizations=false']`
          - 选项：`{ cwd: workDir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }`
          - 发送 Request `id: 1` `initialize`：
            ```json
            {
              "protocolVersion": 2,
              "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
              "clientInfo": { "name": "t3-code", "title": "UsageDashboard", "version": "0.1.0" }
            }
            ```
          - 收到 `id: 1` 响应后发送 Request `id: 2` `authenticate`：
            ```json
            { "methodId": authMethod }
            ```
          - 错误识别：若 `authenticate` 返回 JSON-RPC `error`（如 `code === -32000` 或错误信息包含 `No browser is available here` / `invalid_grant` / `revoked` / `sign-in required`），或 stdout/stderr 出现 `https://accounts.google.com/` 认证链接，判定凭证彻底失效，返回 `{ kind: 'expired' }`（并清除缓存）。
          - 成功返回 `id: 2` 后读取沙盒内 updated `antigravity-oauth-token`，校验新 `Date.parse(token.expiry) > Date.now() + 60_000`，写入 `tokenCache`（包括可能更新的 `refresh_token`），返回新 `accessToken`。
       5. **`finally` 彻底清理**：
          - 销毁 stdio 流，强制终止子进程（Windows 下若主进程已推出但 PyInstaller 子进程占用句柄，先 `child.kill()` 等待 `close`，再辅助尝试结束进程树）。
          - 使用 `rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })` 清理临时目录，防止沙盒内的明文 token 副本残留磁盘。

#### HTTP 401 自动失效重刷逻辑
- 在 `probeAntigravity` 的内部 `request()` 中区分 HTTP 状态码（如抛出携带 `status: response.status` 的错误，不将 response body 泄露到日志）。
- 仅在 `cliToken` 且存在 `refresh_token` 且本次请求尚未经过 CLI 续期时：若额度查询所有端点的请求均返回 HTTP `401`，使当前 `cacheKey` 失效并触发一次沙盒 CLI 续期；拿到新 `accessToken` 后重发一次额度查询；若仍失败则返回 `{ kind: 'failed', reason: 'expired' }`。

---

### 模块 4：额度缓存持久化 (`limits-cache.json`) 与超时适配（[`src/main/limits/service.ts`](src/main/limits/service.ts)）

1. **本地持久化读写（可选 `userData` 注入）**
   - `createLimitsService` 新增可选参数 `userData?: string`。在 [`src/main/index.ts`](src/main/index.ts) 中传入 `userData`（现有未传 `userData` 的单元测试保持纯内存行为）。
   - 缓存文件路径：`join(userData, 'limits-cache.json')`。
   - **冷启动恢复**：
     - 服务构造阶段（或首次就绪时）用 Zod 安全解析 `limits-cache.json`，将有效的 `{ id, identity, data }` 装入 `readings` Map，并强制将每条恢复记录设为 **`stale: true`**，随即构建初始 `report`（保证 IPC `limits.get()` 立即返回上次额度，界面立刻渲染带缓存时钟图标的数据，不再空白）。
   - **写盘与失效清理**：
     - 当 `run()` 完成且状态变化时，将当前有效 `readings` 原子写入 `limits-cache.json`（只保存非敏感的展示字段：`id`, `provider`, `displayName`, `origin`, `plan`, `windows`, `checkedAt`, `resetCredits`, `previous`, `identity`）。
     - 当账号在 `discover()` 或 `accountsChanged()` 中被移除/禁用时，同步从 `readings` 删除并异步回写清理后的 `limits-cache.json`。
2. **延长探测超时**
   - 将 `createLimitsService` 默认 `timeoutMs` 由 `15_000` 调整为 **`60_000`**（60 秒），确保 3～4 个 Antigravity 账号同时冷启动触发串行 CLI 续期（每个 ~6-8s）时，排队在后面的账号不会误触发外层超时（`timeoutMs` 仍支持由调用方或单元测试覆盖）。

---

### 模块 5：单账号异常/过期显式反馈（[`src/shared/limitsTypes.ts`](src/shared/limitsTypes.ts)、[`src/main/limits/service.ts`](src/main/limits/service.ts)、[`src/renderer/components/LimitsView.tsx`](src/renderer/components/LimitsView.tsx)）

1. **共享类型扩展（[`src/shared/limitsTypes.ts`](src/shared/limitsTypes.ts)）**
   ```ts
   export type LimitFailureReason = 'expired' | 'cli_missing' | 'failed'

   export type LimitsProbeResult = {
     kind: 'ok'
     windows: LimitWindow[]
     fingerprint?: string
     plan?: string
     resetCredits?: number
   } | { kind: 'unsupported' } | { kind: 'failed'; reason?: LimitFailureReason }

   export interface LimitAccountIssue {
     id: string
     provider: UsageProviderKind
     displayName: string
     origin: AccountOrigin
     reason: LimitFailureReason
     cached: boolean
   }

   export interface LimitsReport {
     accounts: LimitAccountReading[]
     issues?: LimitAccountIssue[]
     checkedAt: string | null
     refreshing: boolean
   }
   ```

2. **`LimitsService` 中的 Issue 汇总与去重（[`src/main/limits/service.ts`](src/main/limits/service.ts)）**
   - 维护当前周期的账号级问题状态 `issues = new Map<string, LimitAccountIssue>()`：
     - `result.kind === 'ok'` 或 `result.kind === 'unsupported'`：删除 `issues` 中该账号。
     - `result.kind === 'failed'`：记录 `issues.set(id, { id, provider, displayName, origin, reason: result.reason ?? 'failed', cached: Boolean(prev) })`。
   - **去重保护（关键）**：同一真实 Google 账号可能同时被 `native` 和 `t3`（或 `manual`）发现。发布 `report.issues` 时，如果某个 `issue` 对应的同提供商、同名或已知同 `identity` 通道在当前刷新周期已经拿到最新 `stale: false` 数据（例如历史记录绑定过同一 `identity`），应过滤掉已被其他通道成功读取的冗余报错。
   - `accountsChanged` 移除或禁用账号时，同步从 `issues` 中剔除。
   - 若因整个 `run()` 捕获意外异常而进入 `catch`，按现有逻辑标记全部既有 `readings` 为 `stale: true`。

3. **前端渲染（[`src/renderer/components/LimitsView.tsx`](src/renderer/components/LimitsView.tsx)、[`src/renderer/limitsPresentation.ts`](src/renderer/limitsPresentation.ts)）**
   - 在 `limitsPresentation.ts` 增加 `visibleLimitIssues(issues, provider)` 与 `limitIssueText(issue)` 辅助函数：
     - 过滤规则：`provider === 'all'` 返回全部 `issues`，否则返回 `issue.provider === provider`。
     - 文案保持克制简洁，不堆叠冗余标签：
       - `expired` -> `「${issue.displayName}」登录凭证已过期，请在 ${providerLabel} 中重新登录后重试`
       - `cli_missing` -> `「${issue.displayName}」登录凭证已过期，未找到可用的 agy CLI`
       - `failed` -> `「${issue.displayName}」${issue.cached ? '刷新失败，当前显示缓存数据' : '无法读取额度'}`
   - 在 [`LimitsView.tsx`](src/renderer/components/LimitsView.tsx) 中：
     - 若存在 `visibleIssues` 且未展示全量 IPC `failed` 提示，在页面顶部渲染简洁的 `.inline-notice` 列表与单个「重试」按钮。
     - 调整空态占位条件：仅当 `sections.length === 0 && visibleIssues.length === 0 && !failed` 时才显示 `暂无可用额度`，避免同时出现报错提示和「暂无可用额度」。

---

## 4. 涉及修改与新增文件一览

| 文件 | 变更类型 | 职责 |
| :--- | :--- | :--- |
| [`src/shared/limitsTypes.ts`](src/shared/limitsTypes.ts) | 修改 | 扩展 `LimitsProbeResult.reason`、`LimitAccountIssue` 与 `LimitsReport.issues` |
| `src/main/limits/antigravityTokenCache.ts` | 新增 | 基于 `safeStorage` 加密的 `antigravity-tokens.bin` 缓存与原子持久化 |
| [`src/main/limits/probes/cli.ts`](src/main/limits/probes/cli.ts) | 修改 | 新增 `resolveAgyCli`（PATH、`%LOCALAPPDATA%\agy\bin\agy.exe`、只读 T3 `active.json` 回退） |
| [`src/main/limits/probes/antigravity.ts`](src/main/limits/probes/antigravity.ts) | 修改 | 实现 `createAntigravityProbe`、加密缓存查重、全局串行锁、沙盒 `agy acp` 续期及 401 重试 |
| [`src/main/limits/service.ts`](src/main/limits/service.ts) | 修改 | 增加 `limits-cache.json` 冷启动恢复与清理、`issues` 汇总、`timeoutMs` 调整为 `60_000` |
| [`src/main/index.ts`](src/main/index.ts) | 修改 | 装配 `antigravityTokenCache`、`createAntigravityProbe` 与持久化 `createLimitsService` |
| [`src/renderer/limitsPresentation.ts`](src/renderer/limitsPresentation.ts) | 修改 | 新增 `visibleLimitIssues` 与 `limitIssueText` 格式化 |
| [`src/renderer/components/LimitsView.tsx`](src/renderer/components/LimitsView.tsx) | 修改 | 展示账号级过期/失败提示与重试按钮，修正空态条件 |
| [`tests/cliResolution.test.ts`](tests/cliResolution.test.ts) | 修改 | 补充 `resolveAgyCli` 各类路径与安全边界测试 |
| `tests/antigravityTokenCache.test.ts` | 新增 | 覆盖 token 缓存加密读写、降级与 key 隔离 |
| [`tests/antigravityLimits.test.ts`](tests/antigravityLimits.test.ts) | 修改 | 更新过期返回值断言，补齐缓存命中、沙盒续期、串行锁、`-32000` 失效与 401 重试测试 |
| [`tests/limitsService.test.ts`](tests/limitsService.test.ts) | 修改 | 覆盖 `limits-cache.json` 冷启动恢复、账号禁用清理与 `issues` 报告生成 |

---

## 5. 测试与验收清单

1. **自动化验证**：
   - `pnpm typecheck` 通过（0 错误）。
   - `pnpm test` 全部通过（包括上述新增与修改后的单元测试）。
   - `pnpm package:win` 重新打包生成 NSIS 安装版与便携版无报错。
2. **本机真实环境验证**：
   - 使用当前过期的 3 个 `~/.t3` Antigravity 账号（**不启动 T3 Code、不手动刷新**）启动应用并切到「限制」页：
     - 确认不弹窗打开浏览器；
     - 确认 Antigravity 区块正常出现，3 个账号进度条与重置倒计时正常展示；
     - 检查 `%TEMP%` 无残留 `usage-agy-*` 目录；
     - 检查 `~/.t3/userdata/providers/antigravity/` 下各 `antigravity-oauth-token` 文件 `mtime` 未发生任何变化；
     - 关闭并重启软件，在刷新完成前「限制」页能立即可见带缓存标记的上次额度，随后自动更新为最新读数。

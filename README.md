# T3-like UsageBoard

独立的 Windows 桌面用量看板，读取本机 Antigravity、OpenCode、Codex 和 Claude Code 的用量历史。
界面与用量解析改编自 MIT 协议的 [T3 Code](https://github.com/pingdotgg/t3code)；本项目不是官方发行版。

## 开发

```powershell
pnpm install
pnpm dev
```

关闭按钮会把窗口隐藏到托盘。单击托盘图标打开额度小面板；右键菜单可显示主面板或退出。

快捷键：`C` / `T` / `L` 切页，`Ctrl+Shift+1` 至 `4` 切时间范围，`R` 刷新，`Esc` 关闭弹层或隐藏窗口。右键托盘可开启「开机自启」，下次登录 Windows 时应用会在托盘启动。

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## Windows 打包

```powershell
pnpm package:win
```

`dist/` 中的 `*-setup-x64.exe` 是安装包，`*-portable-x64.exe` 可直接运行。两个版本都是未签名的 Windows x64 构建。

旧用户升级前先从托盘退出 Usage Dashboard。新版首次启动会把旧配置和加密相关的 `Local State` 复制到 `%APPDATA%\t3-like-usageboard`，保留旧目录。

维护本工作区和会话索引时，可先运行 `python -B scripts/ops/rename-workspace.py -DryRun`（需要 Python 3.12+）。正式改名仅在发版后手动执行：把脚本复制到工作区外，退出 Antigravity、OpenChamber 和 OpenCode，再在工作区外运行脚本副本，不带 `-DryRun`。会保留数据库备份和旧路径联接。

## 实时额度

额度需要提供方的有效本机登录或订阅。Antigravity 可通过已安装的 `agy` 自动续期，无法续期时才需要重新登录。手动导入的凭证用 Windows 本机加密存储；不会写回 T3 目录。Codex 重置券可从额度详情使用，确认后消耗一张，无法撤销。

## 本机扫描验证

按需运行以下命令验证本机过去 90 天的数据。它使用临时应用缓存，不修改数据源设置；输出是包含模型用量与费用的聚合 JSON，不含日志正文或凭证。

```powershell
$env:USAGE_SMOKE_SUMMARY = Join-Path $env:TEMP 'usage-summary.json'
pnpm exec vitest run tests/usageService.test.ts
Remove-Item Env:USAGE_SMOKE_SUMMARY
```

许可见 [LICENSE](LICENSE) 和 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。当前架构与规范索引见 [docs/CURRENT.md](docs/CURRENT.md)，历次迭代工单归档于 `docs/specs/`。

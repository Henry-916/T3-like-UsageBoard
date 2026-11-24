# UsageDashboard

独立的 Windows 桌面用量看板，读取本机 Antigravity、OpenCode、Codex 和 Claude Code 的用量历史。

## 开发

```powershell
pnpm install
pnpm dev
```

关闭按钮会把窗口隐藏到托盘。单击托盘图标切换显隐；要结束进程，请使用托盘右键菜单的「退出」。

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

## 实时额度

额度需要提供方的有效本机登录或订阅。Antigravity 可通过已安装的 `agy` 自动续期，无法续期时才需要重新登录。手动导入的凭证用 Windows 本机加密存储；不会写回 T3 目录。Codex 重置券可从额度详情使用，确认后消耗一张，无法撤销。

## 本机扫描验证

按需运行以下命令验证本机过去 90 天的数据。它使用临时应用缓存，不修改数据源设置；输出是包含模型用量与费用的聚合 JSON，不含日志正文或凭证。

```powershell
$env:USAGE_SMOKE_SUMMARY = Join-Path $env:TEMP 'usage-summary.json'
pnpm exec vitest run tests/usageService.test.ts
Remove-Item Env:USAGE_SMOKE_SUMMARY
```

许可见 [LICENSE](LICENSE) 和 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。完整开发范围见 [SPEC.md](SPEC.md)。

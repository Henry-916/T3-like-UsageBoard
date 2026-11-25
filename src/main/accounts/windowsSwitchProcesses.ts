import { execFile, spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { resolveCli } from '../limits/probes/cli'

interface WindowsProcess {
  ProcessId: number
  Name: string
  ExecutablePath?: string
  CommandLine?: string
}

export interface WindowsSwitchProcessRunner {
  env: NodeJS.ProcessEnv
  query(): Promise<WindowsProcess[]>
  killTree(pid: number): Promise<void>
  killProcess(pid: number): Promise<void>
  resolveCodex(): Promise<string | undefined>
  stopCodexDaemon(executable: string): Promise<void>
  findCodexAppId(): Promise<string | undefined>
  launch(executable: string, args: string[]): Promise<void>
  waitForRestartPoll?(): Promise<void>
}

const codexAppId = /^OpenAI\.Codex[\w.]*!App$/i
const fallbackCodexAppId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
const run = promisify(execFile)
const system = (executable: string) => win32.join(process.env.SystemRoot ?? 'C:\\Windows', executable)

async function powershell(script: string): Promise<string> {
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`
  const { stdout } = await run(system('System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15_000 })
  return stdout.trim()
}

const windowsRunner: WindowsSwitchProcessRunner = {
  env: process.env,
  async query() {
    const result = await powershell(`$p = Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe' OR Name='ChatGPT.exe' OR Name='codex.exe' OR Name='node.exe'" | Select-Object ProcessId,Name,ExecutablePath,CommandLine; ConvertTo-Json -InputObject @($p) -Compress`)
    return (JSON.parse(result) as WindowsProcess[]).filter(Boolean)
  },
  async killTree(pid) {
    await run(system('System32\\taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
  },
  async killProcess(pid) {
    await run(system('System32\\taskkill.exe'), ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 10_000 })
  },
  resolveCodex: () => resolveCli('codex'),
  async stopCodexDaemon(executable) {
    await run(executable, ['app-server', 'daemon', 'stop'], { windowsHide: true, timeout: 5_000 })
  },
  async findCodexAppId() {
    return await powershell("(Get-StartApps | Where-Object AppID -like 'OpenAI.Codex*!App' | Select-Object -First 1).AppID") || undefined
  },
  async launch(executable, args) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  },
  waitForRestartPoll: () => sleep(750)
}

function normalized(path: string | undefined): string {
  return path && /^[a-z]:[\\/]/i.test(path) ? win32.normalize(path).toLowerCase() : ''
}

function isPackagedCodex(process: WindowsProcess): boolean {
  return process.Name.toLowerCase() === 'chatgpt.exe'
    && /^[a-z]:\\(?:program files\\)?windowsapps\\openai\.codex_[^\\]+\\app\\chatgpt\.exe$/.test(normalized(process.ExecutablePath))
}

function isStandaloneCodex(process: WindowsProcess, env: NodeJS.ProcessEnv): boolean {
  if (process.Name.toLowerCase() !== 'codex.exe') return false
  const roots = [env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']]
  const executable = normalized(process.ExecutablePath)
  return !!executable && roots.some(root => root && executable === normalized(win32.join(root, 'Codex', 'Codex.exe')))
}

function isCodexServer(process: WindowsProcess, cli: string | undefined, env: NodeJS.ProcessEnv): boolean {
  const executable = normalized(process.ExecutablePath)
  if (!executable || win32.basename(executable) !== process.Name.toLowerCase()) return false
  // Test positional arguments, not substrings (e.g. 'codex exec "debug app-server"').
  const args = (process.CommandLine?.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map(arg => arg.replace(/^"|"$/g, ''))
  if (process.Name.toLowerCase() === 'node.exe') {
    const nodeRoots = [env.ProgramFiles && win32.join(env.ProgramFiles, 'nodejs'),
      env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'nodejs'),
      ...(env.PATH ?? env.Path ?? '').split(';').map(path => path.replace(/^"|"$/g, ''))]
    if (!nodeRoots.some(root => root && normalized(root) && normalized(win32.join(root, 'node.exe')) === executable)) return false
    if (!/\\node_modules\\@openai\\codex\\bin\\codex\.js$/.test(normalized(args[1]))) return false
    args.shift()
  } else if (process.Name.toLowerCase() !== 'codex.exe') {
    return false
  } else if (executable !== normalized(cli)
    && !/^[a-z]:\\(?:program files\\)?windowsapps\\openai\.codex_[^\\]+\\app\\resources\\codex\.exe$/.test(executable)
    && !/\\node_modules\\@openai\\codex-win32-(?:x64|arm64)\\vendor\\[^\\]+\\(?:bin|codex)\\codex\.exe$/.test(executable)) {
    return false
  }
  let index = 1
  while (/^(?:-c|--config|--enable|--disable)(?:=|$)/.test(args[index] ?? '')) {
    index += args[index].includes('=') ? 1 : 2
  }
  return args[index] === 'app-server' && !(args[index + 1] === 'daemon' && args[index + 2] === 'stop')
}

async function stop(runner: WindowsSwitchProcessRunner, item: WindowsProcess, tree: boolean): Promise<void> {
  try {
    if (tree) await runner.killTree(item.ProcessId)
    else await runner.killProcess(item.ProcessId)
  } catch {
    // The process can disappear between the WMI snapshot and taskkill.
    if ((await runner.query()).some(p => p.ProcessId === item.ProcessId && p.Name === item.Name
      && p.ExecutablePath === item.ExecutablePath)) throw new Error('无法停止需切换账号的进程')
  }
}

async function verifyRelaunch(runner: WindowsSwitchProcessRunner, matches: (item: WindowsProcess) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await runner.waitForRestartPoll?.()
    if ((await runner.query()).some(matches)) return
  }
  throw new Error('未检测到应用重启')
}

export async function stopCodexForSwitch(runner = windowsRunner): Promise<() => Promise<void>> {
  if (runner === windowsRunner && process.platform !== 'win32') throw new Error('仅 Windows 支持切换 Codex 桌面账号')
  const stopped: WindowsProcess[] = []
  async function restart(): Promise<void> {
    try {
      const packaged = stopped.find(isPackagedCodex)
      if (packaged) {
        const found = await runner.findCodexAppId().catch(() => undefined)
        await runner.launch(system('explorer.exe'), [`shell:AppsFolder\\${found && codexAppId.test(found) ? found : fallbackCodexAppId}`])
        await verifyRelaunch(runner, p => isPackagedCodex(p) && !stopped.some(old => old.ProcessId === p.ProcessId))
      }
      const standalone = stopped.find(p => isStandaloneCodex(p, runner.env))
      if (standalone?.ExecutablePath) {
        await runner.launch(standalone.ExecutablePath, [])
        await verifyRelaunch(runner, p => isStandaloneCodex(p, runner.env)
          && normalized(p.ExecutablePath) === normalized(standalone.ExecutablePath)
          && !stopped.some(old => old.ProcessId === p.ProcessId))
      }
    } catch {
      throw new Error('无法重启 Codex 桌面版')
    }
  }
  try {
    const desktops = (await runner.query()).filter(p => isPackagedCodex(p) || isStandaloneCodex(p, runner.env))
    for (const desktop of desktops) {
      await stop(runner, desktop, true)
      stopped.push(desktop)
    }
    const cli = await runner.resolveCodex()
    if (cli) await runner.stopCodexDaemon(cli).catch(() => {}) // No running daemon is expected to return nonzero.
    for (const server of (await runner.query()).filter(p => isCodexServer(p, cli, runner.env))) await stop(runner, server, false)
    return restart
  } catch {
    await restart().catch(() => {})
    throw new Error('无法停止 Codex 桌面版或 app-server')
  }
}

export async function stopAntigravityForSwitch(runner = windowsRunner): Promise<() => Promise<void>> {
  if (runner === windowsRunner && process.platform !== 'win32') throw new Error('仅 Windows 支持切换 Antigravity 桌面账号')
  const root = runner.env.LOCALAPPDATA
  const executable = root && win32.join(root, 'Programs', 'antigravity', 'Antigravity.exe')
  if (!executable || !normalized(executable)) throw new Error('无法定位 Antigravity App 安装路径')
  const matches = (p: WindowsProcess) => p.Name.toLowerCase() === 'antigravity.exe'
    && normalized(p.ExecutablePath) === normalized(executable)
  const stopped = new Set<number>()
  const restart = async (): Promise<void> => {
    if (!stopped.size) return
    try {
      await runner.launch(executable, [])
      await verifyRelaunch(runner, p => matches(p) && !stopped.has(p.ProcessId))
    } catch {
      throw new Error('无法重启 Antigravity App')
    }
  }
  try {
    for (const app of (await runner.query()).filter(matches)) {
      await stop(runner, app, true)
      stopped.add(app.ProcessId)
    }
    return restart
  } catch {
    await restart().catch(() => {})
    throw new Error('无法停止 Antigravity App')
  }
}

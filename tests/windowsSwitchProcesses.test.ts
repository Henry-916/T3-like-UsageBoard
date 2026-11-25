import { describe, expect, it, vi } from 'vitest'
import { stopAntigravityForSwitch, stopCodexForSwitch, type WindowsSwitchProcessRunner } from '../src/main/accounts/windowsSwitchProcesses'

type ProcessList = Awaited<ReturnType<WindowsSwitchProcessRunner['query']>>
const local = 'C:\\Users\\fixture\\AppData\\Local'
const packaged = { ProcessId: 1, Name: 'ChatGPT.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\app\\ChatGPT.exe' }
const cliPath = 'C:\\cli\\codex.exe'
const nodePath = 'C:\\Program Files\\nodejs\\node.exe'

function fake(...snapshots: ProcessList[]) {
  return {
    env: { LOCALAPPDATA: local, ProgramFiles: 'C:\\Program Files' },
    query: vi.fn(async () => snapshots.shift() ?? []),
    killTree: vi.fn(async (_pid: number) => {}),
    killProcess: vi.fn(async (_pid: number) => {}),
    resolveCodex: vi.fn(async () => cliPath),
    stopCodexDaemon: vi.fn(async (_executable: string) => {}),
    findCodexAppId: vi.fn(async () => 'OpenAI.CodexFixture_abc!App'),
    launch: vi.fn(async (_executable: string, _args: string[]) => {}),
    waitForRestartPoll: vi.fn(async () => {})
  }
}

describe('Windows switch process control', () => {
  it('stops only the exact Antigravity App tree, then relaunches it', async () => {
    const executable = `${local}\\Programs\\antigravity\\Antigravity.exe`
    const runner = fake([
      { ProcessId: 1, Name: 'ANTIGRAVITY.EXE', ExecutablePath: executable.toUpperCase() },
      { ProcessId: 2, Name: 'Antigravity.exe', ExecutablePath: `${local}\\Programs\\Antigravity IDE\\Antigravity.exe` },
      { ProcessId: 3, Name: 'agy.exe', CommandLine: 'agy.exe --hub' }
    ], [], [{ ProcessId: 4, Name: 'Antigravity.exe', ExecutablePath: executable }])
    const restart = await stopAntigravityForSwitch(runner)
    expect(runner.killTree.mock.calls).toEqual([[1]])
    expect(runner.launch).not.toHaveBeenCalled()
    await restart()
    expect(runner.launch).toHaveBeenCalledExactlyOnceWith(executable, [])
    expect(runner.waitForRestartPoll).toHaveBeenCalledTimes(1)
  })

  it('does not launch Antigravity App when it was not running', async () => {
    const runner = fake()
    await (await stopAntigravityForSwitch(runner))()
    expect(runner.killTree).not.toHaveBeenCalled()
    expect(runner.launch).not.toHaveBeenCalled()
  })

  it('stops Codex MSIX and actual app servers, not CLI sessions or unrelated Node', async () => {
    const runner = fake([
      packaged,
      { ProcessId: 2, Name: 'ChatGPT.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0\\app\\ChatGPT.exe' }
    ], [
      { ProcessId: 3, Name: 'codex.exe', ExecutablePath: cliPath, CommandLine: `${cliPath} app-server --listen stdio://` },
      { ProcessId: 4, Name: 'node.exe', ExecutablePath: nodePath, CommandLine: 'node.exe "C:\\Program Files\\node_modules\\@openai\\codex\\bin\\codex.js" app-server' },
      { ProcessId: 5, Name: 'codex.exe', ExecutablePath: cliPath, CommandLine: 'codex.exe exec "check app-server"' },
      { ProcessId: 6, Name: 'codex.exe', ExecutablePath: cliPath, CommandLine: 'codex.exe app-server daemon stop' },
      { ProcessId: 7, Name: 'node.exe', ExecutablePath: nodePath, CommandLine: 'node.exe unrelated.js app-server' },
      { ProcessId: 8, Name: 'codex.exe', ExecutablePath: cliPath, CommandLine: 'codex.exe app-server-custom' },
      { ProcessId: 9, Name: 'codex.exe', ExecutablePath: cliPath, CommandLine: 'codex.exe -c cli_auth_credentials_store="file" app-server' },
      { ProcessId: 10, Name: 'codex.exe', CommandLine: 'codex.exe app-server' },
      { ProcessId: 11, Name: 'codex.exe', ExecutablePath: 'C:\\unrecognized\\codex.exe', CommandLine: 'codex.exe app-server' },
      { ProcessId: 13, Name: 'node.exe', ExecutablePath: 'C:\\unrecognized\\node.exe', CommandLine: 'node.exe "C:\\Program Files\\node_modules\\@openai\\codex\\bin\\codex.js" app-server' }
    ], [{ ...packaged, ProcessId: 12 }])
    runner.stopCodexDaemon.mockRejectedValueOnce(new Error('not running'))
    const restart = await stopCodexForSwitch(runner)
    expect(runner.killTree.mock.calls).toEqual([[1]])
    expect(runner.killProcess.mock.calls).toEqual([[3], [4], [9]])
    expect(runner.stopCodexDaemon).toHaveBeenCalledExactlyOnceWith('C:\\cli\\codex.exe')
    expect(runner.killTree.mock.invocationCallOrder[0]).toBeLessThan(runner.stopCodexDaemon.mock.invocationCallOrder[0])
    expect(runner.stopCodexDaemon.mock.invocationCallOrder[0]).toBeLessThan(runner.query.mock.invocationCallOrder[1])
    await restart()
    expect(runner.launch).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\\explorer\.exe$/i), ['shell:AppsFolder\\OpenAI.CodexFixture_abc!App'])
  })

  it('relaunches standalone Codex by its verified path', async () => {
    const executable = `${local}\\Programs\\Codex\\Codex.exe`
    const desktop = { ProcessId: 1, Name: 'Codex.exe', ExecutablePath: executable }
    const runner = fake([desktop], [], [{ ...desktop, ProcessId: 2 }])
    await (await stopCodexForSwitch(runner))()
    expect(runner.killTree.mock.calls).toEqual([[1]])
    expect(runner.launch).toHaveBeenCalledExactlyOnceWith(executable, [])
  })

  it('does not treat explorer launch or the original PID as a verified restart', async () => {
    const runner = fake([packaged], [], [packaged], [{ ...packaged, ProcessId: 2, ExecutablePath: undefined }])
    const restart = await stopCodexForSwitch(runner)
    await expect(restart()).rejects.toThrow('无法重启 Codex 桌面版')
    expect(runner.launch).toHaveBeenCalledTimes(1)
    expect(runner.waitForRestartPoll).toHaveBeenCalledTimes(7)
  })

  it('restarts the original desktop if stopping fails after the desktop was stopped', async () => {
    const runner = fake()
    runner.query.mockResolvedValueOnce([packaged])
      .mockRejectedValueOnce(new Error('private process data'))
      .mockResolvedValueOnce([{ ...packaged, ProcessId: 2 }])
    await expect(stopCodexForSwitch(runner)).rejects.toThrow(/^无法停止 Codex 桌面版或 app-server$/)
    expect(runner.killTree).toHaveBeenCalledExactlyOnceWith(1)
    expect(runner.launch).toHaveBeenCalledTimes(1)
    expect(runner.query).toHaveBeenCalledTimes(3)
  })
})

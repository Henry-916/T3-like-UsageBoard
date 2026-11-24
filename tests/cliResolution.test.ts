import { mkdir, mkdtemp, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWindowsCli } from '../src/main/limits/probes/cli'

describe('Windows CLI resolution', () => {
  let root: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cli-resolution-'))
    env = { USERPROFILE: join(root, 'profile'), APPDATA: join(root, 'appdata') }
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function write(path: string, content: Buffer | string) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return realpath(path)
  }

  async function executable(...parts: string[]) {
    const pe = Buffer.alloc(68)
    pe.write('MZ')
    pe.writeUInt32LE(64, 60)
    pe.writeUInt32LE(0x4550, 64)
    return write(join(...parts), pe)
  }

  async function link(target: string, path: string) {
    await mkdir(dirname(path), { recursive: true })
    await symlink(target, path, 'junction')
  }

  it('prefers an absolute PATH executable, then finds the off-PATH Claude native install', async () => {
    const native = await executable(env.USERPROFILE!, '.local', 'bin', 'claude.exe')
    const path = join(root, 'path with spaces')
    env.PATH = `;relative;"${path}"`
    await write(join(path, 'claude.cmd'), '@echo off')
    await mkdir(join(path, 'claude.exe'))
    expect(await resolveWindowsCli('claude', env, 'x64')).toBe(native)
    await rmdir(join(path, 'claude.exe'))
    const onPath = await executable(path, 'claude.exe')
    expect(await resolveWindowsCli('claude', env, 'x64')).toBe(onPath)
  })

  it('uses Claude npm native platform package when postinstall left a placeholder', async () => {
    const scope = join(env.APPDATA!, 'npm', 'node_modules', '@anthropic-ai')
    await write(join(scope, 'claude-code', 'bin', 'claude.exe'), '#!/usr/bin/env node')
    const arm = await executable(scope, 'claude-code-win32-arm64', 'claude.exe')
    expect(await resolveWindowsCli('claude', env, 'x64')).toBeUndefined()
    expect(await resolveWindowsCli('claude', env, 'arm64')).toBe(arm)
    const wrapper = await executable(scope, 'claude-code', 'bin', 'claude.exe')
    expect(await resolveWindowsCli('claude', env, 'arm64')).toBe(wrapper)
  })

  it('resolves the Codex npm alias from its standard nested layout', async () => {
    const prefix = join(root, 'npm custom')
    env.NPM_CONFIG_PREFIX = prefix
    const native = await executable(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    expect(await resolveWindowsCli('codex', env, 'x64')).toBe(native)
  })

  it.each(['5', 'v11'])('follows the pnpm %s wrapper into its linked platform dependencies', async version => {
    env.LOCALAPPDATA = join(root, 'local appdata')
    const home = version === 'v11' ? join(env.LOCALAPPDATA, 'pnpm') : join(root, 'custom pnpm')
    if (version !== 'v11') env.PNPM_HOME = home
    const bin = join(home, 'bin')
    if (version !== 'v11') env.PATH = bin
    await executable(bin, 'codex.exe') // A pnpm executable shim must not be selected.
    const global = join(home, 'global', version)
    const install = version === 'v11' ? join(global, 'hash-target') : global
    const modules = join(install, 'node_modules')
    const shared = join(root, 'virtual store', 'codex', 'node_modules', '@openai')
    const wrapper = join(shared, 'codex')
    await mkdir(wrapper, { recursive: true })
    await link(wrapper, join(modules, '@openai', 'codex'))
    const native = await executable(shared, 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe')
    if (version === 'v11') {
      expect(await resolveWindowsCli('codex', env, 'arm64')).toBeUndefined()
      await link(install, join(global, 'hash'))
    }
    expect(await resolveWindowsCli('codex', env, 'arm64')).toBe(native)
  })
})

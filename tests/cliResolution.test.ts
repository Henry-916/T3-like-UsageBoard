import { chmod, mkdir, mkdtemp, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAgyCli, resolveWindowsAgyCli, resolveWindowsCli } from '../src/main/limits/probes/cli'

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

  const releaseId = 'a'.repeat(64)

  async function managedFixture(platform = 'win32') {
    const home = await realpath(root)
    const managed = join(home, '.t3', 'userdata', 'tools', 'antigravity-acp', `${platform}-x64`)
    const release = join(managed, 'versions', releaseId)
    const filename = platform === 'win32' ? 'agy.exe' : 'antigravity'
    const binary = platform === 'win32'
      ? await executable(release, filename)
      : await write(join(release, filename), '#!/bin/sh\n')
    const active = join(managed, 'active.json')
    const manifest = join(release, '.install-complete.json')
    const metadata = { releaseId, version: '1.0.0', executable: { name: filename, bytes: platform === 'win32' ? 68 : 10 } }
    await write(active, JSON.stringify({ releaseId }))
    await write(manifest, JSON.stringify(metadata))
    return { home, managed, release, binary, active, manifest, metadata, options: { home, env: {}, arch: 'x64' } }
  }

  it('prefers Windows PATH variants, then official native install paths', async () => {
    const home = join(root, 'user')
    const path = join(root, 'path with spaces')
    const pnpm = join(root, 'pnpm')
    const pnpmAlias = join(root, 'pnpm alias')
    const local = join(home, 'AppData', 'Local')
    const options = { home, env: { Path: `relative;"${pnpmAlias}";"${join(local, 'pnpm')}";"${path}"`,
      Pnpm_Home: pnpm }, scanT3: false }
    await executable(pnpm, 'agy.exe')
    await link(pnpm, pnpmAlias)
    await executable(local, 'pnpm', 'agy.exe')
    await write(join(path, 'agy.cmd'), '@echo off')
    await write(join(path, 'agy.exe'), 'MZ invalid')
    const userBin = await executable(home, '.local', 'bin', 'agy.exe')
    expect(await resolveWindowsAgyCli(options)).toBe(userBin)
    const official = await executable(local, 'agy', 'bin', 'agy.exe')
    expect(await resolveWindowsAgyCli(options)).toBe(official)
    const alternate = await executable(path, 'antigravity.exe')
    expect(await resolveWindowsAgyCli(options)).toBe(alternate)
    const agy = await executable(path, 'agy.exe')
    expect(await resolveWindowsAgyCli(options)).toBe(agy)
  })

  it('allows only the active managed binary, as an opt-out fallback', async () => {
    const { binary, home, release, options } = await managedFixture()
    const alias = join(root, 'alias')
    await link(release, alias)
    expect(await resolveWindowsAgyCli({ ...options, arch: 'arm64' })).toBeUndefined()
    expect(await resolveWindowsAgyCli({ ...options, env: { PATH: `${release};${alias}` }, scanT3: false })).toBeUndefined()
    expect(await resolveWindowsAgyCli(options)).toBe(binary)
    const native = await executable(home, '.local', 'bin', 'agy.exe')
    expect(await resolveWindowsAgyCli(options)).toBe(native)
  })

  it('rejects malformed pointers, inconsistent install records and invalid PE data', async () => {
    const { active, binary, manifest, metadata, options } = await managedFixture()
    for (const releaseId of ['../outside', 'A'.repeat(64), `${metadata.releaseId}\n`]) {
      await write(active, JSON.stringify({ releaseId }))
      expect(await resolveWindowsAgyCli(options)).toBeUndefined()
    }
    await write(active, JSON.stringify({ releaseId }))
    for (const record of [
      { ...metadata, releaseId: 'b'.repeat(64) },
      { ...metadata, executable: { name: '../agy.exe', bytes: 68 } },
      ...[0, 1.5, Number.MAX_SAFE_INTEGER + 1, 67].map(bytes => ({ ...metadata, executable: { name: 'agy.exe', bytes } }))
    ]) {
      await write(manifest, JSON.stringify(record))
      expect(await resolveWindowsAgyCli(options)).toBeUndefined()
    }
    await write(manifest, JSON.stringify(metadata))
    await write(binary, Buffer.alloc(68))
    expect(await resolveWindowsAgyCli(options)).toBeUndefined()
  })

  it.each(['.t3', 'userdata', 'tools', 'antigravity-acp', 'win32-x64', 'versions', releaseId])(
    'rejects linked managed ancestry at %s', async segment => {
      const { release, options } = await managedFixture()
      let dir = release
      while (dirname(dir) !== dir && dir !== join(dirname(dir), segment)) dir = dirname(dir)
      expect(dir).toBe(join(dirname(dir), segment))
      const target = join(root, 'redirect')
      await rename(dir, target)
      await link(target, dir)
      expect(await resolveWindowsAgyCli(options)).toBeUndefined()
    }
  )

  it.skipIf(process.platform === 'win32')('requires POSIX execute permission and the managed antigravity basename', async () => {
    const { binary, options } = await managedFixture('linux')
    expect(await resolveAgyCli({ ...options, platform: 'linux' })).toBeUndefined()
    await chmod(binary, 0o700)
    expect(await resolveAgyCli({ ...options, platform: 'linux' })).toBe(binary)
    const path = join(root, 'bin')
    const external = await write(join(path, 'antigravity'), '#!/bin/sh\n')
    await chmod(external, 0o700)
    expect(await resolveAgyCli({ ...options, platform: 'linux', env: { PATH: path } })).toBe(external)
  })
})

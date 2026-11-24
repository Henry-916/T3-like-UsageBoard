import { EventEmitter } from 'node:events'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { renewAgyCliToken } from '../src/main/limits/probes/agyRenewal'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

it.each(['ok', 'expired', 'abort'] as const)('cleans the isolated ACP sandbox on %s', async mode => {
  const controller = new AbortController()
  const requests: string[] = []
  const now = Date.parse('2026-01-01T00:00:00Z')
  const expiry = '2026-01-01T01:00:00Z'
  const stored = { auth_method: 'oauth-business', token: { access_token: 'fake-old', refresh_token: 'fake-source', token_type: 'Bearer' } }
  let sandbox!: string
  let mockFailure: unknown
  vi.mocked(spawn).mockImplementationOnce((_exe, argv, options) => {
    sandbox = argv![2]
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        void (async () => {
          const { id, method, params } = JSON.parse(chunk.toString())
          requests.push(method)
          if (id === 1) {
            expect(params.protocolVersion).toBe(2)
            stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n')
            return
          }
          expect(params).toEqual({ methodId: 'oauth-business' })
          const app = join(sandbox, 'antigravity-acp')
          const path = join(app, 'antigravity-oauth-token')
          expect(JSON.parse(await readFile(join(app, 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-business' } })
          expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
            ...stored, token: { ...stored.token, refresh_token: 'fake-rotated' }
          })
          if (mode === 'abort') controller.abort()
          else if (mode === 'expired') stdout.write('{"jsonrpc":"2.0","id":2,"error":{"code":-32000}}\n')
          else {
            await writeFile(path, JSON.stringify({ token: { access_token: 'fake-new', refresh_token: 'fake-next', expiry } }))
            stdout.write('{"jsonrpc":"2.0","id":2,"result":{}}\n')
          }
        })().then(() => done(), error => { mockFailure = error; done(error) })
      }
    })
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, stderr, kill: () => { queueMicrotask(() => child.emit('close')); return true }
    })
    expect(options).toMatchObject({
      cwd: join(sandbox, 'cwd'), shell: false, windowsHide: true,
      env: { HOME: sandbox, GEMINI_HOME: sandbox, SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0' }
    })
    expect(options?.env).not.toHaveProperty('GOOGLE_API_KEY')
    return child as unknown as ReturnType<typeof spawn>
  })
  const result = await renewAgyCliToken({
    executable: 'fake-agy', stored, authMethod: 'oauth-business', refreshToken: 'fake-rotated',
    signal: controller.signal, now: () => now
  })
  expect(mockFailure).toBeUndefined()
  expect(requests).toEqual(['initialize', 'authenticate'])
  expect(result).toEqual(mode === 'ok' ? {
    kind: 'ok', token: { accessToken: 'fake-new', refreshToken: 'fake-next', expiry, updatedAt: now }
  } : { kind: mode === 'abort' ? 'failed' : 'expired' })
  await expect(stat(sandbox)).rejects.toMatchObject({ code: 'ENOENT' })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { compareAndWriteAntigravityCredential, readAntigravityCredential, writeAntigravityCredential } from '../src/main/accounts/windowsCredentials'

const { execFile, end } = vi.hoisted(() => ({ execFile: vi.fn(), end: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile }))

function reply(stdout: string, error: Error | null = null) {
  execFile.mockImplementation((_path, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout))
    return { stdin: { end, once: vi.fn() } }
  })
}

describe.skipIf(process.platform !== 'win32')('Antigravity system credential transport (mocked)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('reads the exact blob bytes and Windows entry metadata', async () => {
    const blob = Buffer.from('{"id_token_email":"fixture@example.com","writer_id":"测试"}')
    reply(JSON.stringify({ userName: 'antigravity', comment: 'fixture', persist: 2, blob: blob.toString('base64') }))
    expect(await readAntigravityCredential()).toEqual({ userName: 'antigravity', comment: 'fixture', persist: 2, blob })
    expect(end).toHaveBeenCalledExactlyOnceWith('', 'utf8')
    const script = Buffer.from(execFile.mock.calls[0][1].at(-1), 'base64').toString('utf16le')
    expect(script).toContain('Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length)')
  })

  it('writes UTF-8 blob and metadata on stdin only and sanitizes failures', async () => {
    const blob = Buffer.from('{"fixture":"测试"}')
    const entry = { userName: 'antigravity', comment: 'fixture', persist: 2, blob }
    reply('', new Error(`internal error ${blob.toString('base64')}`))
    await expect(writeAntigravityCredential(entry)).rejects.toThrow(/^无法写入 Antigravity 的 Windows 凭据$/)
    expect(end).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ...entry, blob: blob.toString('base64') }), 'utf8')
    expect(JSON.stringify(execFile.mock.calls[0].slice(0, 3))).not.toContain(blob.toString('base64'))
  })

  it('returns undefined when missing', async () => {
    reply('')
    expect(await readAntigravityCredential()).toBeUndefined()
  })

  it.each([false, true])('returns compare-and-write result %s without a second command', async result => {
    reply(String(result))
    const expected = Buffer.from('old fixture')
    const next = Buffer.from('new fixture')
    expect(await compareAndWriteAntigravityCredential(expected, next)).toBe(result)
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ expected: expected.toString('base64'), next: next.toString('base64') }), 'utf8')
  })
})

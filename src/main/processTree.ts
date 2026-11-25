import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export async function killWindowsTree(pid: number, stillRunning: () => boolean): Promise<void> {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  if (!root || !isAbsolute(root)) return
  const executable = join(root, 'System32', 'taskkill.exe')
  const handle = await open(executable, 'r')
  try {
    const header = Buffer.alloc(64)
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.readUInt16LE(0) !== 0x5a4d) return
    const offset = header.readUInt32LE(60)
    if ((await handle.read(header, 0, 4, offset)).bytesRead !== 4 || header.readUInt32LE(0) !== 0x4550) return
  } finally {
    await handle.close()
  }
  if (!stillRunning()) return
  await new Promise<void>(resolve => {
    const tree = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore'
    })
    tree.once('error', () => resolve())
    tree.once('close', () => resolve())
  })
}

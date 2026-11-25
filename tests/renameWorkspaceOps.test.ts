import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

const python = ['python', 'python3', 'py'].find(name =>
  spawnSync(name, ['-B', '-c', 'import sqlite3'], { windowsHide: true, stdio: 'ignore' }).status === 0)

it.skipIf(!python)('verifies the workspace migration on fixture databases only', () => {
  const result = spawnSync(python!, ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/ops',
    '-p', 'test_rename_workspace.py', '-v'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})

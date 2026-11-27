import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
import { latestReleaseNote, releaseNote } from '../src/shared/releaseNotes'

describe('release notes', () => {
  it('keeps the packaged version and the single current note in sync', () => {
    expect(pkg.version).toBe('0.5.4')
    expect(releaseNote.version).toBe(pkg.version)
    const note = latestReleaseNote(pkg.version)
    expect(note).toBe(releaseNote)
    expect(note?.markdown).toContain('### 新增')
    expect(note?.markdown).toContain('models.dev')
    expect(note?.markdown).toContain('峰谷')
  })

  it('never falls back to an older bundled history', () => {
    expect(latestReleaseNote('99.9.9')).toBeUndefined()
    expect(latestReleaseNote('0.5.3')).toBeUndefined()
  })
})

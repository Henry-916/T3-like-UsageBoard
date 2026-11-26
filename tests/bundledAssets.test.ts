import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('bundled serif font', () => {
  it('ships a non-empty WOFF2 file with the wOF2 signature', async () => {
    const path = join(root, 'src', 'renderer', 'assets', 'fonts', 'SourceHanSerifSC-VF.otf.woff2')
    const info = await stat(path)
    expect(info.size).toBeGreaterThan(1_000_000)
    const header = await readFile(path).then(bytes => bytes.subarray(0, 4).toString('latin1'))
    expect(header).toBe('wOF2')
  })

  it('declares the variable face without a local() lookup and loads it first', async () => {
    const css = await readFile(join(root, 'src', 'renderer', 'styles', 'globals.css'), 'utf8')
    const face = css.slice(css.indexOf('@font-face'), css.indexOf('@theme static'))
    expect(face).toContain('font-family: "T3UsageBoard Serif SC"')
    expect(face).toContain('SourceHanSerifSC-VF.otf.woff2')
    expect(face).toContain('font-weight: 200 900')
    expect(face).toContain('font-display: block')
    expect(face).not.toContain('local(')
    expect(css).toMatch(/--font-sans:\s*"T3UsageBoard Serif SC",/)
  })

  it('allows self-hosted fonts through the content security policy', async () => {
    const config = await readFile(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(config).toContain("font-src 'self';")
  })
})

describe('bundled font license', () => {
  it('includes the full OFL-1.1 text and Source Han attribution', async () => {
    const text = await readFile(join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8')
    expect(text).toContain('Source Han Serif')
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(text).toContain('PERMISSION & CONDITIONS')
    expect(text).toContain('TERMINATION')
    expect(text).toContain('Copyright 2014-2021 Adobe')
  })
})

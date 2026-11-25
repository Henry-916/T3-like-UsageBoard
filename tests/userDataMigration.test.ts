import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateUserData } from '../src/main/userDataMigration'

let root: string
let previous: string
let next: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-migration-'))
  previous = join(root, 'old')
  next = join(root, 'new')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('user data migration', () => {
  it('copies Local State and credentials, rebases only internal config paths and skips caches and locks', () => {
    const oldProfile = join(previous, 'profiles', 'fixture')
    const oldCredential = join(oldProfile, 'auth.json')
    const external = join(root, 'old-backup', 'auth.json')
    mkdirSync(join(oldProfile, 'Code Cache'), { recursive: true })
    writeFileSync(oldCredential, '{}')
    writeFileSync(join(previous, 'Local State'), 'encrypted-key-fixture')
    writeFileSync(join(previous, 'SingletonLock'), 'skip')
    writeFileSync(join(previous, 'config.json'), JSON.stringify({ accounts: [
      { dataDir: oldProfile, credentialPath: oldCredential }, { credentialPath: external }
    ] }))
    expect(migrateUserData(previous, next)).toBe(true)
    expect(readFileSync(join(next, 'Local State'), 'utf8')).toBe('encrypted-key-fixture')
    expect(readFileSync(join(next, 'profiles', 'fixture', 'auth.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(next, 'profiles', 'fixture', 'Code Cache'))).toBe(false)
    expect(existsSync(join(next, 'SingletonLock'))).toBe(false)
    expect(JSON.parse(readFileSync(join(next, 'config.json'), 'utf8')).accounts).toEqual([
      { dataDir: join(next, 'profiles', 'fixture'), credentialPath: join(next, 'profiles', 'fixture', 'auth.json') },
      { credentialPath: external }
    ])
    expect(readFileSync(oldCredential, 'utf8')).toBe('{}')
    expect(readFileSync(join(previous, 'config.json'), 'utf8')).toContain(JSON.stringify(oldProfile))
  })
  it('does not overwrite an existing destination configuration or its Local State', () => {
    mkdirSync(next)
    mkdirSync(previous)
    writeFileSync(join(next, 'config.json'), '{"kept":true}')
    writeFileSync(join(previous, 'Local State'), 'old')
    expect(migrateUserData(previous, next)).toBe(false)
    expect(existsSync(join(next, 'Local State'))).toBe(false)
    expect(readFileSync(join(next, 'config.json'), 'utf8')).toBe('{"kept":true}')
  })
  it('cleanly skips a missing previous location', () => {
    expect(migrateUserData(previous, next)).toBe(false)
    expect(existsSync(next)).toBe(false)
  })
  it('does not recopy Local State on subsequent starts when the old profile had no config', () => {
    mkdirSync(previous)
    writeFileSync(join(previous, 'Local State'), 'previous')
    expect(migrateUserData(previous, next)).toBe(true)
    writeFileSync(join(next, 'Local State'), 'in use')
    expect(migrateUserData(previous, next)).toBe(false)
    expect(readFileSync(join(next, 'Local State'), 'utf8')).toBe('in use')
  })
})

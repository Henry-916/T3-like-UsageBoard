import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AccountChanges, AccountsReport, AddManualAccount } from '../../shared/limitsTypes'
import type { AccountConfig, DiscoveredAccount, UsageProviderKind } from '../../shared/types'
import { readConfig, updateConfig, type AppConfig } from '../configStore'
import { hasOpenCodeDbCredential } from '../limits/probes/opencode'
import { discoverAccounts, pathKey, providerNames } from './discovery'

interface AccountServiceOptions {
  userData: string
  pickDirectory: () => Promise<string | undefined>
  pickCredential: () => Promise<string | undefined>
  encrypt: (text: string) => Buffer | Promise<Buffer>
  decrypt: (value: Buffer) => string | Promise<string>
  discover?: typeof discoverAccounts
  onAccountRemoved?: (account: AccountConfig) => Promise<void> | void
}

const MAX_CREDENTIAL_BYTES = 512 * 1024
const manualId = /^manual-[a-f0-9-]{36}$/
const isNonempty = (value: unknown): boolean => typeof value === 'string' && Boolean(value.trim())
const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
const antigravityCredential = (name: string): boolean => name === 'acp_token.json' || name === 'antigravity-oauth-token'

async function readSmallFile(path: string): Promise<Buffer> {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) throw new Error('Invalid credential file')
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_CREDENTIAL_BYTES) throw new Error('Invalid credential file')
  return bytes
}

export function createAccountService({
  userData, pickDirectory, pickCredential, encrypt, decrypt, discover = discoverAccounts, onAccountRemoved
}: AccountServiceOptions) {
  const credentialRoot = join(userData, 'accounts')
  const profileRoot = join(userData, 'profiles')

  async function hasDetectedCredential(account: DiscoveredAccount): Promise<boolean> {
    const { origin, provider, credentialPaths = [] } = account
    if (provider === 'antigravity') {
      const method = account.limitsEnv?.ANTIGRAVITY_AUTH_METHOD?.trim()
      if (method && method !== 'oauth-personal' && method !== 'oauth-business') return false
      for (const path of credentialPaths) {
        const info = await stat(path).catch(() => undefined)
        if (info?.isFile() && info.size > 2) return true
      }
      return false
    }
    if (provider === 'opencode') {
      if (origin === 'manual' && manualId.test(account.id)
        && (await stat(storePath(account.id, 'opencode-go-key')).catch(() => undefined))?.isFile()) return true
      if (origin === 'native' && isNonempty(process.env.OPENCODE_API_KEY)) return true
      if (hasOpenCodeDbCredential(account.dataDir)) return true
    }
    for (const path of credentialPaths) {
      const credential = await readCredential(path).catch(() => undefined)
      if (provider === 'codex') {
        const tokens = field(credential, 'tokens')
        if (isNonempty(field(tokens, 'access_token')) || isNonempty(field(tokens, 'refresh_token'))) return true
      } else if (provider === 'claude') {
        const oauth = field(credential, 'claudeAiOauth')
        if (isNonempty(field(oauth, 'accessToken')) || isNonempty(field(oauth, 'refreshToken'))) return true
      } else if (isNonempty(field(field(credential, 'opencode-go'), 'key'))) return true
    }
    return false
  }

  async function visibleAccounts(config: AppConfig) {
    const hidden = new Set(config.hiddenAccountIds)
    const detected = await Promise.all((await discover(config)).map(async account => ({
      account, hasCredential: await hasDetectedCredential(account)
    })))
    const candidates = detected.filter(({ account, hasCredential }) => account.origin === 'manual' || hasCredential)
    const isHidden = ({ account }: (typeof candidates)[number]) => account.origin !== 'manual' && hidden.has(account.id)
    return { visible: candidates.filter(item => !isHidden(item)), hiddenAutoCount: candidates.filter(isHidden).length }
  }

  const listInternal = async (): Promise<DiscoveredAccount[]> =>
    (await visibleAccounts(await readConfig(userData))).visible.map(({ account }) => account)

  async function uniqueDisplayName(config: AppConfig, base: string): Promise<string> {
    const { visible } = await visibleAccounts(config)
    const names = new Set(visible.map(({ account }) => account.displayName))
    let displayName = base
    for (let suffix = 2; names.has(displayName); suffix++) displayName = `${base} ${suffix}`
    return displayName
  }

  async function list(): Promise<AccountsReport> {
    const config = await readConfig(userData)
    const { visible, hiddenAutoCount } = await visibleAccounts(config)
    return {
      scanT3: config.scanT3,
      hiddenAutoCount,
      accounts: visible.map(({ account, hasCredential }) => ({
        id: account.id, provider: account.provider, displayName: account.displayName, origin: account.origin,
        enabled: account.enabled, dataDir: account.dataDir,
        hasCredential
      }))
    }
  }

  function storePath(id: string, name: string): string {
    if (!manualId.test(id)) throw new Error('Invalid manual account')
    return join(credentialRoot, id, name)
  }

  async function assertOwnedDirectory(root: string, dir: string): Promise<void> {
    const expected = join(await realpath(userData), basename(root), basename(dir))
    if (!(await lstat(dir)).isDirectory() || pathKey(await realpath(dir)) !== pathKey(expected)) {
      throw new Error('Invalid account directory')
    }
  }

  async function writeEncrypted(id: string, filename: string, text: string): Promise<string> {
    const bytes = await encrypt(text)
    const file = storePath(id, filename)
    const dir = join(credentialRoot, id)
    await mkdir(credentialRoot, { recursive: true })
    if (!(await lstat(credentialRoot)).isDirectory()) throw new Error('Invalid account directory')
    await mkdir(dir, { recursive: true })
    await assertOwnedDirectory(credentialRoot, dir)
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
    return file
  }

  async function readCredential(file: string): Promise<unknown> {
    const rel = relative(resolve(credentialRoot), resolve(file))
    const stored = rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    const bytes = await readSmallFile(file)
    const payload = (stored ? await decrypt(bytes) : bytes.toString('utf8')).replace(/^\uFEFF/, '').trim()
    if (!payload) throw new Error('Empty credential')
    try { return JSON.parse(payload) as unknown } catch { return payload }
  }

  return {
    list,
    listInternal,
    readCredential,
    async getManualApiKey(account: DiscoveredAccount): Promise<string | undefined> {
      if (account.origin !== 'manual' || account.provider !== 'opencode' || !manualId.test(account.id)) return undefined
      try {
        return await decrypt(await readSmallFile(storePath(account.id, 'opencode-go-key')))
      } catch { return undefined }
    },
    async add(input: AddManualAccount): Promise<AccountsReport | null> {
      const account: AccountConfig = { id: `manual-${randomUUID()}`, provider: input.provider, displayName: input.displayName }
      try {
        if (input.mode === 'directory') {
          const picked = await pickDirectory()
          if (!picked) return null
          account.dataDir = await realpath(picked)
          if (!(await stat(account.dataDir)).isDirectory()) throw new Error('Invalid account directory')
        } else if (input.mode === 'credential') {
          const picked = await pickCredential()
          if (!picked) return null
          const name = basename(picked).toLowerCase()
          if (!antigravityCredential(name)) throw new Error('Unsupported Antigravity credential')
          const text = (await readSmallFile(picked)).toString('utf8').replace(/^\uFEFF/, '').trim()
          if (!text) throw new Error('Empty credential')
          account.credentialPath = await writeEncrypted(account.id, name, text)
        } else {
          account.credentialPath = await writeEncrypted(account.id, 'opencode-go-key', input.apiKey!)
        }
        await updateConfig(userData, async config => {
          if (input.mode === 'apiKey' && !account.displayName.trim()) {
            account.displayName = await uniqueDisplayName(config, providerNames.opencode)
          }
          return { ...config, accounts: [...config.accounts, account] }
        })
      } catch {
        if (account.credentialPath) {
          await rm(join(credentialRoot, account.id), { recursive: true, force: true }).catch(() => undefined)
        }
        throw new Error('Unable to add account')
      }
      return list()
    },
    async addManagedAccount(
      account: { id: string; provider: UsageProviderKind; displayName?: string; dataDir?: string },
      credential?: { filename: string; text: string }
    ): Promise<AccountsReport> {
      const { id, provider, dataDir } = account
      if (!manualId.test(id)) throw new Error('Invalid manual account')
      let profileDir: string | undefined
      if (provider === 'codex' || provider === 'claude') {
        profileDir = resolve(profileRoot, id)
        if (!dataDir || credential || pathKey(resolve(dataDir)) !== pathKey(profileDir)) {
          throw new Error('Invalid account directory')
        }
        await assertOwnedDirectory(profileRoot, profileDir)
      } else if (dataDir || !credential || !isNonempty(credential.text)
        || Buffer.byteLength(credential.text) > MAX_CREDENTIAL_BYTES
        || !(provider === 'antigravity' ? antigravityCredential(credential.filename) : credential.filename === 'opencode-go-key')) {
        throw new Error('Invalid credential file')
      }

      let credentialPath: string | undefined
      try {
        await updateConfig(userData, async config => {
          if (config.accounts.some(account => account.id === id)) throw new Error('Account already exists')
          const base = account.displayName?.trim() || providerNames[provider]
          const displayName = await uniqueDisplayName(config, base)
          if (credential) credentialPath = await writeEncrypted(id, credential.filename, credential.text)
          return { ...config, accounts: [...config.accounts, { id, provider, displayName, dataDir: profileDir, credentialPath }] }
        })
      } catch (error) {
        if (credentialPath) await rm(credentialPath, { force: true }).catch(() => undefined)
        throw error
      }
      return list()
    },
    async update(id: string, changes: AccountChanges): Promise<AccountsReport> {
      if (!(await listInternal()).some(account => account.id === id)) throw new Error('Unknown account')
      await updateConfig(userData, config => ({
        ...config,
        accountPreferences: { ...config.accountPreferences, [id]: { ...config.accountPreferences[id], ...changes } }
      }))
      return list()
    },
    async setScanT3(scanT3: boolean): Promise<AccountsReport> {
      await updateConfig(userData, config => ({ ...config, scanT3 }))
      return list()
    },
    async remove(id: string): Promise<AccountsReport> {
      let removed: AccountConfig | undefined
      await updateConfig(userData, async config => {
        removed = config.accounts.find(account => account.id === id)
        const { [id]: _removed, ...accountPreferences } = config.accountPreferences
        if (removed) return { ...config, accountPreferences, accounts: config.accounts.filter(account => account.id !== id) }
        if (!(await discover(config)).some(account => account.id === id && account.origin !== 'manual')) {
          throw new Error('Unknown account')
        }
        return { ...config, accountPreferences, hiddenAccountIds: [...new Set([...config.hiddenAccountIds, id])] }
      })
      if (removed) {
        try { await onAccountRemoved?.(removed) } catch { /* Cache cleanup must not prevent credential deletion. */ }
        if (manualId.test(id)) {
          for (const root of [credentialRoot, profileRoot]) {
            if ((await lstat(root).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
            }))?.isDirectory()) await rm(join(root, id), { recursive: true, force: true })
          }
        }
      }
      return list()
    },
    async restoreHidden(): Promise<AccountsReport> {
      await updateConfig(userData, config => ({ ...config, hiddenAccountIds: [] }))
      return list()
    }
  }
}

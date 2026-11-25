import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AccountChanges, AccountsReport, AddManualAccount } from '../../shared/limitsTypes'
import type { AccountConfig, DiscoveredAccount, UsageProviderKind } from '../../shared/types'
import { readConfig, updateConfig, type AppConfig } from '../configStore'
import { hasOpenCodeDbCredential } from '../limits/probes/opencode'
import { discoverAccounts, pathKey, providerNames } from './discovery'
import { createIdentityStore, credentialEmail, field, identityKey, normalizeEmail } from './identities'
import { cliToken } from '../limits/probes/agyRenewal'
import { credentialCandidates } from '../limits/probes/cli'

interface AccountServiceOptions {
  userData: string
  pickDirectory: () => Promise<string | undefined>
  pickCredential: () => Promise<string | undefined>
  encrypt: (text: string) => Buffer | Promise<Buffer>
  decrypt: (value: Buffer) => string | Promise<string>
  discover?: typeof discoverAccounts
  readAntigravityCredential?: () => Promise<{ blob: Buffer } | undefined>
  onAccountRemoved?: (account: AccountConfig) => Promise<void> | void
}

const MAX_CREDENTIAL_BYTES = 512 * 1024
const manualId = /^manual-[a-f0-9-]{36}$/
const isNonempty = (value: unknown): boolean => typeof value === 'string' && Boolean(value.trim())
const antigravityCredential = (name: string): boolean => name === 'acp_token.json' || name === 'antigravity-oauth-token'

async function readSmallFile(path: string): Promise<Buffer> {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) throw new Error('Invalid credential file')
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_CREDENTIAL_BYTES) throw new Error('Invalid credential file')
  return bytes
}

export function createAccountService({
  userData, pickDirectory, pickCredential, encrypt, decrypt, discover = discoverAccounts, onAccountRemoved,
  readAntigravityCredential
}: AccountServiceOptions) {
  const credentialRoot = join(userData, 'accounts')
  const profileRoot = join(userData, 'profiles')
  const identities = createIdentityStore(userData)
  const attempted = new Set<string>()
  const accountKeys = new WeakMap<DiscoveredAccount, { key: string; offlineEmail?: string }>()

  async function discoverSources(config: AppConfig): Promise<DiscoveredAccount[]> {
    const accounts = await discover(config)
    const slot = await readAntigravityCredential?.()
    if (slot && parseSlot(slot.blob)) {
      const id = 'native:antigravity:credman'
      return [...accounts, {
        id, provider: 'antigravity', origin: 'native', displayName: providerNames.antigravity,
        enabled: config.accountPreferences[id]?.enabled ?? true, current: true, currentCredential: slot.blob
      }]
    }
    return accounts
  }

  function parseSlot(blob: Buffer) {
    try {
      const result = cliToken.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(blob)))
      return result.success ? result.data : undefined
    } catch { return undefined }
  }

  async function hasDetectedCredential(account: DiscoveredAccount): Promise<boolean> {
    const { origin, provider } = account
    const credentialPaths = provider === 'antigravity' ? account.credentialPaths ?? [] : credentialCandidates(account)
    if (account.currentCredential) return true
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

  async function identify(account: DiscoveredAccount): Promise<{ email?: string; offlineEmail?: string; key: string; switchSource?: DiscoveredAccount }> {
    let bind = ''
    let email: string | undefined
    let selectedPath: string | undefined
    let switchSource: DiscoveredAccount | undefined
    const inspect = (value: unknown, path?: string): void => {
      const isCli = account.provider === 'antigravity' && cliToken.safeParse(value).success
      const tokens = field(value, 'tokens')
      const codex = account.provider === 'codex' && (isNonempty(field(tokens, 'access_token')) || isNonempty(field(tokens, 'refresh_token')))
      if ((isCli || codex) && !switchSource && path) switchSource = { ...account, credentialPaths: [path] }
      email ??= credentialEmail(account.provider, value)
      if (!selectedPath) selectedPath = path
      if (account.current) {
        const token = account.provider === 'codex' ? tokens : field(value, 'token')
        const secret = field(token, 'refresh_token') || field(token, 'access_token')
        if (typeof secret === 'string') bind = identityKey(secret)
      }
    }
    if (account.currentCredential) inspect(parseSlot(account.currentCredential))
    else if (account.provider !== 'opencode') {
      const paths = account.provider === 'antigravity' ? account.credentialPaths ?? [] : credentialCandidates(account)
      for (const path of paths) {
        const value = await readCredential(path).catch(() => undefined)
        if (value !== undefined) inspect(value, path)
      }
      if (!email && account.provider === 'claude' && account.dataDir) {
        email = credentialEmail('claude', await readCredential(join(account.dataDir, '.claude.json')).catch(() => undefined))
      }
    }
    const path = selectedPath ?? account.credentialPath ?? account.dataDir
    const resolved = path ? await realpath(path).catch(() => resolve(path)) : ''
    const key = identityKey(account.id, pathKey(resolved), bind)
    if (email) await identities.set(key, email).catch(() => undefined)
    return { email: email ?? await identities.get(key), offlineEmail: email, key, switchSource }
  }

  async function visibleAccounts(config: AppConfig) {
    const hidden = new Set(config.hiddenAccountIds)
    const detected = await Promise.all((await discoverSources(config)).map(async account => ({
      account, hasCredential: await hasDetectedCredential(account)
    })))
    const candidates = detected.filter(({ account, hasCredential }) => account.origin === 'manual' || hasCredential)
    const isHidden = ({ account }: (typeof candidates)[number]) => account.origin !== 'manual' && hidden.has(account.id)
    const groups = new Map<string, Array<(typeof candidates)[number] & Awaited<ReturnType<typeof identify>>>>()
    for (const item of await Promise.all(candidates.map(async item => ({ ...item, ...await identify(item.account) })))) {
      const key = item.email ? `${item.account.provider}:${item.email}` : item.account.id
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }
    const visible = [...groups.values()].flatMap(group => {
      const available = group.filter(item => !isHidden(item))
      const item = available.find(({ account }) => account.origin === 'manual')
        ?? available.find(({ account }) => account.current) ?? available[0]
      if (!item) return []
      const active = group.find(({ account }) => account.current)
      const source = active ?? (item.hasCredential ? item : available.find(entry => entry.hasCredential)) ?? item
      const switchSource = active ? undefined : item.switchSource ?? available.find(entry => entry.switchSource)?.switchSource
      const { account, email } = item
      const representative: DiscoveredAccount = {
        ...account, email, current: active ? true : undefined,
        displayName: account.provider === 'opencode' ? 'OpenCode Go' : email ?? (attempted.has(source.key) ? '未知账号' : '正在识别…'),
        canSwitch: switchSource ? true : undefined, switchSource,
        credentialSource: source.account === account ? undefined : source.account
      }
      accountKeys.set(representative, { key: source.key, offlineEmail: source.offlineEmail })
      return [{ account: representative, hasCredential: Boolean(source.hasCredential) }]
    })
    return { visible, hiddenAutoCount: candidates.filter(isHidden).length }
  }

  const listInternal = async (): Promise<DiscoveredAccount[]> =>
    (await visibleAccounts(await readConfig(userData))).visible.map(({ account }) => account)

  async function list(): Promise<AccountsReport> {
    const config = await readConfig(userData)
    const { visible, hiddenAutoCount } = await visibleAccounts(config)
    return {
      scanT3: config.scanT3,
      hiddenAutoCount,
      accounts: visible.map(({ account, hasCredential }) => ({
        id: account.id, provider: account.provider, displayName: account.displayName, origin: account.origin,
        enabled: account.enabled, current: account.current, canSwitch: account.canSwitch,
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

  async function snapshotCurrentCredential(provider: 'codex' | 'antigravity', text: string): Promise<void> {
    if (Buffer.byteLength(text) > MAX_CREDENTIAL_BYTES) throw new Error('无法保存当前账号凭证。')
    let value: unknown
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('无法读取当前账号凭证。') }
    let email = credentialEmail(provider, value)
    const tokens = field(value, 'tokens')
    if ((provider === 'antigravity' && !cliToken.safeParse(value).success)
      || (provider === 'codex' && !isNonempty(field(tokens, 'access_token')) && !isNonempty(field(tokens, 'refresh_token')))) {
      throw new Error('无法读取当前账号凭证。')
    }
    await updateConfig(userData, async config => {
      const accounts = !email && provider === 'antigravity' ? await discoverSources(config) : await discover(config)
      const fileName = provider === 'codex' ? 'auth.json' : 'antigravity-oauth-token'
      if (!email) {
        const active = accounts.find(account => account.provider === provider && account.current)
        if (active) {
          const blob = active.currentCredential ?? (active.credentialPaths?.[0]
            ? await readSmallFile(active.credentialPaths[0]).catch(() => undefined) : undefined)
          if (blob?.equals(Buffer.from(text))) email = (await identify(active)).email
        }
      }
      for (const account of accounts) {
        if (account.provider !== provider || account.origin !== 'manual' || !manualId.test(account.id)) continue
        const encryptedPath = join(credentialRoot, account.id, fileName)
        const encrypted = Boolean(account.credentialPath && pathKey(resolve(account.credentialPath)) === pathKey(resolve(encryptedPath)))
        const root = encrypted ? credentialRoot : profileRoot
        const dir = join(root, account.id)
        const path = join(dir, fileName)
        if (!encrypted && (provider !== 'codex' || !account.dataDir || pathKey(resolve(account.dataDir)) !== pathKey(resolve(dir)))) continue
        await assertOwnedDirectory(root, dir)
        const before = await readCredential(path).catch(() => undefined)
        if (email ? (await identify(account)).email !== email
          : before === undefined || JSON.stringify(before) !== JSON.stringify(value)) continue
        const tmp = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(tmp, encrypted ? await encrypt(text) : text, { flag: 'wx', mode: 0o600 })
          await rename(tmp, path)
        } finally { await rm(tmp, { force: true }).catch(() => undefined) }
        return config
      }
      const id = `manual-${randomUUID()}`
      const account: AccountConfig = { id, provider, displayName: providerNames[provider],
        credentialPath: await writeEncrypted(id, fileName, text) }
      if (email) {
        const path = account.credentialPath!
        const resolved = await realpath(path).catch(() => resolve(path))
        await identities.set(identityKey(id, pathKey(resolved), ''), email).catch(() => undefined)
      }
      return { ...config, accounts: [account, ...config.accounts] }
    })
  }

  return {
    list,
    listInternal,
    readCredential,
    snapshotCurrentCredential,
    async recordIdentity(account: DiscoveredAccount, email?: string): Promise<void> {
      const binding = accountKeys.get(account)
      if (!binding) return
      const { key, offlineEmail } = binding
      attempted.add(key)
      const canonical = normalizeEmail(email)
      // The key includes the captured active token binding: a late result cannot label a replacement slot.
      if (canonical && !offlineEmail) await identities.set(key, canonical).catch(() => undefined)
    },
    async getManualApiKey(account: DiscoveredAccount): Promise<string | undefined> {
      if (account.origin !== 'manual' || account.provider !== 'opencode' || !manualId.test(account.id)) return undefined
      try {
        return await decrypt(await readSmallFile(storePath(account.id, 'opencode-go-key')))
      } catch { return undefined }
    },
    async add(input: AddManualAccount): Promise<AccountsReport | null> {
      const account: AccountConfig = { id: `manual-${randomUUID()}`, provider: input.provider, displayName: providerNames[input.provider] }
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
        await updateConfig(userData, config => ({ ...config, accounts: [...config.accounts, account] }))
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
          const displayName = providerNames[provider]
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
        accountPreferences: { ...config.accountPreferences, [id]: { ...config.accountPreferences[id], enabled: changes.enabled ?? config.accountPreferences[id]?.enabled } }
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
        if (!(await discoverSources(config)).some(account => account.id === id && account.origin !== 'manual')) {
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

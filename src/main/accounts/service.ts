import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AccountChanges, AccountsReport, AddManualAccount } from '../../shared/limitsTypes'
import type { AccountConfig, DiscoveredAccount } from '../../shared/types'
import { readConfig, updateConfig } from '../configStore'
import { discoverAccounts } from './discovery'

interface AccountServiceOptions {
  userData: string
  pickDirectory: () => Promise<string | undefined>
  pickCredential: () => Promise<string | undefined>
  encrypt: (text: string) => Buffer | Promise<Buffer>
  decrypt: (value: Buffer) => string | Promise<string>
  discover?: typeof discoverAccounts
}

const MAX_CREDENTIAL_BYTES = 512 * 1024
const manualId = /^manual-[a-f0-9-]{36}$/
const pathExists = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isFile() ?? false

async function readSmallFile(path: string): Promise<Buffer> {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) throw new Error('Invalid credential file')
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_CREDENTIAL_BYTES) throw new Error('Invalid credential file')
  return bytes
}

export function createAccountService({
  userData, pickDirectory, pickCredential, encrypt, decrypt, discover = discoverAccounts
}: AccountServiceOptions) {
  const credentialRoot = join(userData, 'accounts')
  const listInternal = async () => discover(await readConfig(userData))

  async function list(): Promise<AccountsReport> {
    const config = await readConfig(userData)
    const accounts = await discover(config)
    return {
      scanT3: config.scanT3,
      accounts: await Promise.all(accounts.map(async account => ({
        id: account.id, provider: account.provider, displayName: account.displayName, origin: account.origin,
        enabled: account.enabled, dataDir: account.dataDir,
        hasCredential: (await Promise.all((account.credentialPaths ?? []).map(pathExists))).some(Boolean)
          || (account.provider === 'opencode' && Boolean(process.env.OPENCODE_API_KEY))
      })))
    }
  }

  function storePath(id: string, name: string): string {
    if (!manualId.test(id)) throw new Error('Invalid manual account')
    return join(credentialRoot, id, name)
  }

  async function writeEncrypted(id: string, filename: string, text: string): Promise<string> {
    const bytes = await encrypt(text)
    const file = storePath(id, filename)
    await mkdir(join(credentialRoot, id), { recursive: true })
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
          if (name !== 'acp_token.json' && name !== 'antigravity-oauth-token') throw new Error('Unsupported Antigravity credential')
          const text = (await readSmallFile(picked)).toString('utf8').replace(/^\uFEFF/, '').trim()
          if (!text) throw new Error('Empty credential')
          account.credentialPath = await writeEncrypted(account.id, name, text)
        } else {
          account.credentialPath = await writeEncrypted(account.id, 'opencode-go-key', input.apiKey!)
        }
        await updateConfig(userData, config => ({ ...config, accounts: [...config.accounts, account] }))
      } catch {
        await rm(join(credentialRoot, account.id), { recursive: true, force: true }).catch(() => undefined)
        throw new Error('Unable to add account')
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
      await updateConfig(userData, config => {
        if (!config.accounts.some(account => account.id === id)) throw new Error('Unknown manual account')
        const { [id]: _removed, ...accountPreferences } = config.accountPreferences
        return { ...config, accountPreferences, accounts: config.accounts.filter(account => account.id !== id) }
      })
      if (manualId.test(id)) await rm(join(credentialRoot, id), { recursive: true, force: true })
      return list()
    }
  }
}

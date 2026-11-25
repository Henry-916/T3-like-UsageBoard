export type UpdateMode = 'nsis' | 'portable' | 'development'
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  mode: UpdateMode
  currentVersion: string
  status: UpdateStatus
  latestVersion?: string
  downloadPercent?: number
  downloadedFile?: string
  releaseUrl?: string
  message?: string
}

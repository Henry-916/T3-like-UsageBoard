import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LimitIssueGuide } from '../src/renderer/components/LimitsView'
import { agyCliInstallUrl } from '../src/renderer/limitsPresentation'
import type { LimitAccountIssue } from '../src/shared/limitsTypes'

type TestProps = {
  children?: ReactNode
  className?: string
  disabled?: boolean
  'aria-disabled'?: boolean
  'aria-busy'?: boolean
  onClick?: () => void
}

function elements(node: ReactNode): ReactElement<TestProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<TestProps>(node)) return []
  return [node, ...elements(node.props.children)]
}

const missingCli: LimitAccountIssue = {
  id: 'agy-1', provider: 'antigravity', displayName: 'work@example.com', origin: 'manual',
  reason: 'cli_missing', cached: false
}

function render(refreshing = false, onRefresh = vi.fn(), issue = missingCli) {
  return elements(LimitIssueGuide({
    id: 'guide', issue, refreshing, onRefresh, onOpenAccounts: vi.fn()
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LimitIssueGuide actions', () => {
  it('uses aria-disabled instead of native disabled on retry and omits unrecovered status text', () => {
    const onRefresh = vi.fn()
    const idle = render(false, onRefresh).find(({ props }) =>
      props.className === 'limit-reset-action' && props.children === '重试')!
    expect(idle.props.disabled).toBeUndefined()
    expect(idle.props['aria-disabled']).toBe(false)
    idle.props.onClick!()
    expect(onRefresh).toHaveBeenCalledOnce()

    const busy = render(true, onRefresh)
    const button = busy.find(({ props }) => props.className === 'limit-reset-action' && props['aria-disabled'])!
    expect(button.props.disabled).toBeUndefined()
    expect(button.props['aria-disabled']).toBe(true)
    expect(button.props['aria-busy']).toBe(true)
    expect(elements(button.props.children).some(({ props }) => props.className?.includes('animate-spin'))).toBe(true)
    button.props.onClick!()
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(render(false, onRefresh).some(({ props }) =>
      typeof props.children === 'string' && props.children.includes('重试未恢复'))).toBe(false)
  })

  it('opens the official Antigravity CLI install URL via openExternalUrl', async () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { usageApi: { openExternalUrl } })
    const nodes = render()
    const link = nodes.find(({ props }) => props.className === 'limit-install-link')!
    expect(elements(link.props.children).some(({ props }) => props.children === agyCliInstallUrl)).toBe(true)
    link.props.onClick!()
    await Promise.resolve()
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(agyCliInstallUrl)
  })
})

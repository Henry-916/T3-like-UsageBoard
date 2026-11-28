import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterPricePresets, applyPresetToRow, PriceOverridesDialog } from '../src/renderer/components/PriceOverridesDialog'
import type { PricePreset, PricingSettings } from '../src/shared/types'

// No DOM environment is installed; run the component's callbacks and commit
// the option ref before layout effects, as the renderer would.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: <T,>(initial: T) => {
    const slot = useSlot(() => ({ value: initial }))
    return [slot.value, (next: T | ((value: T) => T)) => {
      slot.value = typeof next === 'function' ? (next as (value: T) => T)(slot.value) : next
    }]
  },
  useRef: <T,>(current: T) => useSlot(() => ({ current })),
  useId: () => `test-${cursor++}`,
  useCallback: <T,>(callback: T) => callback,
  useMemo: <T,>(compute: () => T, deps: readonly unknown[]) => {
    const slot = useSlot(() => ({ value: compute(), deps }))
    if (depsChanged(slot.deps, deps)) {
      slot.value = compute()
      slot.deps = deps
    }
    return slot.value
  },
  useEffect: (effect: () => void, deps: readonly unknown[]) => queueEffect(effects, effect, deps),
  useLayoutEffect: (effect: () => void, deps: readonly unknown[]) => queueEffect(layoutEffects, effect, deps)
}))

let cursor = 0
const slots: unknown[] = []
const effects: (() => void)[] = []
const layoutEffects: (() => void)[] = []

function useSlot<T>(init: () => T): T {
  const index = cursor++
  if (!(index in slots)) slots[index] = init()
  return slots[index] as T
}

function depsChanged(previous: readonly unknown[], next: readonly unknown[]) {
  return next.length !== previous.length || next.some((dep, index) => !Object.is(dep, previous[index]))
}

function queueEffect(queue: (() => void)[], effect: () => void, deps: readonly unknown[]) {
  const slot = useSlot(() => ({ deps: undefined as readonly unknown[] | undefined }))
  if (!slot.deps || depsChanged(slot.deps, deps)) {
    slot.deps = deps
    queue.push(effect)
  }
}

type TestProps = {
  children?: ReactNode
  className?: string
  role?: string
  title?: string
  'aria-label'?: string
  'aria-hidden'?: boolean
  'aria-selected'?: boolean
  'aria-checked'?: boolean
  size?: number
  'data-placement'?: string
  disabled?: boolean
  tabIndex?: number
  value?: string
  style?: Record<string, unknown>
  ref?: { current: unknown }
  onChange?: (event: { target: { value: string } }) => void
  onClick?: (event: { currentTarget: HTMLButtonElement }) => void
  onFocus?: (event: { currentTarget: HTMLButtonElement }) => void
  onBlur?: () => void
  onPointerDown?: (event: { preventDefault: () => void }) => void
  onKeyDown?: (event: { key: string; preventDefault: () => void }) => void
  onScroll?: () => void
  onPointerLeave?: () => void
  onPointerEnter?: (event: {
    stopPropagation?: () => void
    target?: unknown
    currentTarget: {
      getBoundingClientRect: () => { left: number; right?: number; top: number; bottom: number }
      querySelector?: (selector: string) => { scrollWidth: number; clientWidth: number } | null
    }
  }) => void
}

function elements(node: ReactNode): ReactElement<TestProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<TestProps>(node)) return []
  return [node, ...elements(node.props.children)]
}

function render(commit?: (nodes: ReactElement<TestProps>[]) => void) {
  cursor = 0
  const nodes = elements(PriceOverridesDialog({ models: [], onClose: vi.fn(), onSaved: vi.fn() }))
  commit?.(nodes)
  layoutEffects.splice(0).forEach((effect) => effect())
  effects.splice(0).forEach((effect) => effect())
  return nodes
}

const settings = { priceOverrides: { custom: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } } }
const presets: PricePreset[] = Array.from({ length: 10 }, (_, index) => ({
  id: `preset-${index}`, modelId: `provider/model-${index}`, label: `Preset ${index}`,
  source: 'models.dev', providerLabel: 'Provider',
  inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 4
}))

function mockApi(presetResult: Promise<PricePreset[]>, settingsValue: PricingSettings = settings) {
  vi.stubGlobal('window', {
    usageApi: { getPricingSettings: () => Promise.resolve(settingsValue), getPricePresets: () => presetResult }
  })
}

function openPicker(nodes: ReactElement<TestProps>[], anchor = {} as HTMLButtonElement) {
  nodes.find(({ props }) => props.className === 'price-preset-trigger')!
    .props.onClick!({ currentTarget: anchor })
}

function press(nodes: ReactElement<TestProps>[], key: string) {
  const preventDefault = vi.fn()
  nodes.find(({ props }) => props.className === 'preset-picker-menu')!.props.onKeyDown!({ key, preventDefault })
  return preventDefault
}

afterEach(() => {
  slots.length = 0
  vi.unstubAllGlobals()
})

describe('PriceOverridesDialog preset picker', () => {
  it('puts the preset column after all four rates and before removal', async () => {
    mockApi(Promise.resolve(presets))
    render()
    await Promise.resolve()
    const nodes = render()
    expect(nodes.filter(({ type }) => type === 'col').map(({ props }) => props.className)).toEqual([
      'price-model-col', undefined, undefined, undefined, undefined, 'price-preset-col', 'price-delete-col'
    ])
    expect(nodes.filter(({ type }) => type === 'th').map(({ props }) =>
      typeof props.children === 'string' ? props.children : elements(props.children)[0]?.props.children
    )).toEqual(['模型 ID', '输入', '输出', '缓存读取', '缓存创建', '预设', '移除模型'])
    expect(nodes.filter(({ type }) => type === 'td').map(({ props }) => {
      const child = elements(props.children)[0]?.props
      if (child?.className === 'price-model-line') {
        const inner = elements(child.children)[0]?.props
        return inner?.['aria-label'] ?? inner?.children
      }
      return child?.['aria-label'] ?? (child?.className === 'price-preset-trigger' ? 'preset' : child?.children)
    })).toEqual(['custom', 'custom 输入单价', 'custom 输出单价', 'custom 缓存读取单价',
      'custom 缓存创建单价', 'preset', '移除 custom'])
    expect(elements(nodes.find(({ props }) => props.className === 'price-preset-trigger')!.props.children)[0]!
      .props.children).toBe('选择预设')
  })

  it('only fills the four rates and never overwrites the model id', () => {
    const preset = { ...presets[0]!, cacheReadCostPerMillionTokens: 0.5, cacheWriteCostPerMillionTokens: 0.75 }
    expect(applyPresetToRow({ id: 1, model: '', rates: {}, isNew: true }, preset)).toEqual({
      id: 1, model: '', isNew: true,
      rates: {
        inputCostPerMillionTokens: '3', outputCostPerMillionTokens: '4',
        cacheReadCostPerMillionTokens: '0.5', cacheWriteCostPerMillionTokens: '0.75'
      }
    })
    expect(applyPresetToRow({ id: 2, model: 'private/relay', rates: {} }, preset).model).toBe('private/relay')
  })

  it('carries peak multipliers from a preset and clears them when a fixed preset is chosen', () => {
    const multipliers = [{
      when: { utc_hours: { gte: '14:00' } },
      factor: 0.5
    }]
    const row = applyPresetToRow({ id: 3, model: 'custom/deepseek', rates: {} }, {
      ...presets[0]!, multipliers
    })
    expect(row).toMatchObject({ multipliers, multipliersEnabled: true })
    expect(applyPresetToRow(row, presets[1]!)).toEqual({
      id: 3, model: 'custom/deepseek',
      rates: {
        inputCostPerMillionTokens: '3', outputCostPerMillionTokens: '4',
        cacheReadCostPerMillionTokens: '', cacheWriteCostPerMillionTokens: ''
      }
    })
  })

  it('renders each preset option as a single provider/model line', async () => {
    mockApi(Promise.resolve(presets))
    render()
    await Promise.resolve()
    openPicker(render())
    render().find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!
      .props.onChange!({ target: { value: '' } })
    const nodes = render()
    const mains = nodes.filter(({ props }) => props.className === 'preset-option-main')
    expect(mains).toHaveLength(presets.length)
    for (const [index, main] of mains.entries()) {
      const children = elements(main.props.children)
      expect(children).toHaveLength(1)
      expect(children[0]!.type).toBe('strong')
      expect(children[0]!.props.children).toBe(presets[index]!.modelId)
    }
  })

  it('aligns the popover to the trigger right edge, expands downward, and snaps height to whole rows', async () => {
    mockApi(Promise.resolve(presets))
    let reposition: (() => void) | undefined
    Object.assign(window, {
      innerWidth: 800, innerHeight: 600,
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'resize') reposition = listener
      })
    })
    render()
    await Promise.resolve()
    let anchorRect = { left: 604, right: 700, top: 40, bottom: 70 }
    openPicker(render(), {
      getBoundingClientRect: () => anchorRect
    } as HTMLButtonElement)
    const listStyle = { maxHeight: '' }
    const panel = {
      style: { width: '', maxHeight: '', left: '', top: '' },
      matches: vi.fn(() => true),
      querySelector: () => ({ style: listStyle }),
      getBoundingClientRect: () => ({ height: 200 })
    }
    render((nodes) => {
      const menu = nodes.find(({ props }) => props.className === 'preset-picker-menu')!
      Object.assign(menu.props.ref!, { current: panel })
    })
    expect(panel.style).toEqual({ width: '560px', maxHeight: '342px', left: '140px', top: '74px' })
    expect(listStyle.maxHeight).toBe('286px')
    anchorRect = { left: 204, right: 300, top: 40, bottom: 70 }
    reposition!()
    expect(panel.style.left).toBe('8px')

    // Even when remaining height below (<360px) is smaller than space above, keep expanding downward.
    Object.assign(window, { innerHeight: 727 })
    anchorRect = { left: 604, right: 700, top: 375, bottom: 405 }
    reposition!()
    // 310px is exactly eight 30px rows plus seven 2px gaps and the 56px chrome.
    expect(panel.style).toEqual({ width: '560px', maxHeight: '310px', left: '140px', top: '409px' })
    expect(listStyle.maxHeight).toBe('254px')

    // A short viewport keeps at least three whole rows and lifts the menu upward.
    Object.assign(window, { innerHeight: 400 })
    anchorRect = { left: 604, right: 700, top: 300, bottom: 330 }
    reposition!()
    expect(panel.style).toEqual({ width: '560px', maxHeight: '150px', left: '140px', top: '242px' })
    expect(listStyle.maxHeight).toBe('94px')
    expect((Number.parseInt(panel.style.maxHeight, 10) - 56 + 2) % 32).toBe(0)

    // Below 166px the menu still clamps inside the viewport instead of overflowing.
    Object.assign(window, { innerHeight: 150 })
    reposition!()
    expect(panel.style.maxHeight).toBe('134px')
    expect(listStyle.maxHeight).toBe('78px')
    expect(Number.parseInt(panel.style.maxHeight, 10)).toBeLessThanOrEqual(150 - 16)
  })

  it('finds aliases in a normal search', () => {
    const official: PricePreset = {
      ...presets[0], modelId: 'deepseek/deepseek-v4.1-flash-1017',
      label: 'DeepSeek V4.1 Flash', providerLabel: 'DeepSeek', aliases: ['deepseek-flash']
    }
    const choices = [presets[1], official]
    expect(filterPricePresets(choices, 'DEEPSEEK-FLASH DeepSeek')).toEqual([official])
  })

  it('prefills the row model and selects it only once when the picker opens', async () => {
    mockApi(Promise.resolve(presets))
    Object.assign(window, {
      innerWidth: 800, innerHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn()
    })
    render()
    await Promise.resolve()
    const input = { focus: vi.fn(), select: vi.fn() }
    const menu = {
      style: { width: '', maxHeight: '', left: '', top: '' },
      matches: vi.fn(() => true),
      showPopover: vi.fn(),
      hidePopover: vi.fn()
    }
    const commit = (nodes: ReactElement<TestProps>[]) => {
      const menuNode = nodes.find(({ props }) => props.className === 'preset-picker-menu')
      if (menuNode) Object.assign(menuNode.props.ref!, { current: menu })
      const search = nodes.find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))
      if (search) Object.assign(search.props.ref!, { current: input })
    }
    openPicker(render(), {
      getBoundingClientRect: () => ({ left: 604, right: 700, top: 40, bottom: 70 })
    } as HTMLButtonElement)
    let nodes = render(commit)
    const search = () => nodes.find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!
    expect(search().props.value).toBe('custom')
    expect(input.focus).toHaveBeenCalledOnce()
    expect(input.select).toHaveBeenCalledOnce()

    // Typing changes the filtered list but must not repeat focus() or select().
    search().props.onChange!({ target: { value: 'model-1' } })
    nodes = render(commit)
    expect(search().props.value).toBe('model-1')
    expect(input.focus).toHaveBeenCalledOnce()
    expect(input.select).toHaveBeenCalledOnce()
  })

  it('renders a custom clear button only for a non-empty search and keeps the input focused', async () => {
    mockApi(Promise.resolve(presets))
    Object.assign(window, {
      innerWidth: 800, innerHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn()
    })
    render()
    await Promise.resolve()
    const input = { focus: vi.fn(), select: vi.fn() }
    const menu = {
      style: { width: '', maxHeight: '', left: '', top: '' },
      matches: vi.fn(() => true),
      showPopover: vi.fn(),
      hidePopover: vi.fn()
    }
    const commit = (nodes: ReactElement<TestProps>[]) => {
      const menuNode = nodes.find(({ props }) => props.className === 'preset-picker-menu')
      if (menuNode) Object.assign(menuNode.props.ref!, { current: menu })
      const search = nodes.find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))
      if (search) Object.assign(search.props.ref!, { current: input })
    }
    openPicker(render(), {
      getBoundingClientRect: () => ({ left: 604, right: 700, top: 40, bottom: 70 })
    } as HTMLButtonElement)
    let nodes = render(commit)
    const clear = () => nodes.find(({ props }) => props.className === 'preset-picker-clear')

    // The prefilled row model renders the custom hit area inside the search wrapper.
    expect(nodes.some(({ props }) => props.className === 'preset-picker-search-wrap')).toBe(true)
    expect(clear()?.props['aria-label']).toBe('清空搜索')
    expect(clear()?.props.tabIndex).toBe(-1)
    const icon = elements(clear()!.props.children)[0]!
    expect(icon.props.size).toBe(14)
    expect(icon.props['aria-hidden']).toBeTruthy()

    // Pointer down must not blur the input before the click clears it.
    const preventDefault = vi.fn()
    clear()!.props.onPointerDown!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()

    clear()!.props.onClick!({} as { currentTarget: HTMLButtonElement })
    nodes = render(commit)
    expect(nodes.find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!.props.value).toBe('')
    expect(clear()).toBeUndefined()
    expect(nodes.some(({ props }) => props.className === 'preset-picker-empty')).toBe(false)
    expect(input.focus).toHaveBeenCalledTimes(2)
    expect(input.select).toHaveBeenCalledOnce()
  })

  it('cancels Enter on an empty search instead of submitting the form', async () => {
    mockApi(Promise.resolve(presets))
    render()
    await Promise.resolve()
    openPicker(render())
    render().find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!
      .props.onChange!({ target: { value: 'no-match' } })
    const nodes = render()
    expect(nodes.some(({ props }) => props.className === 'preset-picker-empty')).toBe(true)
    expect(press(nodes, 'Enter')).toHaveBeenCalledOnce()
  })

  it('keeps options out of the tab order and scrolls the selected option on arrow navigation', async () => {
    mockApi(Promise.resolve(presets))
    render()
    await Promise.resolve()
    openPicker(render())
    render().find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!
      .props.onChange!({ target: { value: '' } })
    const options = presets.map(() => ({ scrollIntoView: vi.fn() }))
    const commit = (nodes: ReactElement<TestProps>[]) => {
      const candidates = nodes.filter(({ props }) => props.role === 'option')
      expect(candidates.map(({ props }) => props.tabIndex)).toEqual(presets.map(() => -1))
      const index = candidates.findIndex(({ props }) => props['aria-selected'])
      const ref = candidates[index]?.props.ref
      if (ref) ref.current = options[index]!
    }
    let nodes = render(commit)
    for (let index = 1; index <= 8; index++) {
      expect(press(nodes, 'ArrowDown')).toHaveBeenCalledOnce()
      nodes = render(commit)
      expect(options[index]!.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    }
    options[7]!.scrollIntoView.mockClear()
    expect(press(nodes, 'ArrowUp')).toHaveBeenCalledOnce()
    render(commit)
    expect(options[7]!.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('allows manual edits before presets finish and preserves those edits when presets arrive', async () => {
    let resolvePresets!: (loaded: PricePreset[]) => void
    mockApi(new Promise((resolve) => { resolvePresets = resolve }))
    render()
    await Promise.resolve()
    const rate = (nodes: ReactElement<TestProps>[]) => nodes.find(({ props }) => props['aria-label'] === 'custom 输入单价')!.props
    const trigger = (nodes: ReactElement<TestProps>[]) => nodes.find(({ props }) => props.className === 'price-preset-trigger')!.props
    let nodes = render()
    expect(trigger(nodes).disabled).toBe(true)
    expect(rate(nodes)).toMatchObject({ disabled: false, value: '1' })
    rate(nodes).onChange!({ target: { value: '5' } })
    nodes = render()
    expect(nodes.find(({ type, props }) => type === 'button' && props.className?.includes('primary-action'))?.props.disabled).toBe(false)

    resolvePresets(presets)
    await Promise.resolve()
    nodes = render()
    expect(trigger(nodes).disabled).toBe(false)
    expect(rate(nodes).value).toBe('5')
  })

  function choice(overrides: Partial<PricePreset> & Pick<PricePreset, 'modelId'>): PricePreset {
    return {
      id: `models.dev:${overrides.modelId}`,
      label: overrides.modelId,
      providerLabel: 'Provider',
      source: 'models.dev',
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 2,
      ...overrides
    }
  }

  const channels: PricePreset[] = [
    choice({ modelId: 'moonshotai/kimi-k3', providerId: 'moonshotai', providerRank: 5,
      popularity: 9, primary: true, isCanonicalOwner: true, canonicalId: 'moonshotai/kimi-k3' }),
    choice({ modelId: 'alibaba-cn/kimi-k3', providerId: 'alibaba-cn', providerRank: 16,
      popularity: 8, primary: false, canonicalId: 'moonshotai/kimi-k3' }),
    choice({ modelId: 'openrouter/kimi-k3', providerId: 'openrouter', providerRank: 23,
      popularity: 10, primary: false, canonicalId: 'moonshotai/kimi-k3' }),
    choice({ modelId: 'deepseek/deepseek-v4.1-flash-1017', providerId: 'deepseek', providerRank: 3,
      popularity: 9.5, primary: true, isCanonicalOwner: true, canonicalId: 'deepseek/deepseek-v4.1-flash-1017' }),
    choice({ modelId: 'alibaba-cn/deepseek-v4.1-flash', providerId: 'alibaba-cn', providerRank: 16,
      popularity: 9.4, primary: false, canonicalId: 'deepseek/deepseek-v4.1-flash' })
  ]

  it('collapses to primary representatives and sorts them by popularity on an empty row', () => {
    expect(filterPricePresets(channels, '').map(({ modelId }) => modelId)).toEqual([
      'deepseek/deepseek-v4.1-flash-1017', 'moonshotai/kimi-k3'
    ])
  })

  it('round-robins the first two non-derived flagships of headline vendors on an empty row', () => {
    const browse = [
      choice({ modelId: 'openai/gpt-a', providerId: 'openai', providerRank: 0,
        popularity: 10, primary: true, isCanonicalOwner: true }),
      choice({ modelId: 'openai/gpt-b', providerId: 'openai', providerRank: 0,
        popularity: 9, primary: true, isCanonicalOwner: true }),
      choice({ modelId: 'openai/gpt-a-free', providerId: 'openai', providerRank: 0,
        popularity: 99, primary: true, isCanonicalOwner: true, derived: true }),
      choice({ modelId: 'anthropic/claude-a', providerId: 'anthropic', providerRank: 1,
        popularity: 1, primary: true, isCanonicalOwner: true }),
      choice({ modelId: 'anthropic/claude-b', providerId: 'anthropic', providerRank: 1,
        popularity: 0.5, primary: true, isCanonicalOwner: true }),
      choice({ modelId: 'google/gemini-a', providerId: 'google', providerRank: 2,
        popularity: 5, primary: true, isCanonicalOwner: true }),
      choice({ modelId: 'siliconflow/some-model', providerId: 'siliconflow', providerRank: 18,
        popularity: 100, primary: true }),
    ]
    expect(filterPricePresets(browse, '').map(({ modelId }) => modelId)).toEqual([
      'openai/gpt-a', 'anthropic/claude-a', 'google/gemini-a',
      'openai/gpt-b', 'anthropic/claude-b',
      'openai/gpt-a-free', 'siliconflow/some-model'
    ])
  })

  it('matches across separators and ranks exact ids ahead of their variants', () => {
    const search = [
      choice({ modelId: 'zai/glm-5.3-flash', providerId: 'zai', providerRank: 6,
        popularity: 20, primary: true }),
      choice({ modelId: 'zai/glm-5.3', providerId: 'zai', providerRank: 6,
        popularity: 5, primary: true }),
      choice({ modelId: 'zai/glm-5.3-flashx', providerId: 'zai', providerRank: 6,
        popularity: 30, primary: true, derived: true }),
      choice({ modelId: 'anthropic/claude-opus-5-5', providerId: 'anthropic', providerRank: 1,
        popularity: 1, primary: true }),
      choice({ modelId: 'anthropic/claude-opus-5-5-fast', providerId: 'anthropic', providerRank: 1,
        popularity: 0.5, primary: true }),
      choice({ modelId: 'openai/gpt-6.2', providerId: 'openai', providerRank: 0,
        popularity: 1, primary: true }),
    ]
    expect(filterPricePresets(search, 'glm-5.3').map(({ modelId }) => modelId)).toEqual([
      'zai/glm-5.3', 'zai/glm-5.3-flash', 'zai/glm-5.3-flashx'
    ])
    expect(filterPricePresets(search, 'glm53').map(({ modelId }) => modelId)).toEqual([
      'zai/glm-5.3-flash', 'zai/glm-5.3', 'zai/glm-5.3-flashx'
    ])
    expect(filterPricePresets(search, 'opus 5.5')[0]?.modelId).toBe('anthropic/claude-opus-5-5')
    expect(filterPricePresets(search, 'opus55')[0]?.modelId).toBe('anthropic/claude-opus-5-5')
    expect(filterPricePresets(search, 'gpt6.2')[0]?.modelId).toBe('openai/gpt-6.2')
  })

  it('recalls slash queries by model name and ranks same-channel matches first', () => {
    expect(filterPricePresets(channels, 'alibaba-cn/kimi-k3').map(({ modelId }) => modelId)).toEqual([
      'alibaba-cn/kimi-k3', 'moonshotai/kimi-k3', 'openrouter/kimi-k3'
    ])
    expect(filterPricePresets(channels, 'opencsg/kimi-k3').map(({ modelId }) => modelId)).toEqual([
      'moonshotai/kimi-k3', 'alibaba-cn/kimi-k3', 'openrouter/kimi-k3'
    ])
    expect(filterPricePresets(channels, 'alibaba-cn/deepseek-v4.1-flash-1017').map(({ modelId }) => modelId)).toEqual([
      'alibaba-cn/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017'
    ])
  })

  it('strips snapshot and -free suffixes when recalling a channel model', () => {
    const picks = [
      choice({ modelId: 'opencode/deepseek-v4.1-flash', providerId: 'opencode', providerRank: 24,
        popularity: 4, primary: false, canonicalId: 'deepseek/deepseek-v4.1-flash' }),
      choice({ modelId: 'deepseek/deepseek-v4.1-flash-1017', providerId: 'deepseek', providerRank: 3,
        popularity: 9.5, primary: true, isCanonicalOwner: true, canonicalId: 'deepseek/deepseek-v4.1-flash-1017' })
    ]
    expect(filterPricePresets(picks, 'opencode/deepseek-v4.1-flash-free').map(({ modelId }) => modelId)).toEqual([
      'opencode/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017'
    ])
  })

  it('prefers primary models for a bare search and narrows a named channel', () => {
    expect(filterPricePresets(channels, 'kimi').map(({ modelId }) => modelId)).toEqual([
      'moonshotai/kimi-k3', 'openrouter/kimi-k3', 'alibaba-cn/kimi-k3'
    ])
    expect(filterPricePresets(channels, 'openrouter kimi').map(({ modelId }) => modelId)).toEqual([
      'openrouter/kimi-k3'
    ])
    expect(filterPricePresets(channels, 'alibaba-cn kimi').map(({ modelId }) => modelId)).toEqual([
      'alibaba-cn/kimi-k3'
    ])

    // Searching a token that also appears inside a gateway id (e.g. "code" in "opencode")
    // must not demote primary models below third-party resales.
    const mixed = [
      choice({ modelId: 'opencode/kimi-k3', providerId: 'opencode', providerRank: 24,
        popularity: 50, primary: false, canonicalId: 'moonshotai/kimi-k3' }),
      choice({ modelId: 'moonshotai/kimi-k2.7-code', providerId: 'moonshotai', providerRank: 5,
        popularity: 6, primary: true, isCanonicalOwner: true, canonicalId: 'moonshotai/kimi-k2.7-code' })
    ]
    expect(filterPricePresets(mixed, 'code').map(({ modelId }) => modelId)).toEqual([
      'moonshotai/kimi-k2.7-code', 'opencode/kimi-k3'
    ])
  })

  it('shows a Clock marker left of the rates for a peak preset and a switch pill on the row', async () => {
    const multipliers = [{ when: { utc_hours: { gte: '14:00' } }, factor: 0.5 }]
    const peakPreset = { ...presets[0]!, modelId: 'deepseek/deepseek-flash', multipliers }
    mockApi(Promise.resolve([peakPreset]), {
      priceOverrides: {
        'custom/deepseek': {
          inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2,
          multipliers, multipliersEnabled: false
        }
      }
    })
    render()
    await Promise.resolve()
    Object.assign(window, {
      innerWidth: 800, innerHeight: 600,
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    })
    let nodes = render()
    const rowSwitch = nodes.find(({ props }) => props.role === 'switch')
    expect(rowSwitch?.props.className).toBe('price-peak-pill')
    expect(rowSwitch?.props['aria-checked']).toBe(false)
    expect(elements(rowSwitch!.props.children)[0]!.props.size).toBe(11)
    const line = nodes.find(({ props }) => props.className === 'price-model-line')!
    expect(elements(line.props.children)[0]!.props.children).toBe('custom/deepseek')

    // Disabled switch relies on pill dimming alone and does not append `已关闭` inside the tooltip.
    rowSwitch!.props.onPointerEnter!({
      currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 100, bottom: 120 }) }
    })
    nodes = render()
    const offTipLines = elements(nodes.find(({ props }) => props.className === 'price-peak-tip')!.props.children)
      .map(({ props }) => props.children).filter((child): child is string => typeof child === 'string')
    expect(offTipLines[0]).toBe('低谷期（0.5x）')
    expect(offTipLines).not.toContain('已关闭')

    // Toggling back on is a real change the form will save.
    rowSwitch!.props.onClick!({
      currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 30 }) }
    } as unknown as { currentTarget: HTMLButtonElement })
    nodes = render()
    expect(nodes.find(({ props }) => props.role === 'switch')?.props['aria-checked']).toBe(true)
    expect(nodes.find(({ type, props }) => type === 'button' && props.className?.includes('primary-action'))?.props.disabled).toBe(false)

    // Editing custom rates recalculates the row pill tooltip with prices placed above schedule.
    nodes.find(({ props }) => props['aria-label'] === 'custom/deepseek 输入单价')!
      .props.onChange!({ target: { value: '10' } })
    nodes = render()
    nodes.find(({ props }) => props.role === 'switch')!.props.onPointerEnter!({
      currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 100, bottom: 120 }) }
    })
    nodes = render()
    const rowTipLines = elements(nodes.find(({ props }) => props.className === 'price-peak-tip')!.props.children)
      .map(({ props }) => props.children).filter((child): child is string => typeof child === 'string')
    expect(rowTipLines[0]).toBe('低谷期（0.5x）')
    expect(rowTipLines[1]).toBe('入 $5 · 出 $1')
    expect(rowTipLines).not.toContain('已关闭')

    openPicker(nodes)
    nodes = render()
    nodes.find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!
      .props.onChange!({ target: { value: '' } })
    nodes = render()
    const option = nodes.find(({ props }) => props.role === 'option')!
    const rates = elements(option.props.children).find(({ props }) => props.className === 'preset-option-rates')!
    const parts = elements(rates.props.children)
    expect(parts[0]!.props.className).toBe('preset-peak-mark')
    expect(elements(parts[0]!.props.children)[0]!.props.size).toBe(12)
    expect(parts.some(({ props }) =>
      typeof props.children === 'string' && props.children.includes('入 $3'))).toBe(true)

    parts[0]!.props.onPointerEnter!({
      stopPropagation: vi.fn(),
      currentTarget: { getBoundingClientRect: () => ({ left: 320, top: 140, bottom: 156 }) }
    })
    nodes = render()
    const presetTipLines = elements(nodes.find(({ props }) => props.className === 'preset-picker-tip')!.props.children)
      .map(({ props }) => props.children).filter((child): child is string => typeof child === 'string')
    expect(presetTipLines[0]).toBe('低谷期（0.5x）')
    expect(presetTipLines[1]).toBe('入 $1.5 · 出 $2')
    expect(presetTipLines[2]).toBeTruthy()
  })

  it('does not mark service-tier or date presets as peak or show a row switch', async () => {
    const multipliers = [
      { when: { service_tier: { equals: 'priority' } }, factor: 2 },
      { when: { date: { gte: '2026-01-01' } }, factor: 1.1 }
    ]
    mockApi(Promise.resolve([{
      ...presets[0]!, modelId: 'openai/gpt-6.2-sol', multipliers
    }]), {
      priceOverrides: {
        'openai/gpt-6.2-sol': {
          inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2,
          multipliers, multipliersEnabled: true
        }
      }
    })
    render()
    await Promise.resolve()
    let nodes = render()
    expect(nodes.some(({ props }) => props.role === 'switch')).toBe(false)
    openPicker(nodes)
    nodes = render()
    nodes.find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!
      .props.onChange!({ target: { value: '' } })
    nodes = render()
    expect(nodes.some(({ props }) => props.role === 'option')).toBe(true)
    expect(nodes.some(({ props }) => props.className === 'preset-peak-mark')).toBe(false)
  })

  it('shows the full model id only for a truncated option and clears it again', async () => {
    mockApi(Promise.resolve(presets))
    Object.assign(window, { innerWidth: 800, innerHeight: 600 })
    render()
    await Promise.resolve()
    openPicker(render())
    render().find(({ props }) => props.className?.split(' ').includes('preset-picker-search'))!
      .props.onChange!({ target: { value: '' } })
    let nodes = render()
    const tipBox = { offsetWidth: 200, offsetHeight: 18 }
    const commit = (list: ReactElement<TestProps>[]) => {
      const tip = list.find(({ props }) => props.className === 'preset-picker-tip')
      if (tip) Object.assign(tip.props.ref!, { current: tipBox })
    }
    const option = () => nodes.find(({ props }) => props.role === 'option')!
    const target = (scrollWidth: number, clientWidth: number,
      rect = { left: 20, right: 300, top: 100, bottom: 130 }) => ({
      getBoundingClientRect: () => rect,
      querySelector: () => ({ scrollWidth, clientWidth })
    })

    expect(option().props.title).toBeUndefined()
    option().props.onPointerEnter!({ currentTarget: target(900, 320) })
    nodes = render(commit)
    nodes = render(commit)
    const tip = nodes.find(({ props }) => props.className === 'preset-picker-tip')!
    expect(tip.props.role).toBe('tooltip')
    expect(tip.props.children).toBe(presets[0]!.modelId)
    expect(tip.props.style?.visibility).toBe('visible')
    // Above the option: rect.top - tipHeight - 4 = 100 - 18 - 4.
    expect(tip.props.style?.top).toBe(78)
    expect(tip.props['data-placement']).toBe('above')

    nodes.find(({ props }) => props.className === 'preset-picker-list')!.props.onScroll!()
    nodes = render()
    expect(nodes.some(({ props }) => props.className === 'preset-picker-tip')).toBe(false)

    option().props.onPointerEnter!({ currentTarget: target(900, 320) })
    nodes = render(commit)
    nodes = render(commit)
    expect(nodes.some(({ props }) => props.className === 'preset-picker-tip')).toBe(true)

    // Too close to the viewport top: flip below the option, rect.bottom + 4.
    option().props.onPointerEnter!({
      currentTarget: target(900, 320, { left: 20, right: 300, top: 10, bottom: 40 })
    })
    nodes = render(commit)
    nodes = render(commit)
    const flipped = nodes.find(({ props }) => props.className === 'preset-picker-tip')!
    expect(flipped.props.style?.top).toBe(44)
    expect(flipped.props['data-placement']).toBe('below')

    option().props.onPointerLeave!()
    nodes = render()
    expect(nodes.some(({ props }) => props.className === 'preset-picker-tip')).toBe(false)

    // A fully visible id must not show a redundant bubble.
    option().props.onPointerEnter!({ currentTarget: target(300, 300) })
    nodes = render(commit)
    nodes = render(commit)
    expect(nodes.some(({ props }) => props.className === 'preset-picker-tip')).toBe(false)
  })
})

import { ChevronDown, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { PriceOverrides, PricePreset, PricingSettings } from '../../shared/types'
import { UsageDialog } from './UsageDialog'

export const priceFields = [
  ['inputCostPerMillionTokens', '输入'],
  ['outputCostPerMillionTokens', '输出'],
  ['cacheReadCostPerMillionTokens', '缓存读取'],
  ['cacheWriteCostPerMillionTokens', '缓存创建']
] as const
export type PriceKey = (typeof priceFields)[number][0]
export type PriceRow = { id: number; model: string; rates: Partial<Record<PriceKey, string>>; isNew?: boolean }

const EFFORT_SUFFIX = /-(?:extra-low|low|medium|high|tiered|control|thinking|agent|orchestrator)$/
const SNAPSHOT_SUFFIX = /-(?:20\d{2}-\d{2}-\d{2}|20\d{6}|\d{4})$/
const FREE_SUFFIX = /-free$/i

function stripVariantSuffix(name: string): string {
  let current = name
  for (;;) {
    const next = current.replace(EFFORT_SUFFIX, '').replace(SNAPSHOT_SUFFIX, '').replace(FREE_SUFFIX, '')
    if (next === current) return current
    current = next
  }
}

function lastSegment(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

function presetProviderId(preset: PricePreset): string {
  return (preset.providerId ?? preset.modelId.slice(0, preset.modelId.indexOf('/'))).toLowerCase()
}

function presetNames(preset: PricePreset): string[] {
  return [preset.modelId, preset.canonicalId, ...(preset.aliases ?? [])]
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .map((name) => name.toLowerCase())
}

function presetPopularity(preset: PricePreset): number {
  return preset.popularity ?? 0
}

function presetRank(preset: PricePreset): number {
  return preset.providerRank ?? 999
}

// Separator-insensitive matching lets "opus 5.5" / "opus55" / "glm53" hit hyphenated ids.
const compact = (value: string): string => value.toLowerCase().replace(/[-_./\s]+/g, '')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function searchText(preset: PricePreset): { haystack: string; compactHaystack: string } {
  const fields = [
    preset.modelId, presetProviderId(preset), preset.providerLabel,
    preset.canonicalId, ...(preset.aliases ?? [])
  ].filter((value): value is string => typeof value === 'string' && value !== '')
    .map((value) => value.toLowerCase())
  return {
    haystack: fields.join(' '),
    compactHaystack: fields.map(compact).join(' ')
  }
}

function tokenMatches(token: string, haystack: string, compactHaystack: string): boolean {
  if (haystack.includes(token)) return true
  const squeezed = compact(token)
  return squeezed.length >= 2 && compactHaystack.includes(squeezed)
}

function matchesTokens(preset: PricePreset, tokens: readonly string[]): boolean {
  const { haystack, compactHaystack } = searchText(preset)
  return tokens.every((token) => tokenMatches(token, haystack, compactHaystack))
}

function searchRelevance(preset: PricePreset, normalizedQuery: string, tokens: readonly string[]): number {
  const full = preset.modelId.toLowerCase()
  const bare = lastSegment(full)
  if (full === normalizedQuery || bare === normalizedQuery) return 4
  if (bare.startsWith(normalizedQuery) || full.startsWith(normalizedQuery)) return 3
  if (tokens.every((token) => new RegExp(`(^|[-_./])${escapeRegExp(token)}`).test(full))) return 3
  const { haystack, compactHaystack } = searchText(preset)
  if (tokens.every((token) => haystack.includes(token))) return 2
  if (tokens.every((token) => tokenMatches(token, haystack, compactHaystack))) return 1
  return 0
}

function presetNameForms(preset: PricePreset): { names: string[]; bareNames: string[]; baseNames: string[] } {
  const names = presetNames(preset)
  const bareNames = [...new Set(names.flatMap((name) => [name, lastSegment(name)]))]
  const baseNames = [...new Set(bareNames.map(stripVariantSuffix))]
  return { names, bareNames, baseNames }
}

const byGroupOrder = (a: PricePreset, b: PricePreset) =>
  Number(Boolean(a.derived)) - Number(Boolean(b.derived)) ||
  presetPopularity(b) - presetPopularity(a) ||
  a.modelId.localeCompare(b.modelId)

const bySearch = (normalizedQuery: string, tokens: readonly string[]) =>
  (a: PricePreset, b: PricePreset) => (
    Number(b.primary !== false) - Number(a.primary !== false) ||
    searchRelevance(b, normalizedQuery, tokens) - searchRelevance(a, normalizedQuery, tokens) ||
    Number(Boolean(a.derived)) - Number(Boolean(b.derived)) ||
    presetPopularity(b) - presetPopularity(a) ||
    presetRank(a) - presetRank(b) ||
    a.modelId.localeCompare(b.modelId)
  )

// Empty-row browsing: spotlight the first two non-derived flagships of each
// headline vendor, then append the rest vendor by vendor.
function defaultBrowsePresets(presets: readonly PricePreset[], limit: number): PricePreset[] {
  const groups = new Map<number, PricePreset[]>()
  for (const preset of presets) {
    if (preset.primary === false) continue
    const rank = presetRank(preset)
    const list = groups.get(rank) ?? []
    list.push(preset)
    groups.set(rank, list)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a - b)
  for (const [, list] of ordered) list.sort(byGroupOrder)

  const headline = ordered.filter(([rank]) => rank < 10)
  const spotlight = headline.length > 0 ? headline : ordered
  const picked = new Set<PricePreset>()
  const result: PricePreset[] = []
  for (let round = 0; round < 2; round++) {
    for (const [, list] of spotlight) {
      const candidate = list.filter((preset) => !preset.derived)[round]
      if (!candidate || picked.has(candidate)) continue
      picked.add(candidate)
      result.push(candidate)
    }
  }
  for (const [, list] of ordered) {
    for (const preset of list) {
      if (!picked.has(preset)) result.push(preset)
    }
  }
  return result.slice(0, limit)
}

// A single `<provider>/<model>` query recalls by the model name (ignoring an
// unknown channel prefix) and scores same-channel hits first.
function filterQualifiedPresets(
  presets: readonly PricePreset[],
  normalizedQuery: string,
  limit: number
): PricePreset[] {
  const slash = normalizedQuery.indexOf('/')
  const queryProvider = normalizedQuery.slice(0, slash)
  const queryBare = lastSegment(normalizedQuery)
  const queryBase = stripVariantSuffix(queryBare)
  const scored: { preset: PricePreset; score: number }[] = []
  for (const preset of presets) {
    const { names, bareNames, baseNames } = presetNameForms(preset)
    const nameText = names.join(' ')
    const nameCompact = names.map(compact).join(' ')
    const wholeHit = matchesTokens(preset, [normalizedQuery])
    const bareHit = queryBare.length >= 2 && tokenMatches(queryBare, nameText, nameCompact)
    const baseHit = queryBase !== queryBare && queryBase.length >= 2 &&
      tokenMatches(queryBase, nameText, nameCompact)
    if (!wholeHit && !bareHit && !baseHit) continue
    const sameProvider = presetProviderId(preset) === queryProvider
    const exact = names.includes(normalizedQuery) ||
      (queryBare !== '' && (names.includes(queryBare) || bareNames.includes(queryBare)))
    const baseExact = queryBase.length >= 2 && baseNames.includes(queryBase)
    const score = sameProvider && exact ? 6
      : sameProvider && baseExact ? 5
        : sameProvider && wholeHit ? 4
          : exact ? 3
            : baseExact ? 2
              : 1
    scored.push({ preset, score })
  }
  return scored
    .sort((a, b) =>
      b.score - a.score ||
      Number(b.preset.primary !== false) - Number(a.preset.primary !== false) ||
      searchRelevance(b.preset, queryBare, [queryBare]) - searchRelevance(a.preset, queryBare, [queryBare]) ||
      Number(Boolean(a.preset.derived)) - Number(Boolean(b.preset.derived)) ||
      presetRank(a.preset) - presetRank(b.preset) ||
      presetPopularity(b.preset) - presetPopularity(a.preset) ||
      a.preset.modelId.localeCompare(b.preset.modelId))
    .slice(0, limit)
    .map(({ preset }) => preset)
}

export function filterPricePresets(
  presets: readonly PricePreset[],
  query: string,
  limit = 80
): PricePreset[] {
  const normalizedQuery = query.trim().toLowerCase()
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean)

  if (tokens.length === 0) return defaultBrowsePresets(presets, limit)
  if (tokens.length === 1 && normalizedQuery.includes('/')) {
    return filterQualifiedPresets(presets, normalizedQuery, limit)
  }

  const matched = presets.filter((preset) => matchesTokens(preset, tokens))
  return matched.sort(bySearch(normalizedQuery, tokens)).slice(0, limit)
}

function initialRows(settings: PricingSettings, initialModel?: string): PriceRow[] {
  const models = Object.keys(settings.priceOverrides).sort()
  const rows: PriceRow[] = models.map((model, id) => {
    const saved = settings.priceOverrides[model]
    return {
      id,
      model,
      rates: Object.fromEntries(priceFields.flatMap(([key]) =>
        saved?.[key] === undefined ? [] : [[key, String(saved[key])]]))
    }
  })
  if (initialModel && !models.includes(initialModel)) {
    rows.push({ id: rows.length, model: initialModel, rates: {}, isNew: true })
  }
  return rows
}

function parseRows(rows: readonly PriceRow[]): { settings: PricingSettings; error?: never } | { error: string; settings?: never } {
  const overrides = new Map<string, PriceOverrides[string]>()
  const seen = new Set<string>()
  const overrideIds = new Set<string>()
  for (const row of rows) {
    const model = row.model.trim()
    const hasRates = Object.values(row.rates).some((value) => (value ?? '').trim() !== '')
    if (!hasRates && !model) continue
    if (!model) return { error: '请输入模型 ID。' }
    if (model === '__proto__') return { error: '模型 ID 无效。' }
    if (seen.has(model)) return { error: `模型 ${model} 重复。` }
    seen.add(model)
    if (!hasRates) continue
    const rates: Partial<Record<PriceKey, number>> = {}
    if (overrideIds.has(model.toLowerCase())) return { error: `模型 ${model} 的单价重复。` }
    overrideIds.add(model.toLowerCase())
    for (const [key, label] of priceFields) {
      const raw = row.rates[key]?.trim()
      if (!raw) continue
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(Number(raw))) {
        return { error: `${model} 的${label}单价必须是非负数字。` }
      }
      rates[key] = Number(raw)
    }
    if (rates.inputCostPerMillionTokens === undefined || rates.outputCostPerMillionTokens === undefined) {
      return { error: `请为 ${model} 同时填写输入和输出单价。` }
    }
    overrides.set(model, {
      ...rates,
      inputCostPerMillionTokens: rates.inputCostPerMillionTokens,
      outputCostPerMillionTokens: rates.outputCostPerMillionTokens
    })
  }
  return { settings: { priceOverrides: Object.fromEntries(overrides) } }
}

export function applyPresetToRow(row: PriceRow, preset: PricePreset): PriceRow {
  return {
    ...row,
    model: row.model,
    rates: {
      inputCostPerMillionTokens: String(preset.inputCostPerMillionTokens),
      outputCostPerMillionTokens: String(preset.outputCostPerMillionTokens),
      cacheReadCostPerMillionTokens: preset.cacheReadCostPerMillionTokens === undefined
        ? '' : String(preset.cacheReadCostPerMillionTokens),
      cacheWriteCostPerMillionTokens: preset.cacheWriteCostPerMillionTokens === undefined
        ? '' : String(preset.cacheWriteCostPerMillionTokens)
    }
  }
}

function formatPresetRate(value: number): string {
  return `$${Number(value.toPrecision(6))}`
}

function placePresetMenu(panel: HTMLDivElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect()
  const edge = 8
  const gap = 4
  const width = Math.min(560, Math.max(0, window.innerWidth - edge * 2))
  const chromeHeight = 56
  const rowHeight = 30
  const rowGap = 2
  const maxRows = 9
  const minRows = 3
  const minMenuHeight = chromeHeight + minRows * rowHeight + (minRows - 1) * rowGap
  const below = rect.bottom + gap
  const top = Math.max(edge, Math.min(below, window.innerHeight - minMenuHeight - edge))
  const available = window.innerHeight - top - edge
  const rowsFit = Math.max(minRows, Math.min(maxRows,
    Math.floor((available - chromeHeight + rowGap) / (rowHeight + rowGap))))
  const listHeight = rowsFit * rowHeight + (rowsFit - 1) * rowGap
  const left = Math.max(edge, Math.min(rect.right - width, window.innerWidth - width - edge))
  const menuMaxHeight = Math.min(chromeHeight + listHeight, Math.max(0, window.innerHeight - edge * 2))
  const listMaxHeight = Math.max(0, menuMaxHeight - chromeHeight)
  const list = panel.querySelector?.<HTMLElement>(".preset-picker-list")
  if (list) list.style.maxHeight = `${listMaxHeight}px`
  panel.style.width = `${width}px`
  panel.style.maxHeight = `${menuMaxHeight}px`
  panel.style.left = `${left}px`
  panel.style.top = `${top}px`
}

type PresetTip = {
  text: string
  rect: { left: number; top: number; bottom: number }
  below: boolean
  left?: number
  top?: number
}

export function PriceOverridesDialog({ initialModel, models, onClose, onSaved }: {
  initialModel?: string; models: readonly string[]; onClose: () => void; onSaved: () => void
}) {
  const [rows, setRows] = useState<PriceRow[] | null>(null)
  const [presets, setPresets] = useState<PricePreset[]>([])
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [changed, setChanged] = useState(false)
  const [pickerRowId, setPickerRowId] = useState<number | null>(null)
  const [presetQuery, setPresetQuery] = useState('')
  const [activePreset, setActivePreset] = useState(0)
  const [presetTip, setPresetTip] = useState<PresetTip | null>(null)
  const nextId = useRef(0)
  const focusRow = useRef<number | null>(null)
  const pickerAnchor = useRef<HTMLButtonElement | null>(null)
  const presetMenu = useRef<HTMLDivElement>(null)
  const activePresetOption = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const presetTipRef = useRef<HTMLSpanElement>(null)
  const selectSearchOnOpen = useRef(false)
  const tableWrap = useRef<HTMLDivElement>(null)
  const dialogBody = useRef<HTMLDivElement>(null)
  const listId = useId()
  const presetMenuId = useId()

  useEffect(() => {
    let active = true
    const api = typeof window !== 'undefined' ? window.usageApi : undefined
    if (!api) return
    api.getPricingSettings().then((settings) => {
      if (!active) return
      const next = initialRows(settings, initialModel)
      nextId.current = next.length
      if (initialModel) focusRow.current = next.find((row) => row.model === initialModel)?.id ?? null
      setRows(next)
    }).catch(() => { if (active) setLoadFailed(true) })
    setPresets([])
    api.getPricePresets?.().then((loadedPresets) => {
      if (active) setPresets(loadedPresets)
    }).catch(() => { /* Manual pricing remains available without presets. */ })
    return () => { active = false }
  }, [initialModel, loadAttempt])

  const filteredPresets = useMemo(
    () => filterPricePresets(presets, presetQuery),
    [presets, presetQuery]
  )

  useEffect(() => {
    setActivePreset(0)
  }, [presetQuery, pickerRowId])

  const closePicker = useCallback((restoreFocus = true) => {
    if (presetMenu.current?.matches(':popover-open')) {
      presetMenu.current.hidePopover()
    }
    setPickerRowId(null)
    setPresetQuery('')
    setPresetTip(null)
    if (restoreFocus) pickerAnchor.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const panel = presetMenu.current
    const anchor = pickerAnchor.current
    if (pickerRowId === null || !panel || !anchor) return
    if (!panel.matches(':popover-open')) panel.showPopover()
    placePresetMenu(panel, anchor)
    searchInput.current?.focus()
    if (selectSearchOnOpen.current) {
      selectSearchOnOpen.current = false
      searchInput.current?.select()
    }
    const clearTip = () => setPresetTip(null)
    const reposition = () => {
      clearTip()
      if (!panel.matches(':popover-open') || !pickerAnchor.current) return
      placePresetMenu(panel, pickerAnchor.current)
    }
    const scroller = tableWrap.current
    const bodyScroller = dialogBody.current
    window.addEventListener('resize', reposition)
    window.addEventListener('blur', clearTip)
    scroller?.addEventListener('scroll', reposition, { passive: true })
    bodyScroller?.addEventListener('scroll', reposition, { passive: true })
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('blur', clearTip)
      scroller?.removeEventListener('scroll', reposition)
      bodyScroller?.removeEventListener('scroll', reposition)
    }
  }, [pickerRowId])

  useLayoutEffect(() => {
    if (pickerRowId !== null) activePresetOption.current?.scrollIntoView({ block: 'nearest' })
  }, [activePreset, pickerRowId, filteredPresets])

  useLayoutEffect(() => {
    const tip = presetTipRef.current
    if (!presetTip || !tip) return
    const tipWidth = tip.offsetWidth
    const tipHeight = tip.offsetHeight
    const left = Math.round(Math.min(
      Math.max(8, presetTip.rect.left),
      Math.max(8, window.innerWidth - tipWidth - 8)
    ))
    const below = presetTip.rect.top - tipHeight - 4 < 8
    const top = Math.round(below ? presetTip.rect.bottom + 4 : presetTip.rect.top - tipHeight - 4)
    if (presetTip.left !== left || presetTip.top !== top || presetTip.below !== below) {
      setPresetTip((current) => current?.text === presetTip.text ? { ...current, left, top, below } : current)
    }
  }, [presetTip])

  function edit(id: number, update: (row: PriceRow) => PriceRow) {
    setRows((list) => list?.map((row) => row.id === id ? update(row) : row) ?? null)
    setChanged(true)
    setError('')
  }
  function addRow() {
    const id = nextId.current++
    focusRow.current = id
    setRows((list) => [...(list ?? []), { id, model: '', rates: {}, isNew: true }])
  }
  function removeRow(row: PriceRow) {
    if (pickerRowId === row.id) closePicker(false)
    setRows((list) => list?.filter(({ id }) => row.id !== id) ?? null)
    if (!row.isNew) setChanged(true)
    setError('')
  }
  function openPicker(row: PriceRow, button: HTMLButtonElement) {
    if (pickerRowId === row.id && presetMenu.current?.matches(':popover-open')) {
      closePicker()
      return
    }
    const initialQuery = row.model.trim()
    pickerAnchor.current = button
    selectSearchOnOpen.current = initialQuery !== ''
    setPresetTip(null)
    setPresetQuery(initialQuery)
    setActivePreset(0)
    setPickerRowId(row.id)
  }
  function selectPreset(preset: PricePreset) {
    if (pickerRowId === null) return
    edit(pickerRowId, (row) => applyPresetToRow(row, preset))
    closePicker()
  }
  function onPresetKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePicker()
      return
    }
    if (event.key === 'Enter') event.preventDefault()
    if (filteredPresets.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActivePreset((index) => (index + 1) % filteredPresets.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActivePreset((index) => (index + filteredPresets.length - 1) % filteredPresets.length)
    } else if (event.key === 'Enter') {
      const chosen = filteredPresets[activePreset] ?? filteredPresets[0]
      if (chosen) selectPreset(chosen)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (rows === null || saving || !changed) return
    const result = parseRows(rows)
    if (result.error !== undefined) { setError(result.error); return }
    setSaving(true)
    setError('')
    try {
      await window.usageApi.savePricingSettings(result.settings)
    } catch {
      setSaving(false)
      setError('保存失败，请重试。')
      return
    }
    onSaved()
  }

  return (
    <UsageDialog title="自定义模型价格" wide busy={saving} onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => void save(event)} aria-busy={saving}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape' || !presetMenu.current?.matches(':popover-open')) return
          event.preventDefault()
          event.stopPropagation()
          closePicker()
        }}>
        <div className="dialog-body price-dialog-body" ref={dialogBody}>
          {rows === null ? (
            <div className="price-placeholder">
              {loadFailed ? <><span role="alert">无法读取模型价格设置。</span><button className="action-button" type="button"
                onClick={() => { setLoadFailed(false); setLoadAttempt((n) => n + 1) }}>重试</button></>
                : <span role="status">正在读取设置…</span>}
            </div>
          ) : (
            <>
              <div className="price-table-toolbar">
                <button type="button" className="action-button" disabled={saving} onClick={addRow}>
                  <Plus size={14} aria-hidden="true" />添加模型
                </button>
                <span>美元 / 百万 token</span>
              </div>
              <div className="price-table-wrap" ref={tableWrap}>
                <table className="price-table" aria-label="自定义模型价格">
                  <colgroup>
                    <col className="price-model-col" />
                    {priceFields.map(([key]) => <col key={key} />)}
                    <col className="price-preset-col" />
                    <col className="price-delete-col" />
                  </colgroup>
                  <thead><tr>
                    <th scope="col">模型 ID</th>
                    {priceFields.map(([key, label]) => <th key={key} scope="col">{label}</th>)}
                    <th scope="col">预设</th>
                    <th scope="col"><span className="sr-only">移除模型</span></th>
                  </tr></thead>
                  <tbody>
                    {rows.length === 0 && <tr><td className="empty-cell" colSpan={7}>暂无自定义模型价格</td></tr>}
                    {rows.map((row) => {
                      const model = row.model || '新模型'
                      const pickingHere = pickerRowId === row.id
                      return (
                        <tr key={row.id}>
                          <td>{row.isNew ? <input className="price-field" aria-label="模型 ID"
                            placeholder="模型 ID" value={row.model} list={listId} spellCheck={false} disabled={saving}
                            ref={(node) => { if (node && focusRow.current === row.id && !row.model) { node.focus(); focusRow.current = null } }}
                            onChange={(event) => edit(row.id, (item) => ({ ...item, model: event.target.value }))} />
                            : <span className="wrap-anywhere">{row.model}</span>}</td>
                          {priceFields.map(([key, label], index) => (
                            <td key={key}><input className="price-field" aria-label={`${model} ${label}单价`}
                              placeholder={index < 2 ? '—' : '可选'} inputMode="decimal" disabled={saving} value={row.rates[key] ?? ''}
                              ref={(node) => { if (node && index === 0 && focusRow.current === row.id) { node.focus(); focusRow.current = null } }}
                              onChange={(event) => edit(row.id, (item) => ({ ...item, rates: { ...item.rates, [key]: event.target.value } }))} /></td>
                          ))}
                          <td>
                            <button type="button" className="price-preset-trigger" disabled={saving || presets.length === 0}
                              aria-haspopup="listbox" aria-controls={presetMenuId} aria-expanded={pickingHere}
                              onClick={(event) => openPicker(row, event.currentTarget)}>
                              <span>选择预设</span>
                              <ChevronDown size={13} aria-hidden="true" />
                            </button>
                          </td>
                          <td><button type="button" className="icon-button" aria-label={`移除 ${model}`} title={`移除 ${model}`}
                            disabled={saving} onClick={() => removeRow(row)}><X size={15} aria-hidden="true" /></button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div ref={presetMenu} id={presetMenuId} popover="auto" className="preset-picker-menu"
                role="dialog" aria-label="选择模型价格预设"
                onKeyDown={onPresetKeyDown}
                onToggle={(event) => {
                  if (!event.currentTarget.matches(':popover-open')) {
                    setPickerRowId(null)
                    setPresetQuery('')
                    setPresetTip(null)
                  }
                }}>
                <div className="preset-picker-search-wrap">
                  <input ref={searchInput} type="search" className="price-field preset-picker-search"
                    aria-label="搜索预设模型" placeholder="搜索模型或厂商，如 deepseek / opus / qwen…"
                    value={presetQuery} spellCheck={false}
                    onChange={(event) => { setPresetTip(null); setPresetQuery(event.target.value) }} />
                  {presetQuery !== '' && (
                    <button type="button" className="preset-picker-clear" aria-label="清空搜索" tabIndex={-1}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => { setPresetTip(null); setPresetQuery(''); searchInput.current?.focus() }}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="preset-picker-list" role="listbox" aria-label="预设价格列表"
                  onScroll={() => setPresetTip(null)}
                  onPointerLeave={() => setPresetTip(null)}>
                  {filteredPresets.length === 0 ? (
                    <p className="preset-picker-empty">未找到匹配的模型预设</p>
                  ) : filteredPresets.map((preset, index) => {
                    const rateSummary = [
                      `入 ${formatPresetRate(preset.inputCostPerMillionTokens)}`,
                      `出 ${formatPresetRate(preset.outputCostPerMillionTokens)}`,
                      ...(preset.cacheReadCostPerMillionTokens === undefined ? [] : [`读 ${formatPresetRate(preset.cacheReadCostPerMillionTokens)}`]),
                      ...(preset.cacheWriteCostPerMillionTokens === undefined ? [] : [`创 ${formatPresetRate(preset.cacheWriteCostPerMillionTokens)}`])
                    ].join(' · ')
                    return (
                      <button key={preset.id} type="button" role="option" aria-selected={index === activePreset}
                        tabIndex={-1} ref={index === activePreset ? activePresetOption : undefined}
                        className="preset-picker-option" data-active={index === activePreset}
                        onPointerEnter={(event) => {
                          setActivePreset(index)
                          const strong = event.currentTarget.querySelector<HTMLElement>('.preset-option-main strong')
                          if (!strong || strong.scrollWidth <= strong.clientWidth) {
                            setPresetTip(null)
                            return
                          }
                          setPresetTip({
                            text: preset.modelId,
                            rect: event.currentTarget.getBoundingClientRect(),
                            below: false
                          })
                        }}
                        onPointerLeave={() => setPresetTip(null)}
                        onClick={() => selectPreset(preset)}>
                        <span className="preset-option-main">
                          <strong>{preset.modelId}</strong>
                        </span>
                        <span className="preset-option-rates">{rateSummary}</span>
                      </button>
                    )
                  })}
                </div>
                {presetTip && (
                  <span ref={presetTipRef} className="preset-picker-tip" role="tooltip"
                    data-placement={presetTip.below ? 'below' : 'above'}
                    style={{
                      left: presetTip.left ?? Math.max(8, presetTip.rect.left),
                      top: presetTip.top ?? Math.max(8, presetTip.rect.top),
                      visibility: presetTip.left === undefined ? 'hidden' : 'visible'
                    }}>
                    {presetTip.text}
                  </span>
                )}
              </div>
              <datalist id={listId}>
                {[...new Set([...models, ...rows.filter((row) => !row.isNew).map((row) => row.model)])].sort()
                  .map((name) => <option key={name} value={name} />)}
              </datalist>
              {error && <p role="alert" className="text-sm text-error">{error}</p>}
            </>
          )}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="action-button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="action-button primary-action" disabled={saving || rows === null || !changed}>
            {saving ? '正在保存…' : '保存'}
          </button>
        </footer>
      </form>
    </UsageDialog>
  )
}

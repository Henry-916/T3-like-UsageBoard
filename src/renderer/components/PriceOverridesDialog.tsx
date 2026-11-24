import { Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { PriceOverrides, PricingSettings } from '../../shared/types'
import { UsageDialog } from './UsageDialog'

const priceFields = [
  ['inputCostPerMillionTokens', '输入'],
  ['outputCostPerMillionTokens', '输出'],
  ['cacheReadCostPerMillionTokens', '缓存读取'],
  ['cacheWriteCostPerMillionTokens', '缓存写入']
] as const
type PriceKey = (typeof priceFields)[number][0]
type Row = { id: number; model: string; alias: string; rates: Partial<Record<PriceKey, string>>; isNew?: boolean }

function initialRows(settings: PricingSettings, initialModel?: string): Row[] {
  const models = [...new Set([...Object.keys(settings.priceOverrides), ...Object.keys(settings.modelAliases)])].sort()
  const rows: Row[] = models.map((model, id) => {
    const saved = Object.hasOwn(settings.priceOverrides, model) ? settings.priceOverrides[model] : undefined
    return {
      id, model, alias: Object.hasOwn(settings.modelAliases, model) ? settings.modelAliases[model] : '',
      rates: Object.fromEntries(priceFields.flatMap(([key]) =>
        saved?.[key] === undefined ? [] : [[key, String(saved[key])]]))
    }
  })
  if (initialModel && !models.includes(initialModel)) rows.push({ id: rows.length, model: initialModel, alias: '', rates: {}, isNew: true })
  return rows
}

function parseRows(rows: readonly Row[]): { settings: PricingSettings; error?: never } | { error: string; settings?: never } {
  const overrides = new Map<string, PriceOverrides[string]>()
  const aliases = new Map<string, string>()
  const seen = new Set<string>()
  const overrideIds = new Set<string>()
  for (const row of rows) {
    const model = row.model.trim()
    const alias = row.alias.trim()
    const hasRates = Object.values(row.rates).some((value) => value.trim() !== '')
    if (!alias && !hasRates && !model) continue
    if (!model) return { error: '请输入模型 ID。' }
    if (model === '__proto__' || alias === '__proto__') return { error: '模型 ID 或映射目标无效。' }
    if (seen.has(model)) return { error: `模型 ${model} 重复。` }
    seen.add(model)
    if (alias) aliases.set(model, alias)
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
    overrides.set(model, { ...rates, inputCostPerMillionTokens: rates.inputCostPerMillionTokens,
      outputCostPerMillionTokens: rates.outputCostPerMillionTokens })
  }
  for (const model of aliases.keys()) {
    const path = new Set<string>()
    let target: string | undefined = model
    while (target !== undefined) {
      if (path.has(target)) return { error: `${model} 的模型映射存在循环。` }
      path.add(target)
      target = aliases.get(target)
    }
  }
  return { settings: { priceOverrides: Object.fromEntries(overrides), modelAliases: Object.fromEntries(aliases) } }
}

export function PriceOverridesDialog({ initialModel, models, onClose, onSaved }: {
  initialModel?: string; models: readonly string[]; onClose: () => void; onSaved: () => void
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [changed, setChanged] = useState(false)
  const nextId = useRef(0)
  const focusRow = useRef<number | null>(null)
  const listId = useId()

  useEffect(() => {
    let active = true
    window.usageApi.getPricingSettings().then((settings) => {
      if (!active) return
      const next = initialRows(settings, initialModel)
      nextId.current = next.length
      if (initialModel) focusRow.current = next.find((row) => row.model === initialModel)?.id ?? null
      setRows(next)
    }).catch(() => { if (active) setLoadFailed(true) })
    return () => { active = false }
  }, [initialModel, loadAttempt])

  function edit(id: number, update: (row: Row) => Row) {
    setRows((list) => list?.map((row) => row.id === id ? update(row) : row) ?? null)
    setChanged(true)
    setError('')
  }
  function addRow() {
    const id = nextId.current++
    focusRow.current = id
    setRows((list) => [...(list ?? []), { id, model: '', alias: '', rates: {}, isNew: true }])
  }
  function removeRow(row: Row) {
    setRows((list) => list?.filter(({ id }) => row.id !== id) ?? null)
    if (!row.isNew) setChanged(true)
    setError('')
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
      <form className="dialog-form" onSubmit={(event) => void save(event)} aria-busy={saving}>
        <div className="dialog-body price-dialog-body">
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
              <div className="price-table-wrap">
                <table className="price-table" aria-label="模型价格与映射">
                  <colgroup><col className="price-model-col" /><col className="price-alias-col" />
                    {priceFields.map(([key]) => <col key={key} />)}<col className="price-delete-col" />
                  </colgroup>
                  <thead><tr>
                    <th scope="col">模型 ID</th><th scope="col">映射到</th>
                    {priceFields.map(([key, label]) => <th key={key} scope="col">{label}</th>)}
                    <th scope="col"><span className="sr-only">移除模型</span></th>
                  </tr></thead>
                  <tbody>
                    {rows.length === 0 && <tr><td className="empty-cell" colSpan={7}>暂无自定义价格或映射</td></tr>}
                    {rows.map((row) => {
                      const model = row.model || '新模型'
                      return (
                        <tr key={row.id}>
                          <td>{row.isNew ? <input className="price-field" aria-label="模型 ID"
                            placeholder="模型 ID" value={row.model} list={listId} spellCheck={false} disabled={saving}
                            ref={(node) => { if (node && focusRow.current === row.id && !row.model) { node.focus(); focusRow.current = null } }}
                            onChange={(event) => edit(row.id, (item) => ({ ...item, model: event.target.value }))} />
                            : <span className="wrap-anywhere">{row.model}</span>}</td>
                          <td><input className="price-field" aria-label={`${model} 映射到`} placeholder="可选"
                            value={row.alias} list={listId} spellCheck={false} disabled={saving}
                            ref={(node) => {
                              if (node && row.alias && focusRow.current === row.id) {
                                node.focus()
                                focusRow.current = null
                              }
                            }}
                            onChange={(event) => edit(row.id, (item) => ({ ...item, alias: event.target.value }))} /></td>
                          {row.alias.trim() !== '' ? <td colSpan={priceFields.length} className="text-subtle">按目标模型计价</td> :
                            priceFields.map(([key, label], index) => (
                              <td key={key}><input className="price-field" aria-label={`${model} ${label}单价`}
                                placeholder={index < 2 ? '—' : '可选'} inputMode="decimal" disabled={saving} value={row.rates[key] ?? ''}
                                ref={(node) => { if (node && index === 0 && focusRow.current === row.id) { node.focus(); focusRow.current = null } }}
                                onChange={(event) => edit(row.id, (item) => ({ ...item, rates: { ...item.rates, [key]: event.target.value } }))} /></td>
                            ))}
                          <td><button type="button" className="icon-button" aria-label={`移除 ${model}`} title={`移除 ${model}`}
                            disabled={saving} onClick={() => removeRow(row)}><X size={15} aria-hidden="true" /></button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
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

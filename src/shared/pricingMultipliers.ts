import type { RateCondition, RateMultiplier, UtcDay } from './types'

const DAY_ORDER: readonly UtcDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_LABELS: Record<UtcDay, string> = {
  mon: '周一', tue: '周二', wed: '周三', thu: '周四', fri: '周五', sat: '周六', sun: '周日'
}
const DAY_INDEX: Record<UtcDay, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

function clockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null
  return hours * 60 + minutes
}

function formatClock(minutes: number): string {
  const bounded = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`
}

function utcDayAt(timestampMs: number): UtcDay {
  return DAY_ORDER[(new Date(timestampMs).getUTCDay() + 6) % 7]
}

function utcDateAt(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10)
}

function minutesAt(timestampMs: number): number {
  const date = new Date(timestampMs)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}

function matchHours(window: { gte?: string; lt?: string }, minutes: number): boolean {
  const start = window.gte === undefined ? 0 : clockMinutes(window.gte)
  const end = window.lt === undefined ? 1440 : clockMinutes(window.lt)
  if (start === null || end === null) return false
  // A window whose start is not before its end (for example 22:00–08:00) wraps midnight.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

function matchDate(window: { gte?: string; lt?: string; in?: string[] }, date: string): boolean {
  if (window.in?.length) return window.in.includes(date)
  if (window.gte !== undefined && date < window.gte) return false
  if (window.lt !== undefined && date >= window.lt) return false
  return true
}

function tierMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true
  // A fast turn bills at the provider's priority (or explicitly fast) tier.
  return (expected === 'fast' && actual === 'priority') || (expected === 'priority' && actual === 'fast')
}

function matchServiceTier(window: { equals?: string; in?: string[] }, tier: string | undefined): boolean | null {
  if (tier === undefined) return null
  if (window.equals !== undefined) return tierMatches(window.equals, tier)
  if (window.in?.length) return window.in.some((value) => tierMatches(value, tier))
  return null
}

function allResults(parts: readonly (boolean | null)[]): boolean | null {
  if (parts.some((part) => part === false)) return false
  if (parts.some((part) => part === true)) return true
  return parts.length === 0 ? null : null
}

function anyResults(parts: readonly (boolean | null)[]): boolean | null {
  if (parts.some((part) => part === true)) return true
  if (parts.some((part) => part === null)) return null
  return false
}

/** null means the condition cannot be decided offline (for example a region or holiday rule). */
function matchCondition(condition: RateCondition, timestampMs: number, serviceTier: string | undefined): boolean | null {
  const parts: (boolean | null)[] = []
  if (condition.utc_days) {
    parts.push(condition.utc_days.in.includes(utcDayAt(timestampMs)))
  }
  if (condition.utc_hours) {
    parts.push(matchHours(condition.utc_hours, minutesAt(timestampMs)))
  }
  if (condition.date) {
    parts.push(matchDate(condition.date, utcDateAt(timestampMs)))
  }
  if (condition.service_tier) {
    parts.push(matchServiceTier(condition.service_tier, serviceTier))
  }
  if (condition.all) {
    parts.push(allResults(condition.all.map((child) => matchCondition(child, timestampMs, serviceTier))))
  }
  if (condition.any) {
    parts.push(anyResults(condition.any.map((child) => matchCondition(child, timestampMs, serviceTier))))
  }
  if (condition.not) {
    const child = matchCondition(condition.not, timestampMs, serviceTier)
    parts.push(child === null ? null : !child)
  }
  return allResults(parts)
}

function applies(condition: RateCondition, timestampMs: number, serviceTier: string | undefined): boolean {
  return matchCondition(condition, timestampMs, serviceTier) === true
}

export function multiplierFactor(
  rules: readonly RateMultiplier[] | undefined,
  timestampMs: number | undefined,
  serviceTier?: string
): number {
  if (!rules?.length || timestampMs === undefined || !Number.isFinite(timestampMs)) return 1
  let factor = 1
  for (const rule of rules) {
    if (applies(rule.when, timestampMs, serviceTier)) factor *= rule.factor
  }
  return factor
}

export function scaleTokenRates<T extends {
  input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number
}>(rates: T, factor: number): T {
  if (factor === 1) return rates
  return {
    ...rates,
    input: rates.input * factor,
    output: rates.output * factor,
    cacheRead: rates.cacheRead * factor,
    cacheWrite: rates.cacheWrite * factor,
    ...(rates.cacheWrite1h === undefined ? {} : { cacheWrite1h: rates.cacheWrite1h * factor })
  }
}

const CONDITION_KEYS = new Set([
  'utc_days', 'utc_hours', 'date', 'service_tier', 'all', 'any', 'not'
])
// A rule we cannot evaluate offline can never be assumed to apply. Treat it as
// unsatisfiable so a region-only surcharge never lands on every user.
const UNSATISFIABLE = Symbol('unsatisfiable')
type NormalizedCondition = RateCondition | null | typeof UNSATISFIABLE

/** Only holiday exclusions (lunar calendar shifts) are safe to ignore. */
function ignoredNot(raw: unknown): boolean {
  const row = asRecord(raw)
  if (!row) return false
  const keys = Object.keys(row)
  return keys.length > 0 && keys.every((key) => key === 'holiday')
}

function normalizeCondition(raw: unknown): NormalizedCondition {
  const row = asRecord(raw)
  if (!row) return null
  if (Object.keys(row).some((key) => !CONDITION_KEYS.has(key))) return UNSATISFIABLE
  const result: RateCondition = {}
  const days = asRecord(row.utc_days)
  if (days && Array.isArray(days.in)) {
    const valid = days.in
      .filter((day): day is string => typeof day === 'string')
      .map((day) => day.trim().toLowerCase().slice(0, 3))
      .filter((day): day is UtcDay => DAY_ORDER.includes(day as UtcDay))
    if (valid.length) result.utc_days = { in: [...new Set(valid)] }
  }
  const hours = asRecord(row.utc_hours)
  if (hours) {
    const gte = clockMinutes(hours.gte)
    const lt = clockMinutes(hours.lt)
    if ((gte !== null && gte < 1440) || (lt !== null && lt <= 1440)) {
      result.utc_hours = {
        ...(gte !== null && gte < 1440 ? { gte: formatClock(gte) } : {}),
        ...(lt !== null ? { lt: lt === 1440 ? '24:00' : formatClock(lt) } : {})
      }
    }
  }
  const date = asRecord(row.date)
  if (date) {
    const window: { gte?: string; lt?: string; in?: string[] } = {}
    if (typeof date.gte === 'string' && date.gte.trim()) window.gte = date.gte.trim()
    if (typeof date.lt === 'string' && date.lt.trim()) window.lt = date.lt.trim()
    if (Array.isArray(date.in)) {
      const values = date.in.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      if (values.length) window.in = values
    }
    if (Object.keys(window).length) result.date = window
  }
  const tier = asRecord(row.service_tier)
  if (tier) {
    const window: { equals?: string; in?: string[] } = {}
    if (typeof tier.equals === 'string' && tier.equals.trim()) window.equals = tier.equals.trim()
    if (Array.isArray(tier.in)) {
      const values = tier.in.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      if (values.length) window.in = values
    }
    if (Object.keys(window).length) result.service_tier = window
  }
  if (Array.isArray(row.all)) {
    const children: RateCondition[] = []
    for (const item of row.all) {
      const child = normalizeCondition(item)
      if (child === UNSATISFIABLE) return UNSATISFIABLE
      if (child !== null) children.push(child)
    }
    if (children.length) result.all = children
  }
  if (Array.isArray(row.any)) {
    const children: RateCondition[] = []
    let satisfiable = false
    for (const item of row.any) {
      const child = normalizeCondition(item)
      if (child === UNSATISFIABLE) continue
      satisfiable = true
      if (child !== null) children.push(child)
    }
    // Every alternative is an unevaluable branch, so the union can never apply.
    if (!satisfiable) return UNSATISFIABLE
    if (children.length) result.any = children
  }
  if (row.not !== undefined && !ignoredNot(row.not)) {
    const not = normalizeCondition(row.not)
    if (not === UNSATISFIABLE) return UNSATISFIABLE
    if (not !== null) result.not = not
  }
  // A rule that only carries conditions we cannot evaluate offline is not a pricing rule.
  return Object.keys(result).length ? result : null
}

function normalizeFactor(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  const row = asRecord(raw)
  if (!row) return null
  const text = row.text
  if (typeof text === 'number' && Number.isFinite(text) && text > 0) return text
  return null
}

export function normalizeMultipliers(raw: unknown): RateMultiplier[] {
  if (!Array.isArray(raw)) return []
  const result: RateMultiplier[] = []
  for (const item of raw) {
    const row = asRecord(item)
    if (!row) continue
    const factor = normalizeFactor(row.factor)
    const when = normalizeCondition(row.when)
    if (factor === null || when === null || when === UNSATISFIABLE) continue
    result.push({ when, factor })
  }
  return result
}

export function sameMultipliers(a: readonly RateMultiplier[], b: readonly RateMultiplier[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

interface Window {
  days: readonly UtcDay[] | null
  start: number
  end: number
}

interface TimeShape {
  days: readonly UtcDay[] | null
  windows: Window[] | null
}

function hoursWindow(hours: { gte?: string; lt?: string }): Window[] {
  const start = hours.gte === undefined ? 0 : clockMinutes(hours.gte)
  const end = hours.lt === undefined ? 1440 : clockMinutes(hours.lt)
  if (start === null || end === null) return []
  if (start <= end) return [{ days: null, start, end }]
  return [
    { days: null, start, end: 1440 },
    { days: null, start: 0, end }
  ]
}

function combineTimeShapes(base: TimeShape, child: TimeShape): TimeShape | null {
  const days = base.days === null ? child.days
    : child.days === null ? base.days
      : base.days.filter((day) => child.days!.includes(day))
  if (days !== null && days.length === 0) return { days, windows: [] }
  const windows: Window[] = []
  for (const left of base.windows ?? [{ start: 0, end: 1440 }]) {
    for (const right of child.windows ?? [{ start: 0, end: 1440 }]) {
      const start = Math.max(left.start, right.start)
      const end = Math.min(left.end, right.end)
      if (start < end) windows.push({ days, start, end })
    }
  }
  return { days, windows }
}

function timeShape(condition: RateCondition): TimeShape | null {
  if (condition.not || condition.date || condition.service_tier) return null
  let shape: TimeShape = {
    days: condition.utc_days?.in ?? null,
    windows: condition.utc_hours ? hoursWindow(condition.utc_hours) : null
  }
  if (condition.all) {
    for (const child of condition.all) {
      const childShape = timeShape(child)
      if (!childShape) return null
      const combined = combineTimeShapes(shape, childShape)
      if (!combined) return null
      shape = combined
    }
  }
  if (condition.any) {
    const windows: Window[] = []
    const baseWindows = shape.windows ?? [{ start: 0, end: 1440 }]
    for (const child of condition.any) {
      const childShape = timeShape(child)
      if (!childShape) return null
      const childDays = childShape.days === null ? shape.days
        : shape.days === null ? childShape.days
          : shape.days.filter((day) => childShape.days!.includes(day))
      for (const baseWindow of baseWindows) {
        for (const window of childShape.windows ?? [{ start: 0, end: 1440 }]) {
          const start = Math.max(baseWindow.start, window.start)
          const end = Math.min(baseWindow.end, window.end)
          if (start < end) windows.push({ days: childDays, start, end })
        }
      }
    }
    shape = { days: shape.days, windows }
  }
  if (shape.days === null && shape.windows === null) return null
  return shape
}

export function timeZoneOffsetMinutes(timeZone: string, atMs = Date.now()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(atMs))
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')
    const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
    return Math.round((asUtc - atMs) / MINUTE_MS)
  } catch {
    return 0
  }
}

function localWindow(window: Window, offset: number): { start: number; end: number; fullDay: boolean } {
  const start = ((window.start + offset) % 1440 + 1440) % 1440
  const end = ((window.end + offset) % 1440 + 1440) % 1440
  return { start, end, fullDay: window.start === 0 && window.end === 1440 }
}

function localDays(days: readonly UtcDay[] | null, window: Window, offset: number): readonly UtcDay[] | null {
  if (days === null) return null
  const shift = Math.floor((window.start + offset) / 1440)
  return [...new Set(days.map((day) => DAY_ORDER[(DAY_INDEX[day] + 6 + shift) % 7]))]
}

interface LocalInterval {
  start: number
  end: number
  days: readonly UtcDay[] | null
  fullDay: boolean
}

function sortDays(days: readonly UtcDay[]): UtcDay[] {
  return [...days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
}

function sameDaySet(a: readonly UtcDay[], b: readonly UtcDay[]): boolean {
  return a.length === b.length && a.every((day, index) => day === b[index])
}

function shiftDays(days: readonly UtcDay[], delta: number): UtcDay[] {
  return sortDays(days.map((day) => DAY_ORDER[(DAY_ORDER.indexOf(day) + delta + 7) % 7]))
}

function collectLocalIntervals(
  rules: readonly RateMultiplier[],
  offset: number
): Map<number, LocalInterval[]> {
  const groups = new Map<number, LocalInterval[]>()
  for (const rule of rules) {
    const shape = timeShape(rule.when)
    if (!shape) continue
    const windows = shape.windows ?? [{ days: shape.days, start: 0, end: 1440 }]
    const intervals = groups.get(rule.factor) ?? []
    for (const window of windows) {
      const local = localWindow(window, offset)
      if (!local.fullDay && local.start === local.end) continue
      const days = localDays(window.days ?? shape.days, window, offset)
      intervals.push({
        start: local.start,
        end: local.end,
        days: days === null || days.length === 7 ? null : sortDays(days),
        fullDay: local.fullDay
      })
    }
    groups.set(rule.factor, intervals)
  }
  return groups
}

/**
 * Find the local day set a group of windows is anchored to. A range that
 * crosses midnight produces continuation windows one local day later; those
 * are accepted as long as every set is the base set or its next-day shift.
 */
function dayMode(intervals: readonly LocalInterval[]): { days: readonly UtcDay[] | null } | null {
  const explicit = intervals
    .map((interval) => interval.days)
    .filter((days): days is readonly UtcDay[] => days !== null)
  if (!explicit.length) return { days: null }
  // A window that applies every day cannot be merged into a weekday-only schedule.
  if (explicit.length !== intervals.length) return null
  const sets = new Map<string, UtcDay[]>()
  for (const days of explicit) {
    const sorted = sortDays(days)
    sets.set(sorted.join(','), sorted)
  }
  const ordered = [...sets.values()].sort((a, b) =>
    DAY_ORDER.indexOf(a[0]) - DAY_ORDER.indexOf(b[0]) || a.length - b.length)
  const base = ordered[0]
  const next = shiftDays(base, 1)
  for (const days of ordered) {
    if (sameDaySet(days, base) || sameDaySet(days, next)) continue
    return null
  }
  return { days: base }
}

/** Union local time-of-day windows on a circular clock, merging touching spans. */
function mergeLocalIntervals(intervals: readonly LocalInterval[]): LocalInterval[] {
  if (!intervals.length) return []
  if (intervals.some((interval) => interval.fullDay)) {
    return [{ start: 0, end: 1440, days: null, fullDay: true }]
  }
  const covered = new Uint8Array(1440)
  for (const interval of intervals) {
    let minute = interval.start
    while (minute !== interval.end) {
      covered[minute] = 1
      minute = (minute + 1) % 1440
    }
  }
  const cut = covered.indexOf(0)
  if (cut < 0) return [{ start: 0, end: 1440, days: null, fullDay: true }]
  const merged: LocalInterval[] = []
  let runStart = -1
  for (let step = 0; step <= 1440; step++) {
    const minute = (cut + step) % 1440
    const inside = step < 1440 && covered[minute] === 1
    if (inside && runStart < 0) runStart = minute
    if (!inside && runStart >= 0) {
      merged.push({ start: runStart, end: minute, days: null, fullDay: false })
      runStart = -1
    }
  }
  return merged
}

function dayLabel(days: readonly UtcDay[] | null): string {
  if (days === null || days.length === 7) return ''
  if (days.length === 5 && ['mon', 'tue', 'wed', 'thu', 'fri'].every((day) => days.includes(day as UtcDay))) {
    return '工作日'
  }
  return days.map((day) => DAY_LABELS[day]).join('、')
}

function timeLabel(interval: LocalInterval): string {
  return interval.fullDay || interval.start === interval.end
    ? '全天'
    : `${formatClock(interval.start)}–${formatClock(interval.end)}`
}

export interface PeakSchedule {
  /** Local time description such as `工作日 09:00–12:00`, without the factor. */
  schedule: string
  factor: number
}

/** Only rules that resolve to a local clock schedule are peak rules. */
export function timeScheduleMultipliers(
  rules: readonly RateMultiplier[] | undefined
): RateMultiplier[] {
  return rules?.filter((rule) => timeShape(rule.when) !== null) ?? []
}

/** One entry per peak schedule group, carrying that group's own factor. */
export function describePeakSchedules(
  rules: readonly RateMultiplier[] | undefined,
  timeZone: string,
  referenceMs = Date.now()
): PeakSchedule[] {
  if (!rules?.length) return []
  const offset = timeZoneOffsetMinutes(timeZone, referenceMs)
  const groups = new Map<string, { factor: number; label: string; times: string[] }>()
  const add = (factor: number, days: readonly UtcDay[] | null, intervals: readonly LocalInterval[]) => {
    const label = dayLabel(days)
    const key = `${factor}\u0000${label}`
    const held = groups.get(key) ?? { factor, label, times: [] }
    for (const interval of intervals) {
      const time = timeLabel(interval)
      if (!held.times.includes(time)) held.times.push(time)
    }
    if (held.times.length) groups.set(key, held)
  }
  for (const [factor, intervals] of collectLocalIntervals(rules, offset)) {
    if (!intervals.length) continue
    const mode = dayMode(intervals)
    if (mode) {
      add(factor, mode.days, mergeLocalIntervals(intervals))
      continue
    }
    // Mixed weekday sets cannot be represented as one local schedule; keep
    // each exact day set separate instead of inventing coverage.
    const byDays = new Map<string, LocalInterval[]>()
    for (const interval of intervals) {
      const key = interval.days === null ? '' : interval.days.join(',')
      const list = byDays.get(key) ?? []
      list.push(interval)
      byDays.set(key, list)
    }
    for (const list of byDays.values()) {
      add(factor, list[0]?.days ?? null, mergeLocalIntervals(list))
    }
  }
  return [...groups.values()].map(({ factor, label, times }) => ({
    schedule: `${label ? `${label} ` : ''}${times.join('、')}`,
    factor,
  }))
}

export function describeMultiplierRules(
  rules: readonly RateMultiplier[] | undefined,
  timeZone: string,
  referenceMs = Date.now()
): string | null {
  const schedules = describePeakSchedules(rules, timeZone, referenceMs)
  if (!schedules.length) return null
  return schedules.map(({ schedule, factor }) => `${schedule} ×${factor}`).join('；')
}

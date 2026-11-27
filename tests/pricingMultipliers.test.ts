import { describe, expect, it } from 'vitest'
import {
  describeMultiplierRules, describePeakSchedules, multiplierFactor, normalizeMultipliers,
  timeScheduleMultipliers, timeZoneOffsetMinutes
} from '../src/shared/pricingMultipliers'

const deepseekRules = normalizeMultipliers([{
  when: {
    utc_days: { in: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    any: [
      { all: [{ utc_hours: { gte: '01:00' } }, { utc_hours: { lt: '04:00' } }] },
      { all: [{ utc_hours: { gte: '06:00' } }, { utc_hours: { lt: '10:00' } }] }
    ],
    not: { holiday: { equals: 'CN' } }
  },
  factor: 2
}])
const alibabaRules = normalizeMultipliers([{
  when: { utc_hours: { gte: '14:00' } },
  factor: { text: 0.5 }
}])
const reference = Date.parse('2026-11-27T04:00:00Z')

describe('pricing multipliers', () => {
  it('evaluates UTC weekdays, hour windows, composite any/all, and ignores holiday rules', () => {
    const friday = (time: string) => Date.parse(`2026-11-27T${time}:00Z`)
    expect(multiplierFactor(deepseekRules, friday('02:00'))).toBe(2)
    expect(multiplierFactor(deepseekRules, friday('03:59'))).toBe(2)
    expect(multiplierFactor(deepseekRules, friday('04:00'))).toBe(1)
    expect(multiplierFactor(deepseekRules, friday('06:00'))).toBe(2)
    expect(multiplierFactor(deepseekRules, friday('09:59'))).toBe(2)
    expect(multiplierFactor(deepseekRules, friday('10:00'))).toBe(1)
    expect(multiplierFactor(deepseekRules, Date.parse('2026-11-28T02:00:00Z'))).toBe(1)
    expect(deepseekRules[0]?.when.not).toBeUndefined()
  })

  it('supports open-ended off-peak windows and object factors', () => {
    expect(multiplierFactor(alibabaRules, Date.parse('2026-11-27T13:59:00Z'))).toBe(1)
    expect(multiplierFactor(alibabaRules, Date.parse('2026-11-27T14:00:00Z'))).toBe(0.5)
    expect(multiplierFactor(alibabaRules, Date.parse('2026-11-27T23:59:00Z'))).toBe(0.5)
    expect(alibabaRules[0]?.factor).toBe(0.5)
  })

  it('describes UTC rules in local time', () => {
    expect(timeZoneOffsetMinutes('Asia/Shanghai', reference)).toBe(480)
    expect(describeMultiplierRules(deepseekRules, 'Asia/Shanghai', reference))
      .toBe('工作日 09:00–12:00、14:00–18:00 ×2')
    expect(describeMultiplierRules(alibabaRules, 'Asia/Shanghai', reference))
      .toBe('22:00–08:00 ×0.5')
  })

  it('drops any branch carrying an unevaluable condition instead of applying it worldwide', () => {
    expect(normalizeMultipliers([{
      when: { region: { in: ['us'] } }, factor: 1.5
    }])).toEqual([])
    expect(normalizeMultipliers([{
      when: { all: [{ region: { in: ['eu'] } }, { utc_hours: { gte: '00:00' } }] }, factor: 2
    }])).toEqual([])
    expect(normalizeMultipliers([{
      when: { not: { region: { in: ['cn'] } } }, factor: 2
    }])).toEqual([])
    // An `any` branch that cannot be evaluated simply never matches.
    expect(normalizeMultipliers([{
      when: {
        any: [
          { region: { in: ['us'] } },
          { utc_hours: { gte: '14:00' } },
        ]
      },
      factor: 0.5
    }])).toEqual([{ when: { any: [{ utc_hours: { gte: '14:00' } }] }, factor: 0.5 }])
  })

  it('never drops a whole rule just because it carries a holiday exclusion', () => {
    expect(deepseekRules).toHaveLength(1)
    expect(normalizeMultipliers([{ when: { not: { holiday: { equals: 'CN' } } }, factor: 1.2 }]))
      .toEqual([])
  })

  it('separates local peak schedules from service-tier and date rules', () => {
    const mixed = normalizeMultipliers([
      { when: { utc_hours: { gte: '14:00' } }, factor: 0.5 },
      { when: { service_tier: { equals: 'priority' } }, factor: 2 },
      { when: { date: { gte: '2026-01-01' } }, factor: 1.2 }
    ])
    expect(timeScheduleMultipliers(mixed)).toEqual([
      { when: { utc_hours: { gte: '14:00' } }, factor: 0.5 }
    ])
    expect(describePeakSchedules(mixed, 'Asia/Shanghai', reference))
      .toEqual([{ schedule: '22:00–08:00', factor: 0.5 }])
    expect(timeScheduleMultipliers(normalizeMultipliers([
      { when: { service_tier: { equals: 'fast' } }, factor: 2 },
      { when: { date: { gte: '2026-11-01' } }, factor: 1.1 }
    ]))).toEqual([])
    expect(describePeakSchedules(normalizeMultipliers([
      { when: { service_tier: { equals: 'fast' } }, factor: 2 }
    ]), 'Asia/Shanghai', reference)).toEqual([])
  })

  it('keeps each local peak group on its own factor', () => {
    const rules = normalizeMultipliers([
      { when: { utc_hours: { gte: '01:00', lt: '04:00' } }, factor: 2 },
      { when: { utc_hours: { gte: '14:00' } }, factor: 0.5 }
    ])
    expect(describePeakSchedules(rules, 'Asia/Shanghai', reference)).toEqual([
      { schedule: '09:00–12:00', factor: 2 },
      { schedule: '22:00–08:00', factor: 0.5 }
    ])
    expect(describeMultiplierRules(rules, 'Asia/Shanghai', reference))
      .toBe('09:00–12:00 ×2；22:00–08:00 ×0.5')
  })

  it('matches fast turns against either the fast or priority service tier', () => {
    const rules = normalizeMultipliers([{
      when: { service_tier: { equals: 'priority' } }, factor: 2
    }])
    expect(multiplierFactor(rules, reference, 'fast')).toBe(2)
    expect(multiplierFactor(rules, reference, 'priority')).toBe(2)
    expect(multiplierFactor(rules, reference, 'standard')).toBe(1)
    const ultra = normalizeMultipliers([{
      when: { service_tier: { in: ['fast', 'ultrafast'] } }, factor: 1.5
    }])
    expect(multiplierFactor(ultra, reference, 'fast')).toBe(1.5)
    expect(multiplierFactor(ultra, reference, 'ultrafast')).toBe(1.5)
  })

  it('applies a date-only price change only inside its window', () => {
    const rules = normalizeMultipliers([{
      when: { date: { gte: '2026-11-01', lt: '2027-01-01' } }, factor: 1.25
    }])
    expect(multiplierFactor(rules, Date.parse('2026-11-27T00:00:00Z'))).toBe(1.25)
    expect(multiplierFactor(rules, Date.parse('2027-02-01T00:00:00Z'))).toBe(1)
  })
})

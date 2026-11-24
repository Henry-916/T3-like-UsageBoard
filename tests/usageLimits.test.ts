import { describe, expect, it } from 'vitest'
import type { LimitAccountReading } from '../src/shared/limitsTypes'
import { poolUsageLimits } from '../src/shared/usageLimits'

const now = '2026-11-24T12:00:00.000Z'
const nowMs = Date.parse(now)
const firstReset = '2026-11-24T13:00:00.000Z'
const lastReset = '2026-11-24T13:01:00.000Z'

function account(id: string, usedPercent: number, resetsAt?: string): LimitAccountReading {
  return {
    id, provider: 'antigravity', displayName: id, origin: 'native',
    checkedAt: now, stale: false,
    windows: [{ id: 'gemini-5h', kind: 'session', label: 'Gemini', usedPercent, resetsAt }]
  }
}

describe('poolUsageLimits', () => {
  it('coalesces the next reset shares across three accounts without including later resets', () => {
    const [pool] = poolUsageLimits([
      account('c', 15, lastReset),
      account('b', 60, '2026-11-24T13:00:45.000Z'),
      account('a', 90, firstReset)
    ], nowMs)
    expect(pool.meanRemainingPercent).toBeCloseTo(45)
    expect(pool.nextReset).toEqual({
      at: firstReset,
      recoveryPercent: 50,
      shares: [
        { accountId: 'a', recoveryPercent: 30 },
        { accountId: 'b', recoveryPercent: 20 }
      ]
    })
    expect(pool.accounts[0]).toMatchObject({ id: 'c', remainingPercent: 85, recoveryPercent: 5 })
  })

  it.each([
    [undefined, 'unknown'],
    ['invalid', 'unknown'],
    ['2026-11-24T11:59:00.000Z', 'passed'],
    [now, 'passed']
  ] as const)('keeps reported quota without predicting a refill when reset is %s', (at, status) => {
    const reading = account('a', 100, at)
    reading.stale = true
    reading.windows[0].windowDurationMins = 300
    const [pool] = poolUsageLimits([reading], nowMs)
    expect(pool.meanRemainingPercent).toBe(0)
    expect(pool.nextReset).toBeUndefined()
    expect(pool.trend).toBeUndefined()
    expect(pool.accounts[0]).toMatchObject({ stale: true, remainingPercent: 0, resetStatus: status })
    expect(pool.accounts[0].recoveryPercent).toBeUndefined()
  })

  it('keeps providers distinct and computes pace from only accounts with usable clocks', () => {
    const timed = account('a', 80, firstReset)
    timed.windows[0].windowDurationMins = 120
    const other = { ...account('c', 0), provider: 'opencode' as const }
    const [pool, otherPool] = poolUsageLimits([timed, account('b', 0), other], nowMs)
    expect(pool.meanRemainingPercent).toBe(60)
    expect(pool.trend).toEqual({ pace: 'ahead', expectedRemainingPercent: 50 })
    expect(otherPool).toMatchObject({ provider: 'opencode', meanRemainingPercent: 100 })
  })

  it('pools Codex slots by kind and counts mixed plans equally', () => {
    const plus = { ...account('plus', 60, firstReset), provider: 'codex' as const, plan: 'ChatGPT Plus Subscription' }
    const pro = { ...account('pro', 0), provider: 'codex' as const, plan: 'ChatGPT Pro 100 Subscription' }
    plus.windows[0].id = 'primary'
    pro.windows[0].id = 'secondary'
    const [pool] = poolUsageLimits([plus, pro], nowMs)
    expect(pool.windowId).toBe('session')
    expect(pool.meanRemainingPercent).toBeCloseTo(70)
    expect(pool.nextReset?.recoveryPercent).toBeCloseTo(30)
    expect(pool.accounts.map((member) => member.capacitySharePercent)).toEqual([50, 50])
  })

  it('shows a weekly-blocked Claude session as empty and recovers at the weekly reset', () => {
    const blocked = { ...account('a', 25, lastReset), provider: 'claude' as const }
    blocked.windows.push({ id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: firstReset })
    const [session] = poolUsageLimits([blocked], nowMs)
    expect(session.meanRemainingPercent).toBe(0)
    expect(session.nextReset).toMatchObject({ at: firstReset, recoveryPercent: 75 })
    expect(session.trend).toBeUndefined()
  })
})

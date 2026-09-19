import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig: the browser manager', () => {
  it('defaults every knob', () => {
    expect(loadConfig({})).toMatchObject({
      browserMaxAgeMs: 21_600_000,
      browserMaxLeases: 1000,
      browserMaxMemoryMb: 2048,
      browserCheckIntervalMs: 60_000,
      browserCloseTimeoutMs: 10_000,
      browserMaxRelaunchFailures: 5,
      poolWaitCapMs: 20_000,
    })
  })

  it('reads every knob from the environment', () => {
    expect(
      loadConfig({
        BROWSER_MAX_AGE_MS: '1000',
        BROWSER_MAX_LEASES: '3',
        BROWSER_MAX_MEMORY_MB: '100',
        BROWSER_CHECK_INTERVAL_MS: '50',
        BROWSER_CLOSE_TIMEOUT_MS: '200',
        BROWSER_MAX_RELAUNCH_FAILURES: '2',
        POOL_WAIT_CAP_MS: '300',
      }),
    ).toMatchObject({
      browserMaxAgeMs: 1000,
      browserMaxLeases: 3,
      browserMaxMemoryMb: 100,
      browserCheckIntervalMs: 50,
      browserCloseTimeoutMs: 200,
      browserMaxRelaunchFailures: 2,
      poolWaitCapMs: 300,
    })
  })

  it('accepts 0 for BROWSER_MAX_MEMORY_MB, which turns the memory trigger off', () => {
    expect(loadConfig({ BROWSER_MAX_MEMORY_MB: '0' }).browserMaxMemoryMb).toBe(0)
  })

  // Four existing suites shorten the budget without ever setting the cap. A
  // fixed 20s default plus a hard check would break every one of them -- and
  // any operator who did the same.
  it('derives the wait cap from a short budget rather than failing on a knob nobody set', () => {
    expect(loadConfig({ PRODUCE_BUDGET_MS: '5000' }).poolWaitCapMs).toBe(2500)
    expect(loadConfig({ PRODUCE_BUDGET_MS: '1' }).poolWaitCapMs).toBe(1)
  })

  it('refuses an explicit wait cap at or above the budget, which could never fire', () => {
    expect(() => loadConfig({ PRODUCE_BUDGET_MS: '5000', POOL_WAIT_CAP_MS: '5000' })).toThrow(/POOL_WAIT_CAP_MS/)
  })
})

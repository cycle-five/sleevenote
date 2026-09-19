import { describe, it, expect, vi } from 'vitest'
import { shutdownSequence, poolOptionsFor } from '../src/index.js'
import { browserLaunches, browserLaunchFailures } from '../src/metrics.js'

describe('shutdownSequence', () => {
  it('closes the HTTP server, then the pool, then the store -- in that order', async () => {
    const calls: string[] = []
    const app = { close: async () => { calls.push('app') } }
    const pool = { close: async () => { calls.push('pool') } }
    const store = { close: async () => { calls.push('store') } }

    await shutdownSequence({ app, pool, store })

    expect(calls).toEqual(['app', 'pool', 'store'])
  })

  // The property that actually matters is not just "app.close() is called
  // before pool.close()" but that pool.close() does not START until
  // app.close() has genuinely FINISHED -- pool.close() is a hard shutdown
  // (Task 4) that force-closes contexts still on outstanding leases, so if
  // it ran concurrently with (rather than strictly after) app.close()
  // draining requests, an in-flight extraction could still be killed
  // mid-request. Giving app.close() a real delay and asserting inside
  // pool.close() that it had already finished catches a Promise.all-style
  // "fire everything in parallel" mutation that a bare call-order array
  // (all closes here resolve near-instantly) would not reliably catch.
  it('does not start closing the pool until the HTTP server has finished closing', async () => {
    let appClosed = false
    const app = {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        appClosed = true
      },
    }
    let poolSawAppClosed = false
    const pool = {
      close: async () => {
        poolSawAppClosed = appClosed
      },
    }
    const store = { close: async () => {} }

    await shutdownSequence({ app, pool, store })

    expect(poolSawAppClosed).toBe(true)
  })
})

describe('poolOptionsFor', () => {
  it('counts launches by reason and failed launches', async () => {
    const opts = poolOptionsFor(() => {})
    const before = (await browserLaunches.get()).values.find((v) => v.labels.reason === 'crash')?.value ?? 0
    opts.observer!.launched({ reason: 'crash', generation: 2, pid: 123 })
    const after = (await browserLaunches.get()).values.find((v) => v.labels.reason === 'crash')?.value ?? 0
    expect(after).toBe(before + 1)
    const failsBefore = (await browserLaunchFailures.get()).values[0]?.value ?? 0
    opts.observer!.launchFailed()
    expect((await browserLaunchFailures.get()).values[0]?.value ?? 0).toBe(failsBefore + 1)
  })

  // The pool never exits by itself; index.ts decides, so the container
  // restart policy gives the service a clean start.
  it('exits non-zero when the pool gives up on the browser', () => {
    const exits: number[] = []
    poolOptionsFor((code) => { exits.push(code) }).onFatal!(new Error('no browser'))
    expect(exits).toEqual([1])
  })

  // Playwright folds a call log into `message`; the exit line stays one line.
  it('logs only the first line of the error it exits on', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      poolOptionsFor(() => {}).onFatal!(new Error('browserType.launchServer: Timeout 30000ms exceeded.\nCall log:\n  - <launching> chrome'))
      expect(error).toHaveBeenCalledTimes(1)
      const line = String(error.mock.calls[0]![0])
      expect(line).toContain('Timeout 30000ms exceeded.')
      expect(line).not.toContain('\n')
    } finally {
      error.mockRestore()
    }
  })
})

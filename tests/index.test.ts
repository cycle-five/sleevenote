import { describe, it, expect } from 'vitest'
import { shutdownSequence } from '../src/index.js'

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

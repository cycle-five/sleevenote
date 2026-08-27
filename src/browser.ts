import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { Config } from './config.js'

export type Lease = { page: Page; release: () => Promise<void> }

export interface Pool {
  acquire(): Promise<Lease>
  liveContexts(): number
  close(): Promise<void>
}

// Task 1's capture probe blocked exactly these three resource types, and
// Task 2's normalizer was built against a corpus recorded without them. A
// pool that served unblocked pages would make production see a different
// page than the one the normalizer was designed against.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media'])

type ContextRecord = { context: BrowserContext; page: Page; uses: number }

// Rejecting is deliberately distinct from a waiter timing out mid-wait: it
// only ever fires for waiters still queued at the moment close() runs.
class PoolClosedError extends Error {
  constructor() {
    super('browser pool closed while waiting for a free context')
  }
}

// Test-only fault injection: lets tests force the next N context-creation
// attempts to fail deterministically, without needing to actually exhaust
// system resources to trigger a real Playwright failure. This is not part
// of the Pool contract the brief specifies -- createPool(cfg) alone is the
// real, documented signature. The optional second parameter exists solely
// so tests can exercise the recycle-failure path in tests/browser.test.ts.
type TestFaultHooks = { failNextContextCreations?: number }

/**
 * One browser, launched once, backing `cfg.poolSize` contexts that are
 * reused across requests rather than relaunched per request -- the prior art
 * this project replaces called `puppeteer.launch()` in its request path, and
 * that launch was its dominant cost.
 *
 * `acquire()` hands out a free context or, if all are busy, queues (FIFO)
 * until one is released -- it never rejects for lack of capacity. A third
 * concurrent caller against a pool of two should wait its turn, not turn
 * into a 500.
 */
export async function createPool(cfg: Config, testHooks?: TestFaultHooks): Promise<Pool> {
  const browser: Browser = await chromium.launch()

  let liveCount = 0
  // Armed only after the initial pool fill below, so an injected failure
  // exercises the recycle path a test actually asked for rather than
  // silently consuming itself during createPool()'s own warm-up.
  let failuresRemaining = 0

  async function createContext(): Promise<ContextRecord> {
    if (failuresRemaining > 0) {
      failuresRemaining--
      throw new Error('injected context-creation failure (test)')
    }
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.route('**/*', (route) => {
      const type = route.request().resourceType()
      if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort()
      return route.continue()
    })
    liveCount++
    return { context, page, uses: 0 }
  }

  // A record lives in exactly one of three places at a time: `free`, handed
  // out inside a `Lease` closure (no separate bookkeeping needed for that
  // case), or mid-flight to a queued waiter. There is no independent
  // "in use" flag to fall out of sync with reality.
  const free: ContextRecord[] = []
  const waiters: Array<{ resolve: (record: ContextRecord) => void; reject: (err: Error) => void }> = []
  let closed = false

  for (let i = 0; i < cfg.poolSize; i++) {
    free.push(await createContext())
  }
  failuresRemaining = testHooks?.failNextContextCreations ?? 0

  // Uses are counted per acquisition. A context that has hit its budget is
  // recycled here, at release time, rather than left to accumulate whatever
  // a long-running page leaks (detached listeners, JS heap growth, etc.).
  //
  // `liveCount` is decremented up front because the old context really is
  // about to be closed regardless of what happens next; `createContext()`
  // increments it again on success, so a clean recycle nets to zero change.
  // If creation fails, the decrement is left standing -- that's not a bug to
  // paper over, it's the truth: one fewer context now exists than a moment
  // ago. A single transient failure (a momentary OOM, a renderer that
  // crashed on startup) shouldn't cost the pool a permanent slot, though, so
  // one retry is attempted before treating it as a real, unrecoverable loss.
  async function recycle(record: ContextRecord): Promise<ContextRecord> {
    liveCount--
    // The old context may already be in a bad way (crashed page, etc.) --
    // that must not stop it from being replaced.
    await record.context.close().catch(() => {})
    try {
      return await createContext()
    } catch (err) {
      try {
        return await createContext()
      } catch (retryErr) {
        throw new Error(
          `failed to create a replacement browser context after one retry: ${String(retryErr)}`,
          { cause: err },
        )
      }
    }
  }

  async function releaseRecord(record: ContextRecord): Promise<void> {
    // The browser is gone or going; there is nothing left to hand this
    // context back to, and browser.close() already tore it down.
    if (closed) return

    let returned: ContextRecord
    try {
      returned = record.uses >= cfg.contextMaxUses ? await recycle(record) : record
    } catch (err) {
      if (closed) {
        // close() ran while recycle() was still in flight (Task 6 closes the
        // pool on SIGTERM, which can race any in-flight release). The
        // browser is already gone or going, close() already rejected every
        // waiter it found queued, and there is nothing left for this caller
        // to be told that would matter -- so a graceful shutdown must not
        // masquerade as a release() failure.
        return
      }
      // recycle() already closed the old context and, after a retry, still
      // couldn't create its replacement -- there is nothing to hand back to
      // the pool for this slot. A waiter already queued for it would
      // otherwise wait forever for a context that will never arrive; reject
      // them with the real cause instead of stranding them. Either way the
      // failure is loud -- surfaced to the waiter, and to whoever called
      // release() -- not a silently vanished slot.
      const error = err instanceof Error ? err : new Error(String(err))
      const waiter = waiters.shift()
      if (waiter) waiter.reject(error)
      throw error
    }

    if (closed) {
      // close() ran while recycle() was still in flight and won: the
      // replacement context it just created has nowhere to go (close()
      // already rejected every then-queued waiter and torn down the
      // browser without knowing this one existed). Close it directly
      // instead of pushing it into a free list nobody will ever read from
      // again -- acquire() rejects immediately once the pool is closed.
      await returned.context.close().catch(() => {})
      return
    }

    const waiter = waiters.shift()
    if (waiter) {
      waiter.resolve(returned)
    } else {
      free.push(returned)
    }
  }

  function makeLease(record: ContextRecord): Lease {
    record.uses++
    // Guards against a lease released twice: the second call is a silent
    // no-op instead of double-freeing the record (which would let two
    // callers hold the same context) or resolving a waiter twice.
    let released = false
    return {
      page: record.page,
      release: async () => {
        if (released) return
        released = true
        await releaseRecord(record)
      },
    }
  }

  return {
    async acquire(): Promise<Lease> {
      if (closed) throw new Error('browser pool is closed')
      const record = free.shift()
      if (record) return makeLease(record)
      const queued = await new Promise<ContextRecord>((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
      return makeLease(queued)
    },

    liveContexts(): number {
      return liveCount
    },

    async close(): Promise<void> {
      closed = true
      // A caller still queued here would otherwise wait forever: nothing is
      // ever going to release into a pool that's shutting down.
      while (waiters.length > 0) {
        waiters.shift()!.reject(new PoolClosedError())
      }
      // Closing the browser tears down every context it owns, including
      // ones still out on an unreleased lease (a caller that threw before
      // calling release(), say) -- so a leaked lease doesn't leak a
      // Chromium process past shutdown.
      await browser.close()
      liveCount = 0
    },
  }
}

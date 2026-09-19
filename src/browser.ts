import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { Config } from './config.js'

export type Lease = { page: Page; release: () => Promise<void> }

export type PoolStats = { free: number; leased: number; waiting: number }

export interface Pool {
  /**
   * A free context, or a place in the queue for one.
   *
   * With `deadline`, the pool -- not the holder -- owns when the lease ends. A
   * caller still queued when it fires is rejected and leaves the queue. A
   * lease still held when it fires is revoked: its context is closed, which
   * fails every Playwright call still pending on it, and a fresh context
   * takes its slot. The holder's own `release()` is then a no-op.
   */
  acquire(deadline?: AbortSignal): Promise<Lease>
  liveContexts(): number
  stats(): PoolStats
  close(): Promise<void>
}

// The corpus in tests/fixtures was recorded with exactly these blocked. A pool
// that served unblocked pages would show production a different page than the
// normalizer was built against.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media'])

type ContextRecord = { context: BrowserContext; page: Page; uses: number }

class PoolClosedError extends Error {
  constructor() {
    super('browser pool closed while waiting for a free context')
  }
}

// Test-only fault injection, not part of the Pool contract: `createPool(cfg)`
// alone is the real signature. Lets tests reach the recycle-failure path
// without exhausting real system resources.
type TestFaultHooks = { failNextContextCreations?: number; hangNextContextCloses?: number }

/**
 * Close `context`, but stop waiting after `ms`. A context whose renderer has
 * wedged can hold `close()` open indefinitely, and the caller here is always a
 * release: waiting on it would hold the slot exactly as a stuck holder did.
 * The context is abandoned rather than awaited, and the pool replaces it.
 */
async function closeWithin(close: () => Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const gaveUp = new Promise<'gave up'>((resolve) => {
    timer = setTimeout(() => resolve('gave up'), ms)
  })
  const outcome = await Promise.race([close().then(() => 'closed' as const, () => 'closed' as const), gaveUp])
  clearTimeout(timer)
  if (outcome === 'gave up') {
    console.warn(`[pool] a context did not close within ${ms}ms -- abandoning it and creating a replacement`)
  }
}

/**
 * One browser backing `cfg.poolSize` reused contexts. `acquire()` hands out a
 * free context or queues FIFO until one is released -- it never rejects for
 * lack of capacity, so a third caller against a pool of two waits its turn
 * rather than becoming a 500.
 *
 * See docs/design-notes.md for why the pool is shaped this way.
 */
export async function createPool(cfg: Config, testHooks?: TestFaultHooks): Promise<Pool> {
  const browser: Browser = await chromium.launch()

  // Every record the pool owns, in any state, so `liveContexts()` can check
  // each page's real usability at call time. A renderer can die while its
  // context sits idle in `free`, which a counter has no way to notice.
  const allRecords = new Set<ContextRecord>()
  // Armed only after the initial fill, so an injected failure exercises the
  // recycle path rather than being consumed by warm-up.
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
    const record: ContextRecord = { context, page, uses: 0 }
    allRecords.add(record)
    return record
  }

  // A record lives in exactly one of three places: `free`, inside a `Lease`
  // closure, or mid-flight to a waiter. There is no separate "in use" flag to
  // fall out of sync.
  const free: ContextRecord[] = []
  const waiters: Array<{ resolve: (record: ContextRecord) => void; reject: (err: Error) => void }> = []
  // Set once by close(); read by every inner function below via closure.
  let closed = false

  for (let i = 0; i < cfg.poolSize; i++) {
    free.push(await createContext())
  }
  failuresRemaining = testHooks?.failNextContextCreations ?? 0
  let closeHangsRemaining = testHooks?.hangNextContextCloses ?? 0

  // Recycling at release time bounds what a long-lived page accumulates.
  // `record` leaves `allRecords` up front because the old context is closed
  // regardless; a successful `createContext()` puts its replacement back, so a
  // clean recycle nets to zero. One retry absorbs a transient failure without
  // costing the pool a permanent slot.
  async function recycle(record: ContextRecord): Promise<ContextRecord> {
    allRecords.delete(record)
    let close = (): Promise<void> => record.context.close()
    if (closeHangsRemaining > 0) {
      closeHangsRemaining--
      close = () => new Promise<void>(() => {}) // injected: a close that never finishes
    }
    await closeWithin(close, cfg.contextCloseTimeoutMs)
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

  async function releaseRecord(record: ContextRecord, revoked = false): Promise<void> {
    // `closed` is createPool's own flag, declared above and closed over here
    // rather than passed in. True on entry means the pool shut down *before*
    // this release: browser.close() has already torn this context down, so
    // there is nothing to hand back. Shutdown racing an in-flight recycle is a
    // different case, caught by the two `closed` checks further down.
    if (closed) return

    let returned: ContextRecord
    try {
      // Recycle on a crashed page as well as at the use budget: a dead
      // renderer would otherwise sit in `free` being handed out until it
      // happened to also reach `contextMaxUses`.
      //
      // And always on a revoked lease: its holder may still be running against
      // this page, so the page must not go back out.
      returned =
        revoked || record.uses >= cfg.contextMaxUses || record.page.isClosed() ? await recycle(record) : record
    } catch (err) {
      if (closed) {
        // close() won a race with an in-flight recycle. It already rejected
        // every queued waiter and tore down the browser; a graceful shutdown
        // must not surface as a release() failure.
        return
      }
      // The old context is gone and its replacement could not be created. A
      // waiter queued for this slot would wait forever, so fail it with the
      // real cause rather than stranding it.
      const error = err instanceof Error ? err : new Error(String(err))
      const waiter = waiters.shift()
      if (waiter) waiter.reject(error)
      throw error
    }

    if (closed) {
      // close() ran during the recycle and knows nothing about the context it
      // just produced. Nothing will ever read `free` again, so close it here.
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

  function makeLease(record: ContextRecord, deadline?: AbortSignal): Lease {
    record.uses++
    // Whichever comes first, the holder's release() or the deadline, ends the
    // lease; the other is a no-op. A double release must not free the record
    // twice or resolve two waiters.
    let ended = false
    const revoke = (): void => {
      if (ended) return
      ended = true
      // The holder is stuck or slow, and cannot be trusted to hand this back:
      // on 2026-09-19 two holders never did, and a pool of two stayed empty
      // until a restart. Take it. Closing the context is also what stops the
      // holder -- every Playwright call it has pending rejects.
      console.warn('[pool] a lease outlived its deadline -- closing its context and replacing it')
      releaseRecord(record, true).catch((err: unknown) => {
        console.warn(`[pool] replacing a revoked context failed: ${String(err)}`)
      })
    }
    deadline?.addEventListener('abort', revoke, { once: true })
    return {
      page: record.page,
      release: async () => {
        deadline?.removeEventListener('abort', revoke)
        if (ended) return
        ended = true
        await releaseRecord(record)
      },
    }
  }

  return {
    async acquire(deadline?: AbortSignal): Promise<Lease> {
      if (closed) throw new Error('browser pool is closed')
      deadline?.throwIfAborted()
      const record = free.shift()
      if (record) return makeLease(record, deadline)
      const queued = await new Promise<ContextRecord>((resolve, reject) => {
        // A caller whose deadline passes leaves the queue. Left in it, it
        // would be handed the next free context after it had stopped
        // listening, ahead of a caller that is still waiting.
        const leave = (): void => {
          const i = waiters.indexOf(waiter)
          if (i !== -1) waiters.splice(i, 1)
          reject(deadline?.reason)
        }
        const waiter = {
          resolve: (r: ContextRecord) => {
            deadline?.removeEventListener('abort', leave)
            resolve(r)
          },
          reject: (err: Error) => {
            deadline?.removeEventListener('abort', leave)
            reject(err)
          },
        }
        deadline?.addEventListener('abort', leave, { once: true })
        waiters.push(waiter)
      })
      if (deadline?.aborted) {
        // Handed a context in the same tick the deadline fired. Nothing has
        // touched it, so pass it on rather than revoking a good context.
        await releaseRecord(queued)
        throw deadline.reason
      }
      return makeLease(queued, deadline)
    },

    // Filtered by the same predicate `releaseRecord` recycles on. An unfiltered
    // count is how `/health` kept answering "ok" while every request against a
    // crashed context failed.
    liveContexts(): number {
      let live = 0
      for (const record of allRecords) {
        if (!record.page.isClosed()) live++
      }
      return live
    },

    // Read at scrape time by /metrics. `leased` includes a record in transit
    // to a waiter; a pool with every context leased and callers waiting is
    // starved, which is what this exists to make visible.
    stats(): PoolStats {
      return { free: free.length, leased: allRecords.size - free.length, waiting: waiters.length }
    },

    async close(): Promise<void> {
      closed = true
      // Nothing will ever release into a closing pool.
      while (waiters.length > 0) {
        waiters.shift()!.reject(new PoolClosedError())
      }
      // Tears down contexts still out on unreleased leases too, so a leaked
      // lease cannot leak a Chromium process past shutdown.
      await browser.close()
      allRecords.clear()
    },
  }
}

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { Config } from './config.js'

export type Lease = { page: Page; release: () => Promise<void> }

export interface Pool {
  acquire(): Promise<Lease>
  liveContexts(): number
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
type TestFaultHooks = { failNextContextCreations?: number }

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

  // Recycling at release time bounds what a long-lived page accumulates.
  // `record` leaves `allRecords` up front because the old context is closed
  // regardless; a successful `createContext()` puts its replacement back, so a
  // clean recycle nets to zero. One retry absorbs a transient failure without
  // costing the pool a permanent slot.
  async function recycle(record: ContextRecord): Promise<ContextRecord> {
    allRecords.delete(record)
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
      returned = record.uses >= cfg.contextMaxUses || record.page.isClosed() ? await recycle(record) : record
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

  function makeLease(record: ContextRecord): Lease {
    record.uses++
    // A double release must not free the record twice or resolve two waiters.
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

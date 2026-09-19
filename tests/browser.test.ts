import { describe, it, expect, afterAll, vi } from 'vitest'
import { createPool, BrowserUnavailableError, type LaunchEvent } from '../src/browser.js'
import { loadConfig } from '../src/config.js'

const cfg = loadConfig({ POOL_SIZE: '2', CONTEXT_MAX_USES: '3' })
const pool = await createPool(cfg)
afterAll(async () => { await pool.close() })

describe('createPool', () => {
  it('reports live contexts once created', () => {
    expect(pool.liveContexts()).toBe(2)
  })

  it('serves a usable page and takes it back', async () => {
    const lease = await pool.acquire()
    await lease.page.setContent('<h1>hello</h1>')
    expect(await lease.page.textContent('h1')).toBe('hello')
    await lease.release()
  })

  // If acquire() rejected when busy, a third concurrent request would 500
  // rather than simply waiting its turn.
  it('makes a third caller wait rather than fail when the pool is exhausted', async () => {
    const a = await pool.acquire()
    const b = await pool.acquire()
    let served = false
    const pending = pool.acquire().then(async (c) => { served = true; await c.release() })
    await new Promise((r) => setTimeout(r, 100))
    expect(served).toBe(false)
    await a.release()
    await pending
    expect(served).toBe(true)
    await b.release()
  })

  it('blocks images so they never reach the network', async () => {
    const lease = await pool.acquire()
    const attempted: string[] = []
    lease.page.on('requestfailed', (r) => { if (r.resourceType() === 'image') attempted.push(r.url()) })
    await lease.page.setContent('<img src="https://example.invalid/x.png">')
    await lease.page.waitForTimeout(300)
    expect(attempted.length).toBeGreaterThan(0)
    await lease.release()
  })
})

// Review round 1 found that close() can race an in-flight recycle: release()
// takes the recycle path, awaits inside it, and close() runs to completion
// in that window. Both possible outcomes (recycle's replacement context
// loses the race and throws, or wins the race and has nowhere to go) had to
// stop being "bad" -- see src/browser.ts's `closed` re-checks in
// releaseRecord for the fix.
describe('createPool: close() racing an in-flight recycle', () => {
  it('does not throw from release() or leak a context when close() runs mid-recycle', async () => {
    const raceCfg = loadConfig({ POOL_SIZE: '1', CONTEXT_MAX_USES: '1' })
    const racePool = await createPool(raceCfg)
    try {
      const lease = await racePool.acquire() // uses becomes 1 -- at budget already
      // release() takes the recycle path (uses >= contextMaxUses) and awaits
      // inside it (context.close(), then a fresh browser.newContext()).
      // Calling close() immediately after, before either await settles,
      // reliably lands it inside that window.
      const releasing = lease.release()
      const closing = racePool.close()
      await expect(releasing).resolves.toBeUndefined()
      await expect(closing).resolves.toBeUndefined()
      expect(racePool.liveContexts()).toBe(0)
    } finally {
      await racePool.close().catch(() => {})
    }
  })
})

// Review round 1 also found that a failure inside recycle()'s unguarded
// createContext() call permanently cost the pool a slot -- silently, with no
// error visible to anyone and (worse) a queued waiter left hanging forever.
// The fix: retry context creation once (a single transient failure
// shouldn't cost a permanent slot), and if that also fails, reject the
// waiter queued for this slot -- if any -- and propagate to release()'s
// caller, rather than losing capacity without a trace.
describe('createPool: a failed context recycle', () => {
  it('recovers via one retry and keeps the pool healthy', async () => {
    const cfg2 = loadConfig({ POOL_SIZE: '1', CONTEXT_MAX_USES: '1' })
    const pool2 = await createPool(cfg2, { failNextContextCreations: 1 })
    try {
      const lease = await pool2.acquire() // uses becomes 1 -- at budget
      // recycle's first createContext() attempt is the injected failure;
      // the retry is real and should succeed.
      await expect(lease.release()).resolves.toBeUndefined()
      expect(pool2.liveContexts()).toBe(1)
      const lease2 = await pool2.acquire()
      await lease2.page.setContent('<h1>still alive</h1>')
      expect(await lease2.page.textContent('h1')).toBe('still alive')
      await lease2.release()
    } finally {
      await pool2.close()
    }
  })

  it('rejects a stranded waiter and the releasing caller instead of losing a slot silently', async () => {
    const cfg3 = loadConfig({ POOL_SIZE: '1', CONTEXT_MAX_USES: '1' })
    const pool3 = await createPool(cfg3, { failNextContextCreations: 2 })
    try {
      const a = await pool3.acquire() // uses becomes 1 -- at budget
      // Pool size 1: this queues immediately, and is exactly the caller a
      // silently-lost slot would have stranded forever.
      const waiterPromise = pool3.acquire()
      await expect(a.release()).rejects.toThrow(/replacement browser context/)
      await expect(waiterPromise).rejects.toThrow(/replacement browser context/)
      // The old context was genuinely closed and never replaced -- the pool
      // really does have one fewer live context now, and says so rather
      // than claiming a slot that doesn't exist.
      expect(pool3.liveContexts()).toBe(0)
    } finally {
      await pool3.close()
    }
  })
})

// Fix wave, finding 4: releaseRecord only recycled at `uses >=
// contextMaxUses`, and liveContexts() only counted contexts ever created,
// not contexts still usable. A page that crashed independently -- while
// sitting idle in `free`, untouched -- stayed in the free list (handed out
// to the next acquire()) and kept counting toward liveContexts() until it
// separately happened to also hit its use budget, which could be arbitrarily
// far in the future. /health (`pool.liveContexts() >= 1`) would answer "ok"
// the whole time.
describe('createPool: a crashed page is recycled and stops counting as live immediately', () => {
  it('drops liveContexts() the moment a page closes, and recycles on release regardless of use count', async () => {
    // Pool size 1 so the same slot is guaranteed to cycle back on every
    // acquire -- with a bigger pool, a healthy sibling context could mask
    // the bug by satisfying the next acquire() instead.
    const crashCfg = loadConfig({ POOL_SIZE: '1', CONTEXT_MAX_USES: '50' })
    const crashPool = await createPool(crashCfg)
    try {
      expect(crashPool.liveContexts()).toBe(1)

      const lease = await crashPool.acquire()
      await lease.page.close() // simulates a crashed renderer while the lease is still held
      expect(crashPool.liveContexts()).toBe(0) // the pool's one context is no longer usable

      // uses is only 1, far under contextMaxUses (50) -- must still recycle
      // because the page itself is closed, not because of the use count.
      await expect(lease.release()).resolves.toBeUndefined()
      expect(crashPool.liveContexts()).toBe(1)

      // And the replacement handed out next must actually be usable, not
      // the crashed page returned as-is.
      const lease2 = await crashPool.acquire()
      await lease2.page.setContent('<h1>ok</h1>')
      expect(await lease2.page.textContent('h1')).toBe('ok')
      await lease2.release()
    } finally {
      await crashPool.close().catch(() => {})
    }
  })
})

const TIMED_OUT = Symbol('timed out')

/** `p`'s value if it settles within `ms`, else TIMED_OUT. Never rejects on `p`'s behalf. */
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), ms) })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// Production, 2026-09-19. A lookup that overran produceBudgetMs was answered
// 504, but it kept its lease: the budget rejected the CALLER without stopping
// the WORK, and the work never finished. Two of those, days apart, emptied a
// pool of two, and every later request of every kind waited out the budget
// and failed -- until a restart. /health said "ok" throughout. The holder
// cannot be trusted to give a context back; the pool has to take it.
describe('createPool: a lease past its deadline', () => {
  it('takes the context back from a holder that never releases it, and stops the stuck work', async () => {
    const dCfg = loadConfig({ POOL_SIZE: '1' })
    const dPool = await createPool(dCfg)
    try {
      const lease = await dPool.acquire(AbortSignal.timeout(300))
      // Stuck on the page forever -- the shape of the production hang.
      const stuck = lease.page.evaluate(() => new Promise<never>(() => {})).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )

      // Pool of one: only a slot the pool took back itself can serve this.
      const next = await settlesWithin(dPool.acquire(), 5_000)
      expect(next).not.toBe(TIMED_OUT)
      if (next === TIMED_OUT) return
      // The stuck work was stopped, not left running against a context the
      // pool has already handed to someone else.
      expect(await settlesWithin(stuck, 2_000)).toBe('rejected')
      expect(dPool.liveContexts()).toBe(1)
      await next.page.setContent('<h1>fresh</h1>')
      expect(await next.page.textContent('h1')).toBe('fresh')

      // The revoked holder releasing late must not free the slot a second time.
      await lease.release()
      const whileHeld = await settlesWithin(dPool.acquire(), 300)
      expect(whileHeld).toBe(TIMED_OUT)
      await next.release()
    } finally {
      await dPool.close()
    }
  }, 20_000)

  it('drops a queued caller whose deadline passes, so the next free context goes to a live one', async () => {
    const qCfg = loadConfig({ POOL_SIZE: '1' })
    const qPool = await createPool(qCfg)
    try {
      const held = await qPool.acquire()
      const expired = await settlesWithin(qPool.acquire(AbortSignal.timeout(200)).then(() => 'served', (e: unknown) => e), 2_000)
      expect(expired).toBeInstanceOf(Error)
      expect(qPool.stats().waiting).toBe(0)

      const live = qPool.acquire()
      await held.release()
      // FIFO would hand the context to the expired caller ahead of this one,
      // and nothing would ever release it.
      const got = await settlesWithin(live, 2_000)
      expect(got).not.toBe(TIMED_OUT)
      if (got !== TIMED_OUT) await got.release()
    } finally {
      await qPool.close()
    }
  }, 20_000)

  it('leaves alone a lease released before its deadline, even after that deadline passes', async () => {
    const rCfg = loadConfig({ POOL_SIZE: '1' })
    const rPool = await createPool(rCfg)
    try {
      const early = await rPool.acquire(AbortSignal.timeout(300))
      await early.release()
      // Pool of one: this is the same context, now someone else's.
      const later = await rPool.acquire()
      await new Promise((r) => setTimeout(r, 600))
      expect(later.page.isClosed()).toBe(false)
      await later.release()
    } finally {
      await rPool.close()
    }
  }, 20_000)

  it('reports free, leased and waiting counts', async () => {
    const sCfg = loadConfig({ POOL_SIZE: '2' })
    const sPool = await createPool(sCfg)
    try {
      expect(sPool.stats()).toMatchObject({ free: 2, leased: 0, waiting: 0 })
      const a = await sPool.acquire()
      const b = await sPool.acquire()
      const c = sPool.acquire()
      expect(sPool.stats()).toMatchObject({ free: 0, leased: 2, waiting: 1 })
      await a.release()
      await (await c).release()
      await b.release()
      expect(sPool.stats()).toMatchObject({ free: 2, leased: 0, waiting: 0 })
    } finally {
      await sPool.close()
    }
  }, 20_000)
})

describe('createPool: a context close that never finishes', () => {
  it('abandons the close after CONTEXT_CLOSE_TIMEOUT_MS and refills the slot', async () => {
    const hCfg = loadConfig({ POOL_SIZE: '1', CONTEXT_MAX_USES: '1', CONTEXT_CLOSE_TIMEOUT_MS: '300' })
    const hPool = await createPool(hCfg, { hangNextContextCloses: 1 })
    try {
      const lease = await hPool.acquire() // uses becomes 1 -- at budget, so release recycles
      // Every close happens on a release path: an unbounded one would hold
      // this release, and the slot, forever.
      expect(await settlesWithin(lease.release(), 3_000)).not.toBe(TIMED_OUT)
      expect(hPool.liveContexts()).toBe(1)
      const next = await settlesWithin(hPool.acquire(), 2_000)
      expect(next).not.toBe(TIMED_OUT)
      if (next !== TIMED_OUT) await next.release()
    } finally {
      await hPool.close()
    }
  }, 20_000)
})

describe('createPool: browser generations', () => {
  it('serves from one generation at startup, and says so', async () => {
    const launches: LaunchEvent[] = []
    const gPool = await createPool(loadConfig({ POOL_SIZE: '1' }), {
      observer: { launched: (e) => { launches.push(e) }, launchFailed: () => {} },
    })
    try {
      expect(launches).toHaveLength(1)
      expect(launches[0]).toMatchObject({ reason: 'startup', generation: 1 })
      expect(launches[0]!.pid).toBeGreaterThan(0)
      const stats = gPool.stats()
      expect(stats.generations).toEqual({ serving: 1, draining: 0 })
      expect(stats.browserAgeSeconds).toBeGreaterThanOrEqual(0)
      if (process.platform === 'linux') expect(stats.browserMemoryBytes).toBeGreaterThan(0)
    } finally {
      await gPool.close()
    }
    expect(gPool.stats().generations).toEqual({ serving: 0, draining: 0 })
  }, 20_000)

  it('gives every lease a lost signal that stays quiet when nothing goes wrong', async () => {
    const lPool = await createPool(loadConfig({ POOL_SIZE: '1' }))
    try {
      const lease = await lPool.acquire()
      expect(lease.lost).toBeInstanceOf(AbortSignal)
      await lease.page.setContent('<h1>fine</h1>')
      await lease.release()
      expect(lease.lost.aborted).toBe(false)
    } finally {
      await lPool.close()
    }
  }, 20_000)

  it('reports memory through the reader it is given', async () => {
    const mPool = await createPool(loadConfig({ POOL_SIZE: '1' }), { memoryOf: () => 123_456 })
    try {
      expect(mPool.stats().browserMemoryBytes).toBe(123_456)
    } finally {
      await mPool.close()
    }
  }, 20_000)
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

/** An observer that records every launch and counts failures. */
function observed() {
  const launches: LaunchEvent[] = []
  let failures = 0
  return {
    launches,
    failures: () => failures,
    observer: {
      launched: (e: LaunchEvent) => {
        launches.push(e)
      },
      launchFailed: () => {
        failures++
      },
    },
  }
}

// Before this, nothing listened for the browser going away: a Chromium crash
// made every later context creation fail until someone restarted the
// container, and nothing would, because /health's 503 has no healthcheck
// behind it on either stack.
describe('createPool: a browser crash', () => {
  it('fails the lease it was holding as BrowserUnavailableError, and a new browser takes over', async () => {
    const o = observed()
    const cPool = await createPool(loadConfig({ POOL_SIZE: '1' }), { observer: o.observer })
    try {
      const lease = await cPool.acquire()
      const pending = lease.page.evaluate(() => new Promise<never>(() => {})).catch((e: unknown) => e)
      process.kill(o.launches[0]!.pid, 'SIGKILL')

      expect(await settlesWithin(pending, 5_000)).toBeInstanceOf(Error)
      // The pending call and the death notice race: the call can reject a few
      // milliseconds before the pool hears of the death.
      expect(await waitFor(() => lease.lost.aborted, 5_000)).toBe(true)
      expect(lease.lost.reason).toBeInstanceOf(BrowserUnavailableError)

      const next = await settlesWithin(cPool.acquire(), 15_000)
      expect(next).not.toBe(TIMED_OUT)
      if (next === TIMED_OUT) return
      await next.page.setContent('<h1>after</h1>')
      expect(await next.page.textContent('h1')).toBe('after')
      expect(o.launches.map((e) => e.reason)).toEqual(['startup', 'crash'])
      await next.release()
      await lease.release() // a late release from the dead browser is harmless
      expect(cPool.liveContexts()).toBe(1)
      expect(cPool.stats().generations).toEqual({ serving: 1, draining: 0 })
    } finally {
      await cPool.close()
    }
  }, 30_000)

  it('serves a caller that was already queued when the browser died', async () => {
    const o = observed()
    const qPool = await createPool(loadConfig({ POOL_SIZE: '1' }), { observer: o.observer })
    try {
      const held = await qPool.acquire()
      const queued = qPool.acquire()
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      const got = await settlesWithin(queued, 15_000)
      expect(got).not.toBe(TIMED_OUT)
      if (got === TIMED_OUT) return
      await got.page.setContent('<h1>served</h1>')
      expect(await got.page.textContent('h1')).toBe('served')
      await got.release()
      await held.release()
    } finally {
      await qPool.close()
    }
  }, 30_000)

  it('backs off between failed relaunches and recovers without giving up', async () => {
    const o = observed()
    const fatal = vi.fn()
    const bPool = await createPool(loadConfig({ POOL_SIZE: '1' }), {
      observer: o.observer,
      onFatal: fatal,
      failNextLaunches: 2,
      backoffBaseMs: 50,
    })
    try {
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(o.failures()).toBe(2)
      expect(fatal).not.toHaveBeenCalled()
      expect(bPool.liveContexts()).toBe(1)
    } finally {
      await bPool.close()
    }
  }, 30_000)

  it('gives up after BROWSER_MAX_RELAUNCH_FAILURES failed relaunches, calling onFatal exactly once', async () => {
    const o = observed()
    const fatal = vi.fn()
    const gPool = await createPool(loadConfig({ POOL_SIZE: '1', BROWSER_MAX_RELAUNCH_FAILURES: '3' }), {
      observer: o.observer,
      onFatal: fatal,
      failNextLaunches: 10,
      backoffBaseMs: 10,
    })
    try {
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => fatal.mock.calls.length > 0, 10_000)).toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      expect(fatal).toHaveBeenCalledTimes(1)
      expect(fatal.mock.calls[0]![0]).toBeInstanceOf(Error)
      expect(o.failures()).toBe(3)
      expect(gPool.liveContexts()).toBe(0)
    } finally {
      await gPool.close()
    }
  }, 30_000)
})

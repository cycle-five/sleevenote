import { describe, it, expect, afterAll, vi } from 'vitest'
import {
  createPool,
  BrowserUnavailableError,
  PoolClosedError,
  PoolOverloadedError,
  type LaunchEvent,
  type Lease,
} from '../src/browser.js'
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

/** An observer that records every launch and failure, with timestamps for backoff assertions. */
function observed() {
  const launches: LaunchEvent[] = []
  const launchedAt: number[] = []
  const failedAt: number[] = []
  return {
    launches,
    launchedAt,
    failedAt,
    failures: () => failedAt.length,
    observer: {
      launched: (e: LaunchEvent) => {
        launches.push(e)
        launchedAt.push(Date.now())
      },
      launchFailed: () => {
        failedAt.push(Date.now())
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
      // The startup browser's death is not the failure under test here.
      stableAfterMs: 0,
    })
    try {
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(o.failures()).toBe(2)
      expect(fatal).not.toHaveBeenCalled()
      expect(bPool.liveContexts()).toBe(1)
      // backoff(1) = 50ms separates failure 1 from failure 2; backoff(2) =
      // 100ms separates failure 2 from the launch that finally succeeds.
      // Lower bounds only -- a slow CI runner can only widen the gap, never
      // shrink it, and asserting an upper bound would flake there.
      expect(o.failedAt[1]! - o.failedAt[0]!).toBeGreaterThanOrEqual(45)
      expect(o.launchedAt[1]! - o.failedAt[1]!).toBeGreaterThanOrEqual(95)
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
      // Only the failed launches count toward the limit here.
      stableAfterMs: 0,
    })
    try {
      const held = await gPool.acquire()
      // Queued before the kill: the only thing that fails a caller stuck
      // behind a relaunch that gives up, rather than leaving it hanging until
      // its own deadline.
      const queued = gPool.acquire().catch((e: unknown) => e)
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => fatal.mock.calls.length > 0, 10_000)).toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      expect(fatal).toHaveBeenCalledTimes(1)
      expect(fatal.mock.calls[0]![0]).toBeInstanceOf(Error)
      expect(o.failures()).toBe(3)
      expect(gPool.liveContexts()).toBe(0)
      expect(await settlesWithin(queued, 5_000)).toBeInstanceOf(BrowserUnavailableError)
      await held.release() // a late release from the dead browser is harmless
    } finally {
      await gPool.close()
    }
  }, 30_000)

  // Final review, 2026-09-19: a browser that filled and then died soon after
  // -- an OOM, a crash on its first navigation, pid pressure from zombies --
  // reset the failure count at every promote. It was relaunched at once,
  // forever: no backoff, and onFatal never called, when a container restart
  // is exactly what clears that state.
  it('backs off and gives up on a browser that keeps dying young', async () => {
    const o = observed()
    const fatal = vi.fn()
    const base = 500
    const yPool = await createPool(loadConfig({ POOL_SIZE: '1', BROWSER_MAX_RELAUNCH_FAILURES: '4' }), {
      observer: {
        launched: (e) => {
          o.observer.launched(e)
          // Killed as soon as it serves: promote() runs in the microtasks
          // straight after this call, so a timer lands after it.
          setTimeout(() => {
            try { process.kill(e.pid, 'SIGKILL') } catch { /* already gone */ }
          }, 0)
        },
        launchFailed: o.observer.launchFailed,
      },
      onFatal: fatal,
      backoffBaseMs: base,
      stableAfterMs: 5_000,
    })
    try {
      expect(await waitFor(() => fatal.mock.calls.length > 0, 20_000)).toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      expect(fatal).toHaveBeenCalledTimes(1)
      expect(fatal.mock.calls[0]![0]).toBeInstanceOf(Error)
      // Four generations died young; the fourth death is the limit, so no fifth launch.
      expect(o.launches.map((e) => e.reason)).toEqual(['startup', 'crash', 'crash', 'crash'])
      // An early death is not a failed launch: that counter means launches that failed.
      expect(o.failures()).toBe(0)
      const gaps = o.launchedAt.slice(1).map((at, i) => at - o.launchedAt[i]!)
      // backoff(1), backoff(2) and backoff(3) before the three relaunches.
      // Lower bounds only, as in the relaunch backoff test above.
      expect(gaps[0]!).toBeGreaterThanOrEqual(base)
      expect(gaps[1]!).toBeGreaterThanOrEqual(2 * base)
      expect(gaps[2]!).toBeGreaterThanOrEqual(4 * base)
      expect(gaps[1]!).toBeGreaterThanOrEqual(gaps[0]!)
      expect(gaps[2]!).toBeGreaterThanOrEqual(gaps[1]!)
    } finally {
      await yPool.close()
    }
  }, 40_000)

  // The count resets once a browser has served STABLE_AFTER_MS, on the tick.
  // At its own death is not enough: a recycle's replacement dies with its
  // own young age, and would inherit failures its predecessor outlived.
  it('forgets past failures once a browser has served the stability window', async () => {
    let t = 0
    const o = observed()
    const fatal = vi.fn()
    const sPool = await createPool(
      loadConfig({
        POOL_SIZE: '1',
        BROWSER_MAX_RELAUNCH_FAILURES: '2',
        BROWSER_MAX_AGE_MS: '60000',
        BROWSER_CHECK_INTERVAL_MS: '50',
      }),
      { observer: o.observer, onFatal: fatal, now: () => t, backoffBaseMs: 50, stableAfterMs: 1_000 },
    )
    try {
      process.kill(o.launches[0]!.pid, 'SIGKILL') // dies young: failure 1 of 2
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      t = 60_000 // generation 2 is now stable, and old enough to recycle
      expect(await waitFor(() => o.launches.length === 3, 15_000)).toBe(true)
      expect(o.launches[2]!.reason).toBe('recycle_age')
      process.kill(o.launches[2]!.pid, 'SIGKILL') // the replacement dies young
      expect(await waitFor(() => o.launches.length === 4, 15_000)).toBe(true)
      expect(o.launches[3]!.reason).toBe('crash')
      expect(fatal).not.toHaveBeenCalled()
    } finally {
      await sPool.close()
    }
  }, 40_000)

  // A listener on `lost` runs inside the pool's death handling. If the dead
  // generation were still the serving one at that moment, an acquire() made
  // there would be handed its free context -- on a browser that is gone.
  it('never hands a caller acquiring from inside a lost listener a context on the dead browser', async () => {
    const o = observed()
    const dPool = await createPool(loadConfig({ POOL_SIZE: '2' }), { observer: o.observer })
    try {
      const held = await dPool.acquire()
      const again: Promise<Lease>[] = []
      held.lost.addEventListener('abort', () => { again.push(dPool.acquire()) })
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => again.length === 1, 5_000)).toBe(true)
      const next = await settlesWithin(again[0]!, 15_000)
      expect(next).not.toBe(TIMED_OUT)
      if (next === TIMED_OUT) return
      expect(next.page.context().browser()).not.toBe(held.page.context().browser())
      await next.page.setContent('<h1>alive</h1>')
      expect(await next.page.textContent('h1')).toBe('alive')
      await next.release()
      await held.release()
    } finally {
      await dPool.close()
    }
  }, 30_000)

  it('does not let a relaunched browser outlive close()', async () => {
    const o = observed()
    const connected: number[] = []
    let releaseFill = (): void => {}
    const fillHeld = new Promise<void>((resolve) => { releaseFill = resolve })
    const cPool = await createPool(loadConfig({ POOL_SIZE: '1' }), {
      observer: o.observer,
      // The relaunch is held between connect and fill until close() has
      // started, so close() lands mid-launch every time.
      afterConnect: (pid) => {
        connected.push(pid)
        if (connected.length === 2) return fillHeld
      },
    })
    try {
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => connected.length === 2, 15_000)).toBe(true)
      const closing = cPool.close()
      releaseFill()
      await closing
      expect(isAlive(connected[1]!)).toBe(false)
    } finally {
      releaseFill()
      await cPool.close()
    }
  }, 30_000)
})

/**
 * An `afterConnect` hook that, once armed, SIGSTOPs the next browsers to
 * connect: alive, connected, and answering nothing -- a wedged Chromium, the
 * reviewer's probe made into a fixture. SIGKILL still reaps a stopped
 * process, so the pool can kill it; `reap()` is the test's own safety net.
 */
function wedger() {
  const stopped: number[] = []
  let remaining = 0
  return {
    stopped,
    arm: (n = Number.POSITIVE_INFINITY) => { remaining = n },
    afterConnect: (pid: number) => {
      if (remaining <= 0) return
      remaining--
      process.kill(pid, 'SIGSTOP')
      stopped.push(pid)
    },
    reap: () => {
      remaining = 0
      for (const pid of stopped) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
    },
  }
}

// Final review, 2026-09-19: a Chromium that is alive but not answering held
// the fill -- newContext, newPage, route -- forever. A relaunch never failed,
// so it never escalated; a recycle never finished, so close() never did; and
// at startup createPool() never resolved. A 503 forever without an exit.
describe('createPool: a browser that is alive but not answering', () => {
  it('kills a relaunch whose fill hangs, counts it as failed, retries, and gives up at the limit', async () => {
    const o = observed()
    const fatal = vi.fn()
    const w = wedger()
    const hPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_RELAUNCH_FAILURES: '2', BROWSER_CLOSE_TIMEOUT_MS: '500' }),
      // stableAfterMs 0: only the hung fills count toward the limit.
      { observer: o.observer, onFatal: fatal, afterConnect: w.afterConnect, fillTimeoutMs: 1_000, backoffBaseMs: 50, stableAfterMs: 0 },
    )
    try {
      w.arm()
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => fatal.mock.calls.length > 0, 20_000)).toBe(true)
      expect(fatal).toHaveBeenCalledTimes(1)
      expect(o.failures()).toBe(2)
      // Retried: a second browser, not a second wait on the first.
      expect(w.stopped).toHaveLength(2)
      expect(o.launches.map((e) => e.reason)).toEqual(['startup'])
      for (const pid of w.stopped) expect(await waitFor(() => !isAlive(pid), 2_000)).toBe(true)
    } finally {
      w.reap()
      await hPool.close()
    }
  }, 40_000)

  // index.ts's onFatal exits 1: reached during a clean shutdown, it would
  // turn every deploy that caught a relaunch mid-launch into a failed exit.
  it('neither counts nor escalates a relaunch that fails after close()', async () => {
    const o = observed()
    const fatal = vi.fn()
    const w = wedger()
    const cPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_RELAUNCH_FAILURES: '1', BROWSER_CLOSE_TIMEOUT_MS: '500' }),
      // stableAfterMs 0, or the startup browser's death alone reaches a limit of 1.
      { observer: o.observer, onFatal: fatal, afterConnect: w.afterConnect, fillTimeoutMs: 1_000, stableAfterMs: 0 },
    )
    try {
      w.arm(1)
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => w.stopped.length === 1, 15_000)).toBe(true)
      expect(await settlesWithin(cPool.close(), 10_000)).not.toBe(TIMED_OUT)
      expect(fatal).not.toHaveBeenCalled()
      expect(o.failures()).toBe(0)
    } finally {
      w.reap()
      await cPool.close()
    }
  }, 30_000)

  it('lets close() finish while a recycle launch is wedged, and leaves nothing of that launch alive', async () => {
    let t = 0
    const o = observed()
    const w = wedger()
    const rPool = await createPool(
      loadConfig({
        POOL_SIZE: '1',
        BROWSER_MAX_AGE_MS: '60000',
        BROWSER_CHECK_INTERVAL_MS: '50',
        BROWSER_CLOSE_TIMEOUT_MS: '500',
      }),
      { observer: o.observer, now: () => t, afterConnect: w.afterConnect, fillTimeoutMs: 2_000 },
    )
    try {
      w.arm(1)
      t = 60_000
      expect(await waitFor(() => w.stopped.length === 1, 15_000)).toBe(true)
      expect(await settlesWithin(rPool.close(), 10_000)).not.toBe(TIMED_OUT)
      expect(await waitFor(() => !isAlive(w.stopped[0]!), 2_000)).toBe(true)
      expect(isAlive(o.launches[0]!.pid)).toBe(false)
    } finally {
      w.reap()
      await rPool.close()
    }
  }, 40_000)

  it('rejects createPool() rather than hanging when the startup browser is wedged', async () => {
    const w = wedger()
    w.arm(1)
    try {
      const outcome = await settlesWithin(
        createPool(loadConfig({ POOL_SIZE: '1', BROWSER_CLOSE_TIMEOUT_MS: '500' }), {
          afterConnect: w.afterConnect,
          fillTimeoutMs: 1_000,
        }).then(
          async (p) => {
            await p.close()
            return 'resolved' as const
          },
          (e: unknown) => e,
        ),
        10_000,
      )
      expect(outcome).toBeInstanceOf(Error)
      expect(await waitFor(() => !isAlive(w.stopped[0]!), 2_000)).toBe(true)
    } finally {
      w.reap()
    }
  }, 30_000)
})

describe('createPool: recycling the browser', () => {
  it('recycles on age, draining the old browser rather than cutting it off', async () => {
    let t = 0
    const o = observed()
    const rPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_AGE_MS: '60000', BROWSER_CHECK_INTERVAL_MS: '50' }),
      { observer: o.observer, now: () => t },
    )
    try {
      const old = await rPool.acquire()
      t = 60_000
      expect(await waitFor(() => rPool.stats().generations.draining === 1, 15_000)).toBe(true)
      expect(o.launches.map((e) => e.reason)).toEqual(['startup', 'recycle_age'])

      // Drained, not revoked: the lease on the old browser still works.
      await old.page.setContent('<h1>still mine</h1>')
      expect(await old.page.textContent('h1')).toBe('still mine')

      // A draining browser never hands out a context; the new one does.
      const fresh = await settlesWithin(rPool.acquire(), 2_000)
      expect(fresh).not.toBe(TIMED_OUT)
      if (fresh === TIMED_OUT) return
      expect(fresh.page.context().browser()).not.toBe(old.page.context().browser())
      expect(rPool.liveContexts()).toBe(1)

      await fresh.release()
      await old.release()
      expect(await waitFor(() => rPool.stats().generations.draining === 0, 15_000)).toBe(true)
      expect(await waitFor(() => !isAlive(o.launches[0]!.pid), 15_000)).toBe(true)
    } finally {
      await rPool.close()
    }
  }, 60_000)

  it('recycles once BROWSER_MAX_LEASES leases have been served', async () => {
    const o = observed()
    const lPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_LEASES: '3', BROWSER_CHECK_INTERVAL_MS: '600000' }),
      { observer: o.observer },
    )
    try {
      for (let i = 0; i < 2; i++) await (await lPool.acquire()).release()
      await new Promise((r) => setTimeout(r, 200))
      expect(o.launches).toHaveLength(1) // two leases: under the limit
      await (await lPool.acquire()).release()
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(o.launches[1]!.reason).toBe('recycle_leases')
      // Nothing was leased from the old browser, so it drains at once.
      expect(await waitFor(() => !isAlive(o.launches[0]!.pid), 15_000)).toBe(true)
    } finally {
      await lPool.close()
    }
  }, 60_000)

  it('recycles when the browser grows past BROWSER_MAX_MEMORY_MB', async () => {
    let bytes = 1
    const o = observed()
    const mPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_MEMORY_MB: '100', BROWSER_CHECK_INTERVAL_MS: '50' }),
      // Only the first browser grows: the replacement is sampled at launch,
      // and a fake that reported 100 MB for it too could start a third.
      { observer: o.observer, memoryOf: (pid) => (pid === o.launches[0]?.pid ? bytes : 1) },
    )
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(o.launches).toHaveLength(1) // under the limit
      bytes = 100 * 1024 * 1024
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(o.launches[1]!.reason).toBe('recycle_memory')
      await new Promise((r) => setTimeout(r, 300))
      expect(o.launches).toHaveLength(2) // the replacement is under the limit

    } finally {
      await mPool.close()
    }
  }, 60_000)

  it('keeps the old browser serving when a recycle launch fails, and never gives up over it', async () => {
    let t = 0
    const o = observed()
    const fatal = vi.fn()
    const fPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_AGE_MS: '60000', BROWSER_CHECK_INTERVAL_MS: '50' }),
      // Two injected failures: a retry that came too soon fails at once, on
      // the next 50ms tick, rather than after a real launch's second or so.
      { observer: o.observer, now: () => t, failNextLaunches: 2, onFatal: fatal },
    )
    try {
      t = 60_000
      expect(await waitFor(() => o.failures() === 1, 15_000)).toBe(true)
      expect(fPool.stats().generations).toEqual({ serving: 1, draining: 0 })
      const lease = await settlesWithin(fPool.acquire(), 2_000)
      expect(lease).not.toBe(TIMED_OUT)
      if (lease !== TIMED_OUT) await lease.release()

      // Held inside the backoff: the trigger still holds and the tick keeps
      // checking it, but nothing launches until the backoff has passed.
      await new Promise((r) => setTimeout(r, 300))
      expect(o.failures()).toBe(1)
      expect(o.launches).toHaveLength(1)

      t = 60_000 + 1_000 // past backoff(1): the second attempt, which fails too
      expect(await waitFor(() => o.failures() === 2, 15_000)).toBe(true)

      // Past the backoff, the next attempt succeeds.
      t = 60_000 + 60_000
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(fatal).not.toHaveBeenCalled()
    } finally {
      await fPool.close()
    }
  }, 60_000)

  // A recycle already launching when the serving browser dies adopts the
  // empty slot itself. A relaunch that did not wait for it would start a
  // second browser, and one of the two would be thrown away.
  it('lets a recycle already launching take over when the serving browser dies', async () => {
    let t = 0
    const o = observed()
    const connected: number[] = []
    const aPool = await createPool(
      loadConfig({ POOL_SIZE: '2', BROWSER_MAX_AGE_MS: '60000', BROWSER_CHECK_INTERVAL_MS: '50' }),
      {
        observer: o.observer,
        now: () => t,
        // The recycle's browser is held between connect and fill until the
        // pool has seen the serving one die, so the death lands mid-launch.
        afterConnect: async (pid) => {
          connected.push(pid)
          if (connected.length !== 2) return
          process.kill(o.launches[0]!.pid, 'SIGKILL')
          await waitFor(() => aPool.stats().generations.serving === 0, 5_000)
        },
      },
    )
    try {
      t = 60_000
      expect(await waitFor(() => aPool.liveContexts() === 2 && o.launches.length === 2, 15_000)).toBe(true)
      // Long enough for a second, surplus launch to have shown itself.
      await new Promise((r) => setTimeout(r, 1_000))
      expect(o.launches.map((e) => e.reason)).toEqual(['startup', 'recycle_age'])
      expect(aPool.liveContexts()).toBe(2)
      expect(aPool.stats().generations).toEqual({ serving: 1, draining: 0 })
    } finally {
      await aPool.close()
    }
  }, 60_000)

  // Spec §2: in a draining generation nothing replaces a revoked context.
  // Without releaseRecord's first non-serving branch, a lease ending there
  // would open a fresh context on the draining browser only to close it
  // again. The observable is that browser's own newContext().
  it('opens no context in a draining browser when a lease ends there', async () => {
    let t = 0
    const dPool = await createPool(
      loadConfig({ POOL_SIZE: '2', CONTEXT_MAX_USES: '1', BROWSER_MAX_AGE_MS: '60000', BROWSER_CHECK_INTERVAL_MS: '50' }),
      { now: () => t },
    )
    try {
      const deadline = new AbortController()
      const revoked = await dPool.acquire(deadline.signal)
      const spent = await dPool.acquire() // already at CONTEXT_MAX_USES
      const newContext = vi.spyOn(spent.page.context().browser()!, 'newContext')
      t = 60_000
      expect(await waitFor(() => dPool.stats().generations.draining === 1, 15_000)).toBe(true)
      deadline.abort(new Error('deadline (test)')) // revoked, into the draining generation
      await spent.release() // at its use budget, into the draining generation
      expect(await waitFor(() => dPool.stats().generations.draining === 0, 15_000)).toBe(true)
      expect(newContext).not.toHaveBeenCalled()
      await revoked.release() // a no-op: the pool already took it back
    } finally {
      await dPool.close()
    }
  }, 60_000)
})

// Unnamed, all three read as a bare `Error: ...` in a log line, which is
// exactly where telling them apart matters.
describe('pool errors', () => {
  it('name themselves', () => {
    expect(String(new BrowserUnavailableError('gone'))).toBe('BrowserUnavailableError: gone')
    expect(String(new PoolOverloadedError('busy'))).toBe('PoolOverloadedError: busy')
    expect(new PoolClosedError().name).toBe('PoolClosedError')
  })
})

// Before this, an excess caller waited up to the whole budget just to queue,
// then got the same 504 as a genuinely stuck extraction.
describe('createPool: the wait cap', () => {
  it('turns a caller away with PoolOverloadedError once it has waited POOL_WAIT_CAP_MS', async () => {
    const wPool = await createPool(loadConfig({ POOL_SIZE: '1', POOL_WAIT_CAP_MS: '300' }))
    try {
      const held = await wPool.acquire()
      const started = Date.now()
      const err = await settlesWithin(wPool.acquire().catch((e: unknown) => e), 5_000)
      expect(err).toBeInstanceOf(PoolOverloadedError)
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(wPool.stats().waiting).toBe(0)
      await held.release()
    } finally {
      await wPool.close()
    }
  }, 20_000)

  it('answers BrowserUnavailableError when no browser was serving while the caller waited', async () => {
    const o = observed()
    const uPool = await createPool(loadConfig({ POOL_SIZE: '1', POOL_WAIT_CAP_MS: '300' }), {
      observer: o.observer,
      failNextLaunches: 10,
      backoffBaseMs: 60_000, // the relaunch stays pending for the whole test
    })
    try {
      process.kill(o.launches[0]!.pid, 'SIGKILL')
      expect(await waitFor(() => uPool.liveContexts() === 0, 5_000)).toBe(true)
      const err = await settlesWithin(uPool.acquire().catch((e: unknown) => e), 5_000)
      expect(err).toBeInstanceOf(BrowserUnavailableError)
    } finally {
      await uPool.close()
    }
  }, 20_000)
})

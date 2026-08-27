import { describe, it, expect } from 'vitest'
import { MemoryStore, cacheKey, withCache } from '../src/cache.js'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('defaults playlist TTL to four hours and track TTL to thirty days', () => {
    const c = loadConfig({})
    expect(c.ttl.playlist).toBe(4 * 3600)
    expect(c.ttl.track).toBe(30 * 24 * 3600)
  })

  it('rejects a nonsense value loudly instead of silently defaulting', () => {
    expect(() => loadConfig({ PORT: 'banana' })).toThrow()
    expect(() => loadConfig({ POOL_SIZE: '0' })).toThrow()
  })
})

describe('cacheKey', () => {
  it('is versioned and type-scoped', () => {
    expect(cacheKey('track', 'abc')).toBe('v1:track:abc')
  })
})

describe('withCache', () => {
  it('calls produce on a miss and serves the value from cache next time', async () => {
    const store = new MemoryStore()
    let calls = 0
    const produce = async () => { calls++; return { n: 1 } }

    const a = await withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce })
    expect(a.hit).toBe('miss')
    expect(a.staleError).toBeUndefined()
    const b = await withCache({ store, key: 'k', ttlSeconds: 60, now: 1001, produce })
    expect(b.hit).toBe('fresh')
    expect(b.staleError).toBeUndefined()
    expect(calls).toBe(1)
    expect(b.value).toEqual({ n: 1 })
  })

  // The aggressive bit. A slightly old playlist beats an error.
  it('serves an expired entry when produce throws', async () => {
    const store = new MemoryStore()
    await withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce: async () => ({ n: 1 }) })

    const later = await withCache({
      store, key: 'k', ttlSeconds: 60, now: 1_000_000,
      produce: async () => { throw new Error('scrape failed') },
    })
    expect(later.hit).toBe('stale')
    expect(later.value).toEqual({ n: 1 })
  })

  // Task 6 fix round 2: withCache used to swallow produce()'s error entirely
  // once a fallback entry existed to serve instead -- a caller had no way to
  // know production had failed at all, only that it got a (possibly very
  // stale) value. `staleError` restores that visibility without changing
  // what's returned as `value`: the caller decides what to do with it (Task
  // 6's server.ts increments its failure counters, still returns 200).
  it('surfaces the swallowed error as staleError when serving a stale fallback', async () => {
    const store = new MemoryStore()
    await withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce: async () => ({ n: 1 }) })

    const thrown = new Error('scrape failed')
    const later = await withCache({
      store, key: 'k', ttlSeconds: 60, now: 1_000_000,
      produce: async () => { throw thrown },
    })
    expect(later.hit).toBe('stale')
    expect(later.value).toEqual({ n: 1 })
    expect(later.staleError).toBe(thrown)
  })

  it('propagates the error when produce throws and nothing is cached', async () => {
    const store = new MemoryStore()
    await expect(withCache({
      store, key: 'k', ttlSeconds: 60, now: 1000,
      produce: async () => { throw new Error('scrape failed') },
    })).rejects.toThrow('scrape failed')
  })

  // Without this, one playlist pasted in two guilds is two Chromium page loads.
  it('coalesces concurrent misses for the same key into one produce call', async () => {
    const store = new MemoryStore()
    let calls = 0
    const produce = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 50))
      return { n: 1 }
    }
    const results = await Promise.all([
      withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce }),
      withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce }),
      withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce }),
    ])
    expect(calls).toBe(1)
    for (const r of results) expect(r.value).toEqual({ n: 1 })
  })

  // The lock's TTL and a waiter's wait timeout must both come from
  // produceBudgetMs, not a hardcoded constant -- otherwise a produce() that
  // legitimately runs longer than the hardcoded value causes the lock to
  // expire mid-flight, and a second caller starts a redundant, concurrent
  // produce() call of its own. A tiny custom budget here proves the wait
  // timeout actually honours the option rather than a fixed default.
  it('honors a custom produceBudgetMs for the lock-wait timeout', async () => {
    const store = new MemoryStore()
    // Simulate another caller already holding the lock for far longer than
    // our budget below.
    await store.lock('k:lock', 60)
    let calls = 0
    const produce = async () => { calls++; return { n: 2 } }

    const start = Date.now()
    const result = await withCache({
      store, key: 'k', ttlSeconds: 60, now: 1000, produce, produceBudgetMs: 200,
    })
    const elapsed = Date.now() - start

    expect(result.hit).toBe('miss')
    expect(result.value).toEqual({ n: 2 })
    expect(calls).toBe(1)
    // Fell through close to the 200ms budget, not the (much larger) default.
    expect(elapsed).toBeLessThan(2000)
  })

  // Regression for a labelling bug: the error branch used to assume any
  // entry it found was stale, reasoning that a fresh one would have
  // short-circuited the caller earlier. That reasoning breaks once a
  // lock-wait timeout can fall through and produce directly -- a *different*
  // caller can race ahead, succeed, and write a fresh entry while the
  // original lock-holder is still failing.
  it('labels an entry found after a failure as fresh, not stale, when a different caller just produced it', async () => {
    const store = new MemoryStore()

    // Holder: acquires the lock normally, then fails slowly.
    const holder = withCache({
      store, key: 'k', ttlSeconds: 60, now: 1000, produceBudgetMs: 5000,
      produce: async () => {
        await new Promise((r) => setTimeout(r, 300))
        throw new Error('holder failed')
      },
    })
    // Waiter: can't get the lock, times out almost immediately (tiny
    // budget), falls through, and produces successfully well before the
    // holder fails.
    const waiter = withCache({
      store, key: 'k', ttlSeconds: 60, now: 1000, produceBudgetMs: 50,
      produce: async () => ({ n: 99 }),
    })

    const [holderResult, waiterResult] = await Promise.all([holder, waiter])

    expect(waiterResult.hit).toBe('miss')
    expect(waiterResult.value).toEqual({ n: 99 })
    expect(waiterResult.staleError).toBeUndefined()
    // The holder's own produce() failed, but the entry it finds afterward
    // was just written by the waiter and is genuinely fresh.
    expect(holderResult.hit).toBe('fresh')
    expect(holderResult.value).toEqual({ n: 99 })
    // Task 6 fix round 2: the holder's OWN produce() genuinely failed, even
    // though the value it ends up serving is fresh (written by the waiter,
    // not by it) -- that failure is real and worth a caller's attention
    // regardless of which concurrent write happened to win the race, so
    // staleError is set here too, not only in the hit === 'stale' case.
    expect(holderResult.staleError).toBeInstanceOf(Error)
    expect((holderResult.staleError as Error).message).toBe('holder failed')
  })
})

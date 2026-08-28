import { describe, it, expect, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
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

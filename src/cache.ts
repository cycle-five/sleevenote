import type { CacheStore } from './store.js'
import { DEFAULT_PRODUCE_BUDGET_MS } from './config.js'

// Tests import `MemoryStore` (and the rest of the store surface) from this
// module rather than from `store.js` directly -- callers of the cache only
// need one import path.
export * from './store.js'

export type Entry<T> = { value: T; storedAt: number }

export function cacheKey(type: 'track' | 'album' | 'playlist', id: string): string {
  return `v1:${type}:${id}`
}

const LOCK_POLL_INTERVAL_MS = 50

// Physical entries outlive their logical TTL by this factor, so an expired
// entry is still sitting in the store -- and available to stale-on-error --
// for a while after it stops being served as fresh. Without this the store
// would evict a key at almost the same moment it goes stale, and
// stale-on-error would have nothing left to serve.
const STALE_GRACE_MULTIPLIER = 2

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readEntry<T>(store: CacheStore, key: string): Promise<Entry<T> | null> {
  const raw = await store.get(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as Entry<T>
  } catch {
    // A corrupt entry is not a cached entry.
    return null
  }
}

function isFresh(entry: Entry<unknown>, ttlSeconds: number, now: number): boolean {
  return now - entry.storedAt < ttlSeconds
}

/**
 * Run `produce`, cache the result, and report it as a miss -- unless it
 * throws, in which case an existing entry is served instead of the error, if
 * one is there to serve.
 *
 * That entry is not necessarily stale: this is also called from the
 * lock-wait timeout fallback, so it's possible for a *different* caller to
 * have raced ahead of us, produced successfully, and written a fresh entry
 * while we were still failing. `hit` feeds cache-hit-rate observability, so
 * it must reflect what's actually true, not just "produce() threw" -- an
 * entry found here is labelled 'fresh' or 'stale' by the same freshness
 * check as everywhere else, never assumed.
 */
async function produceAndCache<T>(
  store: CacheStore,
  key: string,
  ttlSeconds: number,
  now: number,
  produce: () => Promise<T>,
): Promise<{ value: T; hit: 'fresh' | 'stale' | 'miss' }> {
  try {
    const value = await produce()
    const entry: Entry<T> = { value, storedAt: now }
    await store.set(key, JSON.stringify(entry), ttlSeconds * STALE_GRACE_MULTIPLIER)
    return { value, hit: 'miss' }
  } catch (err) {
    const found = await readEntry<T>(store, key)
    if (found) {
      return { value: found.value, hit: isFresh(found, ttlSeconds, now) ? 'fresh' : 'stale' }
    }
    throw err
  }
}

/**
 * The cache policy: freshness by stored timestamp (not the store's own TTL
 * clock -- `now` is caller-supplied so this is testable without wall-clock
 * time actually passing), single-flight production via an advisory lock, and
 * stale-on-error fallback. See task-3-brief.md and the team lead's context
 * for why these two behaviours are the point of this module.
 *
 * `produceBudgetMs` bounds how long `produce()` may legitimately run (see
 * `DEFAULT_PRODUCE_BUDGET_MS` in config.ts for the derivation) and governs
 * both the single-flight lock's TTL and how long a waiter polls before
 * falling through to produce directly -- one number governs both, so a
 * caller that threads its own `config.produceBudgetMs` through here can
 * never have the lock disagree with reality about how long production takes.
 * Defaults to the same value `loadConfig` defaults to, for callers (and
 * tests) that don't have a `Config` to hand.
 */
export async function withCache<T>(opts: {
  store: CacheStore
  key: string
  ttlSeconds: number
  now: number
  produce: () => Promise<T>
  produceBudgetMs?: number
}): Promise<{ value: T; hit: 'fresh' | 'stale' | 'miss' }> {
  const { store, key, ttlSeconds, now, produce } = opts
  const produceBudgetMs = opts.produceBudgetMs ?? DEFAULT_PRODUCE_BUDGET_MS
  const lockTtlSeconds = Math.ceil(produceBudgetMs / 1000)
  const lockWaitTimeoutMs = produceBudgetMs

  const existing = await readEntry<T>(store, key)
  if (existing && isFresh(existing, ttlSeconds, now)) {
    return { value: existing.value, hit: 'fresh' }
  }

  const lockKey = `${key}:lock`
  const acquired = await store.lock(lockKey, lockTtlSeconds)

  if (acquired) {
    try {
      return await produceAndCache(store, key, ttlSeconds, now, produce)
    } finally {
      await store.unlock(lockKey)
    }
  }

  // Someone else is producing this key. Poll for them to finish rather than
  // doing redundant work ourselves -- this is what makes concurrent misses
  // for the same key share a single produce() call.
  const deadline = Date.now() + lockWaitTimeoutMs
  while (Date.now() < deadline) {
    await sleep(LOCK_POLL_INTERVAL_MS)
    const candidate = await readEntry<T>(store, key)
    if (candidate && isFresh(candidate, ttlSeconds, now)) {
      return { value: candidate.value, hit: 'fresh' }
    }
  }

  // The lock holder took too long -- crashed mid-produce, or just slow.
  // Either way, a slow peer must not become an error for this caller: fall
  // through and produce directly instead of waiting forever or failing.
  return produceAndCache(store, key, ttlSeconds, now, produce)
}

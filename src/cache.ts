import type { CacheStore } from './store.js'

// Tests import `MemoryStore` (and the rest of the store surface) from this
// module rather than from `store.js` directly -- callers of the cache only
// need one import path.
export * from './store.js'

export type Entry<T> = { value: T; storedAt: number }

export function cacheKey(type: 'track' | 'album' | 'playlist', id: string): string {
  return `v1:${type}:${id}`
}

const LOCK_TTL_SECONDS = 30
const LOCK_POLL_INTERVAL_MS = 50
const LOCK_WAIT_TIMEOUT_MS = 30_000

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
 * throws, in which case an existing (necessarily expired, since a fresh one
 * would have short-circuited the caller already) entry is served as stale
 * instead of the error, if one is there to serve.
 */
async function produceAndCache<T>(
  store: CacheStore,
  key: string,
  ttlSeconds: number,
  now: number,
  produce: () => Promise<T>,
): Promise<{ value: T; hit: 'stale' | 'miss' }> {
  try {
    const value = await produce()
    const entry: Entry<T> = { value, storedAt: now }
    await store.set(key, JSON.stringify(entry), ttlSeconds * STALE_GRACE_MULTIPLIER)
    return { value, hit: 'miss' }
  } catch (err) {
    const stale = await readEntry<T>(store, key)
    if (stale) return { value: stale.value, hit: 'stale' }
    throw err
  }
}

/**
 * The cache policy: freshness by stored timestamp (not the store's own TTL
 * clock -- `now` is caller-supplied so this is testable without wall-clock
 * time actually passing), single-flight production via an advisory lock, and
 * stale-on-error fallback. See task-3-brief.md and the team lead's context
 * for why these two behaviours are the point of this module.
 */
export async function withCache<T>(opts: {
  store: CacheStore
  key: string
  ttlSeconds: number
  now: number
  produce: () => Promise<T>
}): Promise<{ value: T; hit: 'fresh' | 'stale' | 'miss' }> {
  const { store, key, ttlSeconds, now, produce } = opts

  const existing = await readEntry<T>(store, key)
  if (existing && isFresh(existing, ttlSeconds, now)) {
    return { value: existing.value, hit: 'fresh' }
  }

  const lockKey = `${key}:lock`
  const acquired = await store.lock(lockKey, LOCK_TTL_SECONDS)

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
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
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

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

// `staleError` is set exactly when a value is being served ONLY because
// produce() threw and an existing entry happened to be there to fall back
// on (both the direct stale-on-error path and the lock-wait-timeout
// fallback landing on this same catch branch) -- never on a genuine cache
// hit (the early-return fresh checks in `withCache` never call
// `produceAndCache` at all) and never on a clean miss (produce() succeeded,
// so there's nothing to report). Task 6 fix round 2: this field exists
// because `withCache` used to swallow that error entirely once a fallback
// entry existed, which meant NotFoundError/ExtractionEmptyError/
// ExtractionIncompleteError never reached a caller's error-mapping code for
// any entity with a prior cache entry -- silencing the extraction-empty
// canary for exactly the entities a Spotify redesign is most likely to have
// already cached. The *value* returned is unchanged by this field: serving
// stale is still correct behaviour, this only restores the caller's ability
// to ALSO observe that production failed.
export type CacheResult<T> = { value: T; hit: 'fresh' | 'stale' | 'miss'; staleError?: unknown }

/**
 * How a failed `produce()` crosses the gap between the caller that hit it
 * and the callers waiting on that same key.
 *
 * The relay exists because a failure writes no value, and the waiter loop
 * can only see values -- so without it, waiters cannot distinguish "the
 * holder failed" from "the holder is slow". They wait out the entire
 * `produceBudgetMs` and then all produce at once. See the regression tests
 * in tests/cache.test.ts for what that costs.
 *
 * `encode`/`decode` are supplied by the caller because the error *taxonomy*
 * belongs to the caller, not to a generic cache: `src/server.ts` maps
 * NotFoundError / ExtractionEmptyError / ExtractionIncompleteError /
 * ExtractionTimeoutError onto four different status codes, and a waiter that
 * got a flattened `Error` back would be answered differently from the holder
 * purely because it lost a race for the lock.
 *
 * `ttlSeconds` should stay SHORT. This is a handoff to the cohort already
 * waiting, not a negative cache: a marker that outlives the cohort starts
 * caching our own bugs, so a scraper fixed and redeployed would keep serving
 * the old failure until the marker expired. Long enough for a polling waiter
 * to notice (they poll every LOCK_POLL_INTERVAL_MS), no longer.
 */
export type FailureCodec = {
  ttlSeconds: number
  encode(err: unknown): string
  decode(raw: string): unknown
}

export const DEFAULT_FAILURE_TTL_SECONDS = 5

// Used when a caller supplies no codec of its own. Carries the message and
// nothing else -- enough to stop the herd, which is the part that must never
// depend on the caller remembering to configure something, but not enough to
// preserve an error's type. Callers that map errors onto distinct responses
// (server.ts) pass their own.
export const DEFAULT_FAILURE_CODEC: FailureCodec = {
  ttlSeconds: DEFAULT_FAILURE_TTL_SECONDS,
  encode: (err: unknown) => JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
  decode: (raw: string) => new Error((JSON.parse(raw) as { message: string }).message),
}

function failureKey(key: string): string {
  return `${key}:fail`
}

// Best-effort on purpose. The relay is an optimization over the pre-existing
// behaviour (waiters time out and produce), so a store that refuses the write
// must degrade to that, never replace the real produce() error with a store
// error on its way out of the holder's catch block.
async function publishFailure(
  store: CacheStore,
  key: string,
  err: unknown,
  codec: FailureCodec,
): Promise<void> {
  try {
    await store.set(failureKey(key), codec.encode(err), codec.ttlSeconds)
  } catch {
    // Swallowed deliberately -- see above.
  }
}

async function readFailure(store: CacheStore, key: string, codec: FailureCodec): Promise<{ err: unknown } | null> {
  let raw: string | null
  try {
    raw = await store.get(failureKey(key))
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    return { err: codec.decode(raw) }
  } catch {
    // A corrupt marker is not a marker.
    return null
  }
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
 * check as everywhere else, never assumed. `staleError` is set in both
 * sub-cases (see its own doc comment) -- a real produce() failure happened
 * either way, and a caller that wants to alert on it shouldn't have that
 * signal depend on exactly which concurrent caller's write won a race.
 */
async function produceAndCache<T>(
  store: CacheStore,
  key: string,
  ttlSeconds: number,
  now: number,
  produce: () => Promise<T>,
): Promise<CacheResult<T>> {
  // Fix wave: only `produce()` is inside this try. It used to also wrap the
  // `store.set()` write below, so a cache-*write* failure (Redis down at the
  // moment we try to persist a value we successfully scraped) took the exact
  // same fallback path as a scrape failure -- eligible to be silently masked
  // behind a stale value, and, when there was nothing to fall back on,
  // rethrown as if `produce()` itself had failed. Neither is right: the
  // scrape succeeded, only the write to Redis didn't, and that's a distinct
  // failure a caller (server.ts's `recordFailureMetrics`) needs to be able
  // to tell apart from "extraction stopped matching Spotify's page". A write
  // failure now propagates directly, unmediated by the stale-on-error logic
  // that exists specifically for `produce()`.
  let value: T
  try {
    value = await produce()
  } catch (err) {
    const found = await readEntry<T>(store, key)
    if (found) {
      return {
        value: found.value,
        hit: isFresh(found, ttlSeconds, now) ? 'fresh' : 'stale',
        staleError: err,
      }
    }
    throw err
  }
  const entry: Entry<T> = { value, storedAt: now }
  await store.set(key, JSON.stringify(entry), ttlSeconds * STALE_GRACE_MULTIPLIER)
  return { value, hit: 'miss' }
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
  failureCodec?: FailureCodec
}): Promise<CacheResult<T>> {
  const { store, key, ttlSeconds, now, produce } = opts
  const produceBudgetMs = opts.produceBudgetMs ?? DEFAULT_PRODUCE_BUDGET_MS
  const failureCodec = opts.failureCodec ?? DEFAULT_FAILURE_CODEC
  const lockTtlSeconds = Math.ceil(produceBudgetMs / 1000)
  const lockWaitTimeoutMs = produceBudgetMs

  const existing = await readEntry<T>(store, key)
  if (existing && isFresh(existing, ttlSeconds, now)) {
    return { value: existing.value, hit: 'fresh' }
  }

  const lockKey = `${key}:lock`
  const acquired = await store.lock(lockKey, lockTtlSeconds)

  if (acquired) {
    // A marker left by an earlier cohort would make this run's waiters report
    // a failure for a produce() that is still in flight and may yet succeed.
    // Clearing it here is what lets a waiter read "marker present" as "the
    // produce I am waiting on has already failed" with no further qualifiers.
    try {
      await store.del(failureKey(key))
    } catch {
      // Non-fatal: a marker we failed to clear can only cost us the relay,
      // and the waiter's own budget still bounds the wait.
    }
    try {
      const result = await produceAndCache(store, key, ttlSeconds, now, produce)
      // produce() can fail without this call throwing: stale-on-error swallows
      // the error and returns an existing entry, reporting it via staleError.
      // Waiters demand a *fresh* entry, so that stale entry does not release
      // them -- publish, or they wait out the whole budget for a produce that
      // is already over.
      if (result.staleError !== undefined) {
        await publishFailure(store, key, result.staleError, failureCodec)
      }
      return result
    } catch (err) {
      await publishFailure(store, key, err, failureCodec)
      throw err
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
    const failed = await readFailure(store, key, failureCodec)
    if (failed) {
      // The holder finished, and failed. Apply exactly the policy it applied
      // to itself (produceAndCache's own catch): serve an existing entry if
      // there is one, else surface the error. Anything else would answer the
      // same request two different ways depending on who won the lock.
      const found = await readEntry<T>(store, key)
      if (found) {
        return {
          value: found.value,
          hit: isFresh(found, ttlSeconds, now) ? 'fresh' : 'stale',
          staleError: failed.err,
        }
      }
      throw failed.err
    }
  }

  // The lock holder took too long -- crashed mid-produce, or just slow.
  // Either way, a slow peer must not become an error for this caller: fall
  // through and produce directly instead of waiting forever or failing.
  return produceAndCache(store, key, ttlSeconds, now, produce)
}

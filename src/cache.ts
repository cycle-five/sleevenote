import type { CacheStore } from './store.js'
import { DEFAULT_PRODUCE_BUDGET_MS } from './config.js'

// Callers of the cache need only one import path.
export * from './store.js'

export type Entry<T> = { value: T; storedAt: number }

export function cacheKey(type: 'track' | 'album' | 'playlist', id: string): string {
  return `v1:${type}:${id}`
}

const LOCK_POLL_INTERVAL_MS = 50

// Physical entries outlive their logical TTL by this factor, so stale-on-error
// still has something to serve after an entry stops being fresh.
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

// `staleError` is set only when a value is served *because* produce() threw
// and an entry happened to be there to fall back on -- never on a genuine hit
// or a clean miss. It does not change the value returned; it restores the
// caller's ability to observe that production failed at all.
export type CacheResult<T> = { value: T; hit: 'fresh' | 'stale' | 'miss'; staleError?: unknown }

/**
 * How a failed `produce()` reaches the callers waiting on the same key.
 * Without it they cannot tell a failed holder from a slow one, and stampede.
 *
 * `encode`/`decode` belong to the caller because the error taxonomy does.
 * `ttlSeconds` must stay short -- this is a handoff to the waiting cohort,
 * not a negative cache. See docs/design-notes.md.
 */
export type FailureCodec = {
  ttlSeconds: number
  encode(err: unknown): string
  decode(raw: string): unknown
}

export const DEFAULT_FAILURE_TTL_SECONDS = 5

// Fallback codec: enough to stop the herd without the caller having to
// configure anything, but it does not preserve error types. Callers that map
// errors onto distinct responses (server.ts) supply their own.
export const DEFAULT_FAILURE_CODEC: FailureCodec = {
  ttlSeconds: DEFAULT_FAILURE_TTL_SECONDS,
  encode: (err: unknown) => JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
  decode: (raw: string) => new Error((JSON.parse(raw) as { message: string }).message),
}

function failureKey(key: string): string {
  return `${key}:fail`
}

// Best-effort: the relay is an optimization over "waiters time out and
// produce", so a refused write must degrade to that rather than replace the
// real produce() error with a store error.
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
 * Run `produce` and cache the result, or serve an existing entry if it throws.
 * That entry is not necessarily stale -- a racing caller may have just written
 * a fresh one -- so `hit` is decided by the usual freshness check, never
 * assumed from the fact that produce() failed.
 */
async function produceAndCache<T>(
  store: CacheStore,
  key: string,
  ttlSeconds: number,
  now: number,
  produce: () => Promise<T>,
): Promise<CacheResult<T>> {
  // Only `produce()` is inside this try. A failed `store.set` below means the
  // scrape succeeded and only the write didn't -- a distinct failure that must
  // propagate rather than be masked behind a stale value.
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
 * The cache policy: freshness by stored timestamp (`now` is caller-supplied so
 * this is testable without waiting), single-flight production via an advisory
 * lock, and stale-on-error fallback.
 *
 * `produceBudgetMs` governs both the lock's TTL and how long a waiter polls,
 * so the lock can never disagree with how long production actually takes.
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
    // Clearing an earlier cohort's marker is what lets a waiter read "marker
    // present" as "the produce I am waiting on has already failed".
    try {
      await store.del(failureKey(key))
    } catch {
      // Non-fatal: a marker we failed to clear can only cost us the relay,
      // and the waiter's own budget still bounds the wait.
    }
    try {
      const result = await produceAndCache(store, key, ttlSeconds, now, produce)
      // produce() can fail without this throwing (stale-on-error). Waiters
      // demand a *fresh* entry, so publish or they wait out the whole budget
      // for a produce that is already over.
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

  // Someone else is producing this key; poll rather than duplicate the work.
  const deadline = Date.now() + lockWaitTimeoutMs
  while (Date.now() < deadline) {
    await sleep(LOCK_POLL_INTERVAL_MS)
    const candidate = await readEntry<T>(store, key)
    if (candidate && isFresh(candidate, ttlSeconds, now)) {
      return { value: candidate.value, hit: 'fresh' }
    }
    const failed = await readFailure(store, key, failureCodec)
    if (failed) {
      // The holder finished and failed. Apply the same policy it applied to
      // itself, or the same request gets two answers depending on who won the
      // lock.
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

  // Holder crashed or is simply slow. A slow peer must not become this
  // caller's error, so produce directly rather than waiting or failing.
  return produceAndCache(store, key, ttlSeconds, now, produce)
}

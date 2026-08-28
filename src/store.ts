import Redis from 'ioredis'

/**
 * Storage primitives the cache policy is built on. Deliberately narrow: just
 * get/set-with-ttl, an advisory lock, and health/lifecycle. All the policy
 * (freshness, single-flight, stale-on-error) lives in `cache.ts`, on top of
 * this interface -- not here.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  // Distinct from `unlock` despite both being a DEL underneath: `unlock`
  // releases an advisory lock, `del` removes an ordinary key. The cache's
  // failure relay needs the second (it clears a stale failure marker), and
  // borrowing `unlock` for it would make every call site lie about intent.
  del(key: string): Promise<void>
  lock(key: string, ttlSeconds: number): Promise<boolean>
  unlock(key: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/**
 * Thrown when a `CacheStore` operation itself fails -- a Redis error, a
 * dropped connection, a bounded retry giving up -- as opposed to the
 * extraction/scrape layer failing. `src/server.ts`'s `recordFailureMetrics`
 * tells the two apart by `instanceof StoreError` rather than by
 * string-matching a raw ioredis error, so a Redis outage is counted (and
 * mapped to an HTTP status) as itself, not folded into "extraction failed"
 * or an unclassified 'unknown' reason.
 */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StoreError'
  }
}

/**
 * Redis-backed store. This is the only place in the service that holds
 * state -- the service itself is stateless, so every instance talks to the
 * same Redis and any instance can serve any key.
 */
export class RedisStore implements CacheStore {
  private readonly client: Redis

  constructor(url: string) {
    this.client = new Redis(url, {
      // ioredis's own defaults (enableOfflineQueue: true, but no bound on
      // maxRetriesPerRequest beyond 20, connectTimeout: 10000, and a
      // retryStrategy backoff capped at 5000ms) mean a command issued while
      // Redis is unreachable sits queued through up to 20 retries before
      // rejecting -- roughly 70s. `/health`'s entire reason to exist is
      // answering promptly when Redis is down (see server.ts's doc comment
      // on that route); a health checker has given up long before 70s.
      // tests/store.redis.test.ts's own probe already knew this had to be
      // bounded (connectTimeout: 300, maxRetriesPerRequest: 1, retryStrategy:
      // () => null) -- it just never reached this constructor.
      //
      // These numbers are looser than that test-only probe on purpose: this
      // client is not one-shot, it serves every real request. Keeping
      // `enableOfflineQueue` at its default `true` (rather than `false`)
      // means a command issued during a brief reconnect blip still queues
      // and succeeds once reconnected, instead of failing instantly --
      // normal operation stays resilient to a sub-second hiccup. What's
      // bounded is only how long an individual command waits before giving
      // up on a *sustained* outage: a handful of quick, capped retries
      // (worst case a few seconds), not 20 retries backing off to 5s each.
      // Reconnection itself is left unbounded -- retryStrategy always
      // returns a delay, never `null` -- so the client keeps trying in the
      // background and recovers on its own once Redis comes back, with no
      // need to recreate it.
      connectTimeout: 2_000,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number): number => Math.min(times * 200, 1_000),
    })
    // ioredis emits 'error' on every connection hiccup (including ones it
    // will transparently retry). Without a listener, Node treats an
    // unhandled 'error' event as fatal and crashes the process -- so a
    // Redis restart would take the whole service down with it.
    this.client.on('error', (err: Error) => {
      console.error(`[RedisStore] connection error: ${err.message}`)
    })
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key)
    } catch (err) {
      throw new StoreError(`RedisStore.get failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds)
    } catch (err) {
      throw new StoreError(`RedisStore.set failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key)
    } catch (err) {
      throw new StoreError(`RedisStore.del failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX')
      return result === 'OK'
    } catch (err) {
      throw new StoreError(`RedisStore.lock failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  async unlock(key: string): Promise<void> {
    try {
      await this.client.del(key)
    } catch (err) {
      throw new StoreError(`RedisStore.unlock failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG'
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.client.quit()
  }
}

type StoredEntry = { value: string; expiresAt: number }

/**
 * In-process store for tests. Not stateless -- deliberately so, since it's
 * only ever instantiated per-test, never shared across requests. Never use
 * this outside a test file.
 */
export class MemoryStore implements CacheStore {
  private readonly values = new Map<string, StoredEntry>()
  private readonly locks = new Map<string, number>()

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.values.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  async del(key: string): Promise<void> {
    this.values.delete(key)
  }

  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    const heldUntil = this.locks.get(key)
    if (heldUntil !== undefined && heldUntil > now) return false
    this.locks.set(key, now + ttlSeconds * 1000)
    return true
  }

  async unlock(key: string): Promise<void> {
    this.locks.delete(key)
  }

  async ping(): Promise<boolean> {
    return true
  }

  async close(): Promise<void> {
    this.values.clear()
    this.locks.clear()
  }
}

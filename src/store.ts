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
  // Distinct from `unlock` despite both being DEL: borrowing `unlock` for an
  // ordinary key would make every call site lie about intent.
  del(key: string): Promise<void>
  lock(key: string, ttlSeconds: number): Promise<boolean>
  unlock(key: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/**
 * The store failed, as opposed to the scraper. `recordFailureMetrics` tells
 * the two apart by `instanceof` rather than string-matching ioredis, so a
 * Redis outage is counted as itself.
 */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StoreError'
  }
}

/**
 * The only place the service holds state. Every instance talks to the same
 * Redis, so any instance can serve any key.
 */
export class RedisStore implements CacheStore {
  private readonly client: Redis

  constructor(url: string) {
    this.client = new Redis(url, {
      // ioredis's defaults leave a command queued ~70s before rejecting when
      // Redis is unreachable, but /health exists to answer promptly when it
      // is down. These bound only how long ONE command waits on a sustained
      // outage; `enableOfflineQueue` stays true so a sub-second blip still
      // succeeds, and reconnection stays unbounded so the client recovers on
      // its own. See docs/design-notes.md ("Redis client tuning").
      connectTimeout: 2_000,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number): number => Math.min(times * 200, 1_000),
    })
    // Without a listener Node treats 'error' as fatal, so a Redis restart
    // would take the whole service down.
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

/** In-process store for tests, instantiated per-test. Never use in production. */
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

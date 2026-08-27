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
  lock(key: string, ttlSeconds: number): Promise<boolean>
  unlock(key: string): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/**
 * Redis-backed store. This is the only place in the service that holds
 * state -- the service itself is stateless, so every instance talks to the
 * same Redis and any instance can serve any key.
 */
export class RedisStore implements CacheStore {
  private readonly client: Redis

  constructor(url: string) {
    this.client = new Redis(url)
    // ioredis emits 'error' on every connection hiccup (including ones it
    // will transparently retry). Without a listener, Node treats an
    // unhandled 'error' event as fatal and crashes the process -- so a
    // Redis restart would take the whole service down with it.
    this.client.on('error', (err: Error) => {
      console.error(`[RedisStore] connection error: ${err.message}`)
    })
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds)
  }

  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX')
    return result === 'OK'
  }

  async unlock(key: string): Promise<void> {
    await this.client.del(key)
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

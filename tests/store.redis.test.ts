import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Redis from 'ioredis'
import { RedisStore } from '../src/store.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
const PROBE_TIMEOUT_MS = 300

// RedisStore is a thin adapter -- the interesting policy logic (freshness,
// single-flight, stale-on-error) lives in cache.ts and is exercised against
// MemoryStore in cache.test.ts with no infrastructure required. This file
// checks the adapter itself actually round-trips through a real Redis, so
// its first execution isn't inside a Docker container in a later task.
//
// Redis is not part of this repo's dev setup, so this probe must fail fast
// and quietly rather than hang or crash the run when nothing is listening.
async function probeRedis(url: string): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: PROBE_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  // Without a listener, an unhandled 'error' event is fatal to the process.
  client.on('error', () => {})
  try {
    await client.connect()
    const pong = await client.ping()
    return pong === 'PONG'
  } catch {
    return false
  } finally {
    client.disconnect()
  }
}

const redisAvailable = await probeRedis(REDIS_URL)

if (!redisAvailable) {
  it.skip(
    `RedisStore integration skipped: no Redis reachable at ${REDIS_URL}. ` +
      'Start one with: docker run -p 6379:6379 redis:7-alpine',
    () => {},
  )
}

describe.skipIf(!redisAvailable)('RedisStore (integration, requires real Redis)', () => {
  let store: RedisStore
  // Unique per run so repeated runs (and a run that crashes mid-test) never
  // collide with leftover keys from a previous one.
  const prefix = `sleevenote:test:${Date.now()}:${Math.random().toString(36).slice(2)}`

  beforeAll(() => {
    store = new RedisStore(REDIS_URL)
  })

  afterAll(async () => {
    await store.close()
  })

  it('answers ping', async () => {
    expect(await store.ping()).toBe(true)
  })

  it('returns null for a missing key', async () => {
    expect(await store.get(`${prefix}:missing`)).toBeNull()
  })

  it('set then get returns the stored value', async () => {
    const key = `${prefix}:roundtrip`
    await store.set(key, 'hello', 5)
    expect(await store.get(key)).toBe('hello')
  })

  it('a key set with a 1-second TTL is gone shortly after', async () => {
    const key = `${prefix}:ttl`
    await store.set(key, 'ephemeral', 1)
    expect(await store.get(key)).toBe('ephemeral')
    await new Promise((r) => setTimeout(r, 1300))
    expect(await store.get(key)).toBeNull()
  }, 5000)

  it('lock returns true once and false while held, unlock releases it', async () => {
    const key = `${prefix}:lock`
    expect(await store.lock(key, 5)).toBe(true)
    expect(await store.lock(key, 5)).toBe(false)
    await store.unlock(key)
    expect(await store.lock(key, 5)).toBe(true)
    await store.unlock(key)
  })
})

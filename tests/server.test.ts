import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server.js'
import { MemoryStore } from '../src/cache.js'
import { loadConfig } from '../src/config.js'
import { NotFoundError, ExtractionEmptyError, ExtractionIncompleteError } from '../src/extract.js'

const cfg = loadConfig({})
const fakePool = { acquire: async () => { throw new Error('unused') }, liveContexts: () => 1, close: async () => {} }

function server(extract: any, store = new MemoryStore()) {
  return buildServer({ cfg, store, pool: fakePool as any, extract })
}

const TRACK = { id: 'abc', type: 'track', name: 'Hideaway', artists: [{ name: 'Kiesza', id: null }], album: null, durationMs: null, url: 'https://open.spotify.com/track/abc' }

describe('GET /health', () => {
  it('returns the exact origin string when Redis and the pool are up', async () => {
    const app = server(async () => TRACK)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('sleevenote ok')
  })

  // A status-only check is worthless: an intermediary error page is also a 200.
  it('fails when the store is unreachable', async () => {
    const broken = new MemoryStore()
    broken.ping = async () => false
    const app = server(async () => TRACK, broken)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toBe('sleevenote ok')
  })
})

describe('GET /v1/track/:id', () => {
  it('returns the normalized track', async () => {
    const app = server(async () => TRACK)
    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: 'Hideaway', type: 'track' })
  })

  it('maps NotFoundError to 404', async () => {
    const app = server(async () => { throw new NotFoundError('nope') })
    expect((await app.inject({ method: 'GET', url: '/v1/track/abc' })).statusCode).toBe(404)
  })

  it('maps ExtractionEmptyError to 502, not 404', async () => {
    const app = server(async () => { throw new ExtractionEmptyError('nothing') })
    expect((await app.inject({ method: 'GET', url: '/v1/playlist/abc' })).statusCode).toBe(502)
  })

  it('serves stale with a header when a later scrape fails', async () => {
    const store = new MemoryStore()
    let fail = false
    const app = server(async () => { if (fail) throw new Error('boom'); return TRACK }, store)

    await app.inject({ method: 'GET', url: '/v1/track/abc' })
    fail = true
    // Age the entry past its TTL by rewriting storedAt.
    const raw = JSON.parse((await store.get('v1:track:abc'))!)
    raw.storedAt = 0
    await store.set('v1:track:abc', JSON.stringify(raw), 9999)

    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('stale')
  })
})

describe('GET /metrics', () => {
  it('exposes the extraction-empty canary', async () => {
    const app = server(async () => TRACK)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('sleevenote_extraction_empty_total')
  })
})

describe('ExtractionIncompleteError', () => {
  // Zero and partial results are different diagnoses of the same failure
  // class as ExtractionEmptyError -- both mean extraction stopped matching
  // Spotify's page, not that the entity is missing -- so this maps to 502
  // like its sibling, but it must NEVER populate the cache. Caching it would
  // mean a genuinely partial scrape gets served as if it were complete for
  // up to the entity's full TTL (hours to a month), which is worse than
  // returning the error every time.
  it('maps to 502 and never populates the cache', async () => {
    const store = new MemoryStore()
    const app = server(async () => {
      throw new ExtractionIncompleteError('playlist saw 2 of 3 declared tracks')
    }, store)

    const res = await app.inject({ method: 'GET', url: '/v1/playlist/abc' })

    expect(res.statusCode).toBe(502)
    expect(await store.get('v1:playlist:abc')).toBeNull()
  })
})

describe('negative caching', () => {
  it('short-circuits a repeat request for a confirmed-absent id without calling extract again', async () => {
    const store = new MemoryStore()
    let calls = 0
    const app = server(async () => {
      calls++
      throw new NotFoundError('no track found for id gone')
    }, store)

    const first = await app.inject({ method: 'GET', url: '/v1/track/gone' })
    expect(first.statusCode).toBe(404)
    expect(calls).toBe(1)

    // Second request for the same id: extract must not run again -- the
    // negative-cache marker written after the first 404 should short-circuit
    // it for cfg.ttl.negative seconds.
    const second = await app.inject({ method: 'GET', url: '/v1/track/gone' })
    expect(second.statusCode).toBe(404)
    expect(calls).toBe(1)
  })

  it('does not negative-cache a different id under the same entity type', async () => {
    const store = new MemoryStore()
    const app = server(async (_kind: string, id: string) => {
      if (id === 'gone') throw new NotFoundError('nope')
      return { ...TRACK, id }
    }, store)

    await app.inject({ method: 'GET', url: '/v1/track/gone' })
    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })

    expect(res.statusCode).toBe(200)
  })
})

describe('produceBudgetMs threading', () => {
  // withCache's own `produceBudgetMs` parameter is OPTIONAL, defaulting to a
  // module constant that happens to equal loadConfig's default (150_000ms).
  // If buildServer ever stopped passing cfg.produceBudgetMs explicitly and
  // relied on that default instead, an operator who set PRODUCE_BUDGET_MS
  // would get an extractor honouring the env value while the cache's
  // single-flight lock TTL stayed pinned to the default -- silently
  // reintroducing the exact bug fixed in Task 3 (the lock expiring mid-produce,
  // letting a second caller start a redundant, concurrent Chromium load).
  // Proving this by inspection isn't enough, since the *default* case can't
  // tell "threaded" apart from "defaulted" -- they agree. So this uses a
  // non-default budget and observes the one place that value becomes
  // externally visible: the TTL withCache passes to store.lock().
  it('threads cfg.produceBudgetMs into withCache rather than relying on its default', async () => {
    const customCfg = loadConfig({ PRODUCE_BUDGET_MS: '5000' })
    const store = new MemoryStore()
    const lockTtls: number[] = []
    const originalLock = store.lock.bind(store)
    store.lock = async (key: string, ttlSeconds: number) => {
      lockTtls.push(ttlSeconds)
      return originalLock(key, ttlSeconds)
    }

    const app = buildServer({ cfg: customCfg, store, pool: fakePool as any, extract: async () => TRACK as any })
    const res = await app.inject({ method: 'GET', url: '/v1/track/threaded' })

    expect(res.statusCode).toBe(200)
    expect(lockTtls).toEqual([Math.ceil(5000 / 1000)])
    // If the server had silently defaulted instead of threading cfg through,
    // this would have been 150 (DEFAULT_PRODUCE_BUDGET_MS / 1000) here.
    expect(lockTtls[0]).not.toBe(150)
  })
})

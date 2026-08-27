import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server.js'
import { MemoryStore } from '../src/cache.js'
import { loadConfig } from '../src/config.js'
import {
  NotFoundError,
  ExtractionEmptyError,
  ExtractionIncompleteError,
  ExtractionTimeoutError,
} from '../src/extract.js'
import { extractionEmpty, scrapeFailures } from '../src/metrics.js'

type CounterLike = {
  get: () => Promise<{ values: { value: number; labels: Partial<Record<string, string | number>> }[] }>
}

// The registry's counters are module-level and shared across every test in
// this file (metrics.ts's one intentional exception to "no module-level
// mutable state" -- see its own doc comment), so these read a value rather
// than asserting an absolute count: a test compares a counter's value before
// and after its own action, which holds regardless of what earlier tests
// already added to the same counter.
async function counterValue(counter: CounterLike, labels?: Record<string, string>): Promise<number> {
  const m = await counter.get()
  if (!labels) return m.values[0]?.value ?? 0
  const entry = m.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
  return entry?.value ?? 0
}

async function counterTotal(counter: CounterLike): Promise<number> {
  const m = await counter.get()
  return m.values.reduce((sum, v) => sum + v.value, 0)
}

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

describe('ExtractionTimeoutError', () => {
  // Fix round 1: this used to be untestable except by a fake clock or a
  // multi-minute real browser run, because the 504 mapping matched a bare
  // Error's message by regex. extract.ts now throws a dedicated class from
  // its produceBudgetMs backstop, and buildServer's injected `extract`
  // makes exercising the HTTP mapping this direct -- no timers involved.
  it('maps to 504, not 502', async () => {
    const app = server(async () => {
      throw new ExtractionTimeoutError('extraction exceeded produceBudgetMs (150000ms)')
    })
    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(504)
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

describe('stale-on-error masking (fix round 2)', () => {
  // withCache's stale-on-error fallback (cache.ts) used to swallow a
  // produce() failure entirely whenever a prior cache entry existed to fall
  // back on -- so for any entity with a positive cache entry, a real
  // ExtractionEmptyError/ExtractionIncompleteError/NotFoundError never
  // reached this file's catch block at all: no 404/502, and critically, no
  // extractionEmpty.inc() or scrapeFailures.inc(). Given a 30-day track TTL
  // with 2x physical retention, the canary this whole design leans on could
  // read zero for up to 60 days of a real Spotify-redesign breakage on
  // already-cached entities. A test that only checks 200 + the stale header
  // (like the pre-existing "serves stale with a header" test above) cannot
  // catch this -- it passed before this fix and still passes after, since
  // the *response* never changed. Only reading the counters proves it.
  it('increments extractionEmpty and scrapeFailures when a stale value masks an ExtractionEmptyError', async () => {
    const store = new MemoryStore()
    let fail = false
    const app = server(async () => {
      if (fail) throw new ExtractionEmptyError('nothing')
      return TRACK
    }, store)

    await app.inject({ method: 'GET', url: '/v1/track/abc' })
    fail = true
    const raw = JSON.parse((await store.get('v1:track:abc'))!)
    raw.storedAt = 0
    await store.set('v1:track:abc', JSON.stringify(raw), 9999)

    const before = {
      empty: await counterValue(extractionEmpty),
      failures: await counterValue(scrapeFailures, { reason: 'extraction_empty' }),
    }

    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })

    const after = {
      empty: await counterValue(extractionEmpty),
      failures: await counterValue(scrapeFailures, { reason: 'extraction_empty' }),
    }

    // The response is unchanged by this fix -- still usable data, still
    // labelled stale -- that's the whole point of stale-on-error.
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('stale')
    // But the failure that caused the fallback is no longer invisible.
    expect(after.empty).toBe(before.empty + 1)
    expect(after.failures).toBe(before.failures + 1)
  })

  it('does not touch scrapeFailures for a masked NotFoundError, matching the un-masked 404 path', async () => {
    const store = new MemoryStore()
    let fail = false
    const app = server(async () => {
      if (fail) throw new NotFoundError('nope')
      return TRACK
    }, store)

    await app.inject({ method: 'GET', url: '/v1/track/abc' })
    fail = true
    const raw = JSON.parse((await store.get('v1:track:abc'))!)
    raw.storedAt = 0
    await store.set('v1:track:abc', JSON.stringify(raw), 9999)

    const before = { failures: await counterTotal(scrapeFailures), empty: await counterValue(extractionEmpty) }
    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    const after = { failures: await counterTotal(scrapeFailures), empty: await counterValue(extractionEmpty) }

    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('stale')
    expect(after.failures).toBe(before.failures)
    expect(after.empty).toBe(before.empty)
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

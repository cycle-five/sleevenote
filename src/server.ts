import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { StoreError, type CacheStore } from './store.js'
import type { Pool } from './browser.js'
import type { Config } from './config.js'
import type { Track, Album, Playlist } from './types.js'
import { cacheKey, withCache, type FailureCodec } from './cache.js'
import {
  NotFoundError,
  ExtractionEmptyError,
  ExtractionIncompleteError,
  ExtractionTimeoutError,
} from './extract.js'
import { cacheHits, scrapeDuration, scrapeFailures, extractionEmpty, registry } from './metrics.js'

export type ExtractFn = (
  kind: 'track' | 'album' | 'playlist',
  id: string,
  pool: Pool,
  cfg: Config,
) => Promise<Track | Album | Playlist>

export type ServerDeps = {
  cfg: Config
  store: CacheStore
  pool: Pool
  extract: ExtractFn
  now?: () => number
}

const ENTITY_KINDS = ['track', 'album', 'playlist'] as const
type EntityKind = (typeof ENTITY_KINDS)[number]

// Deliberately looser than Spotify's actual base62 shape -- "no path or
// key-namespace metacharacters, and not unbounded" -- so a legitimate id
// format is never falsely rejected. This is what stops an id from reaching a
// Redis key name (`:` forges a key, e.g. `abc:lock` collides with track
// `abc`'s own lock) or `page.goto` (`..` escapes the entity page).
const ENTITY_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/

// The wire form of a produce() failure, relayed to callers waiting on the
// same key. The `kind` values correspond one-to-one with the `instanceof`
// chain in the route's catch block; adding one here without its arm there
// (or vice versa) is the failure mode to watch for.
type RelayedFailure =
  | { kind: 'not_found'; message: string }
  | { kind: 'extraction_empty'; message: string }
  | { kind: 'extraction_incomplete'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'store'; message: string }
  | { kind: 'other'; message: string }

function classifyFailure(err: unknown): RelayedFailure {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof NotFoundError) return { kind: 'not_found', message }
  if (err instanceof ExtractionEmptyError) return { kind: 'extraction_empty', message }
  if (err instanceof ExtractionIncompleteError) return { kind: 'extraction_incomplete', message }
  if (err instanceof ExtractionTimeoutError) return { kind: 'timeout', message }
  if (err instanceof StoreError) return { kind: 'store', message }
  return { kind: 'other', message }
}

function reviveFailure(f: RelayedFailure): unknown {
  switch (f.kind) {
    case 'not_found':
      return new NotFoundError(f.message)
    case 'extraction_empty':
      return new ExtractionEmptyError(f.message)
    case 'extraction_incomplete':
      return new ExtractionIncompleteError(f.message)
    case 'timeout':
      return new ExtractionTimeoutError(f.message)
    case 'store':
      return new StoreError(f.message)
    case 'other':
      return new Error(f.message)
  }
}

function failureCodecFor(cfg: Config): FailureCodec {
  return {
    ttlSeconds: cfg.failureRelayTtl,
    encode: (err: unknown) => JSON.stringify(classifyFailure(err)),
    decode: (raw: string) => reviveFailure(JSON.parse(raw) as RelayedFailure),
  }
}

// A separate namespace from the positive entry, not a flag alongside it, so
// `withCache`'s `readEntry` can never misread a negative marker as an
// `Entry<T>`. Its TTL is plain physical expiry -- a negative result needs no
// stale-on-error fallback, only to stop us re-scraping a just-confirmed
// absence.
function negativeKey(kind: EntityKind, id: string): string {
  return `${cacheKey(kind, id)}:absent`
}

// The same failure reaches this file two ways -- thrown, or as
// `CacheResult.staleError` alongside a 200 from stale-on-error -- and both
// must record the same counters, or the canary goes dark for exactly the
// entities that have a prior cache entry. NotFoundError records nothing: a
// 404 is normal traffic, not scraper breakage.
function recordFailureMetrics(err: unknown): void {
  if (err instanceof NotFoundError) return
  if (err instanceof StoreError) {
    // Counted as itself so a Redis outage cannot masquerade as "extraction
    // stopped matching Spotify's page", nor fall into 'unknown'.
    scrapeFailures.inc({ reason: 'store' })
    return
  }
  if (err instanceof ExtractionEmptyError) {
    // The canary: what makes a Spotify redesign loud rather than silent.
    extractionEmpty.inc()
    scrapeFailures.inc({ reason: 'extraction_empty' })
    return
  }
  if (err instanceof ExtractionIncompleteError) {
    scrapeFailures.inc({ reason: 'extraction_incomplete' })
    return
  }
  if (err instanceof ExtractionTimeoutError) {
    scrapeFailures.inc({ reason: 'timeout' })
    return
  }
  scrapeFailures.inc({ reason: 'unknown' })
}

/**
 * Every dependency is an argument: no Redis, browser or network is reachable
 * from this module, so the whole HTTP surface is testable with fakes.
 * `src/index.ts` is the only place that constructs real ones.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { cfg, store, pool } = deps
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000))
  const fastify = Fastify()

  async function timedExtract(kind: EntityKind, id: string): Promise<Track | Album | Playlist> {
    const endTimer = scrapeDuration.startTimer()
    try {
      return await deps.extract(kind, id, pool, cfg)
    } finally {
      endTimer()
    }
  }

  async function handleEntity(kind: EntityKind, id: string, reply: FastifyReply): Promise<unknown> {
    // Rejected before touching Redis or the pool.
    if (!ENTITY_ID_PATTERN.test(id)) {
      reply.code(400)
      return { error: 'invalid_id', id, message: 'id must match ^[A-Za-z0-9]{1,64}$' }
    }

    try {
      // Inside the try deliberately: this lookup is exactly as
      // store-dependent as withCache's, and outside it a Redis outage escaped
      // all error mapping into Fastify's default 500.
      const negative = await store.get(negativeKey(kind, id))
      if (negative !== null) {
        // Not a new failure -- the throttle working -- so no counters move.
        reply.header('X-Cache', 'negative')
        reply.code(404)
        return { error: 'not_found', id, message: 'previously confirmed absent' }
      }

      // `produceBudgetMs` MUST be threaded explicitly. It is optional and
      // defaults to a constant that merely happens to match loadConfig's
      // default, so omitting it breaks single-flight under any non-default
      // PRODUCE_BUDGET_MS. Guarded by a test of the same name.
      const result = await withCache({
        store,
        key: cacheKey(kind, id),
        ttlSeconds: cfg.ttl[kind],
        now: now(),
        produce: () => timedExtract(kind, id),
        produceBudgetMs: cfg.produceBudgetMs,
        failureCodec: failureCodecFor(cfg),
      })
      // Stale-on-error serves a value while discarding the failure that
      // caused the fallback. Record it without changing the response.
      if (result.staleError !== undefined) {
        recordFailureMetrics(result.staleError)
      }
      reply.header('X-Cache', result.hit)
      cacheHits.inc({ type: kind, result: result.hit })
      return result.value
    } catch (err) {
      // Keeping these four apart is the point. Collapsing any pair into one
      // status code is the failure mode this service exists to fix.
      recordFailureMetrics(err)
      if (err instanceof NotFoundError) {
        // So a repeat request for a nonexistent id doesn't re-extract.
        await store.set(negativeKey(kind, id), '1', cfg.ttl.negative)
        reply.code(404)
        return { error: 'not_found', id, message: err.message }
      }
      if (err instanceof ExtractionEmptyError) {
        reply.code(502)
        return { error: 'extraction_empty', id, message: err.message }
      }
      if (err instanceof ExtractionIncompleteError) {
        // Never cached: produceAndCache only writes after produce() resolves.
        reply.code(502)
        return { error: 'extraction_incomplete', id, message: err.message }
      }
      if (err instanceof ExtractionTimeoutError) {
        reply.code(504)
        return { error: 'timeout', id, message: err.message }
      }
      reply.code(502)
      return { error: 'internal', id, message: err instanceof Error ? err.message : String(err) }
    }
  }

  for (const kind of ENTITY_KINDS) {
    fastify.get<{ Params: { id: string } }>(`/v1/${kind}/:id`, async (req, reply) =>
      handleEntity(kind, req.params.id, reply),
    )
  }

  // A status-only check is worthless -- an intermediary error page is also a
  // 200. Assert the two things that make the service able to work at all.
  fastify.get('/health', async (_req, reply) => {
    const [storeOk, poolOk] = await Promise.all([store.ping(), pool.liveContexts() >= 1])
    reply.type('text/plain')
    if (storeOk && poolOk) {
      reply.code(200)
      return 'sleevenote ok'
    }
    reply.code(503)
    return 'sleevenote unhealthy'
  })

  fastify.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType)
    return registry.metrics()
  })

  return fastify
}

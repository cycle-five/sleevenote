import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import type { CacheStore } from './store.js'
import type { Pool } from './browser.js'
import type { Config } from './config.js'
import type { Track, Album, Playlist } from './types.js'
import { cacheKey, withCache } from './cache.js'
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

// A separate key/namespace from the positive cache entry (`cacheKey`), not a
// flag alongside it -- so a negative marker can never be misread by
// `withCache`'s own `readEntry` as an `Entry<T>` (it doesn't share that
// shape, and it doesn't share a key). Its TTL is the store's own physical
// expiry (`cfg.ttl.negative`), not the freshness/stale-grace machinery
// `withCache` uses for real values -- a negative result doesn't need a
// stale-on-error fallback, it just needs to stop us re-scraping an id that
// was *just* confirmed absent.
function negativeKey(kind: EntityKind, id: string): string {
  return `${cacheKey(kind, id)}:absent`
}

// Shared between the direct error-mapping catch block below and the
// stale-on-error masking case in `handleEntity` (fix round 2): `withCache`'s
// stale-on-error fallback serves an old value instead of surfacing a
// produce() failure whenever an existing entry is there to serve, so the
// SAME failure can reach this file two different ways -- as a thrown error,
// or as `CacheResult.staleError` alongside an otherwise-200 response. Both
// must record the same counters, or the extraction-empty canary (and the
// rest of scrapeFailures) goes dark for exactly the entities that have a
// prior cache entry -- which, for a 30-day track TTL with 2x physical
// retention, is most of them within days of a real breakage. NotFoundError
// intentionally records nothing here: a 404 for a genuinely nonexistent or
// mistyped id is normal traffic, not a scrape failure, and folding it into a
// failure-rate metric would make routine bad input look like scraper
// breakage on a dashboard meant to alert on exactly that.
function recordFailureMetrics(err: unknown): void {
  if (err instanceof NotFoundError) return
  if (err instanceof ExtractionEmptyError) {
    // The canary: this counter is what makes "extraction stopped matching
    // Spotify's page" loud instead of silently returning nothing, which is
    // how the prior art this project replaces died.
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
 * `buildServer` takes every dependency as an argument -- no Redis, no
 * browser, no network is reachable from this module, so the whole HTTP
 * surface (routing, caching, error mapping, health, metrics) is testable
 * with fakes. `src/index.ts` is the only place that constructs real ones.
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
    const negative = await store.get(negativeKey(kind, id))
    if (negative !== null) {
      // A hit against the negative cache is not a new failure -- it's this
      // throttle doing exactly its job -- so it does not touch
      // scrapeFailures or extractionEmpty.
      reply.header('X-Cache', 'negative')
      reply.code(404)
      return { error: 'not_found', id, message: 'previously confirmed absent' }
    }

    try {
      // `cfg.produceBudgetMs` MUST be threaded through explicitly on every
      // call here. `withCache`'s `produceBudgetMs` parameter is optional
      // and defaults to a module constant that happens to match
      // `loadConfig`'s own default -- so an operator who overrides
      // PRODUCE_BUDGET_MS away from that default would silently get an
      // extractor honouring the env value and a single-flight lock TTL
      // still pinned to the default, breaking single-flight under any
      // non-default config. See tests/server.test.ts's
      // "threads cfg.produceBudgetMs" test, which fails if this line is
      // ever changed to omit the option.
      const result = await withCache({
        store,
        key: cacheKey(kind, id),
        ttlSeconds: cfg.ttl[kind],
        now: now(),
        produce: () => timedExtract(kind, id),
        produceBudgetMs: cfg.produceBudgetMs,
      })
      // withCache's stale-on-error fallback can serve a value while
      // discarding the produce() failure that caused it to fall back at
      // all -- see recordFailureMetrics's doc comment. That failure is real
      // even though the caller here gets usable data and a 200; record it
      // the same way a thrown error would be, without changing the response.
      if (result.staleError !== undefined) {
        recordFailureMetrics(result.staleError)
      }
      reply.header('X-Cache', result.hit)
      cacheHits.inc({ type: kind, result: result.hit })
      return result.value
    } catch (err) {
      // Distinguishing NotFoundError / ExtractionEmptyError /
      // ExtractionIncompleteError is the entire point -- see extract.ts's
      // own doc comments and the team lead's context. Collapsing any pair
      // of these back into one status code is exactly the failure mode this
      // service exists to fix. ExtractionTimeoutError is a fourth, narrower
      // distinction (a produceBudgetMs backstop rarely expected to fire --
      // see extract.ts's withBudget), mapped to 504 rather than folded into
      // the generic 502 below.
      recordFailureMetrics(err)
      if (err instanceof NotFoundError) {
        // Negative-cache the id so a repeat request for something that
        // genuinely doesn't exist doesn't re-run a full extraction on every
        // single call within cfg.ttl.negative.
        await store.set(negativeKey(kind, id), '1', cfg.ttl.negative)
        reply.code(404)
        return { error: 'not_found', id, message: err.message }
      }
      if (err instanceof ExtractionEmptyError) {
        reply.code(502)
        return { error: 'extraction_empty', id, message: err.message }
      }
      if (err instanceof ExtractionIncompleteError) {
        // Never cached -- withCache's produceAndCache only calls store.set
        // after produce() resolves, and this rejected, so there is nothing
        // extra to do here to satisfy that guarantee; it falls out of the
        // cache layer's own structure.
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

  // A status-only health check is worthless: an intermediary error page is
  // also a 200. This asserts the two things that actually make the service
  // able to do its job -- the store answers, and the pool has at least one
  // live context to hand out -- not merely that Fastify itself is up.
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

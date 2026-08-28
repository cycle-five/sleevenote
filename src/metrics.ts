import { Registry, Counter, Histogram, Gauge } from 'prom-client'

/**
 * One registry, module-level. This is the one exception to "no module-level
 * mutable state" the rest of the service holds to (see config.ts/store.ts):
 * metrics counters are inherently process-local -- they describe what THIS
 * instance has done, not shared application state -- and prom-client's own
 * API is built around a long-lived Registry you register collectors into
 * once. Nothing here is read back to make a routing or caching decision; it
 * only ever flows outward via GET /metrics.
 */
export const registry = new Registry()

export const cacheHits = new Counter({
  name: 'sleevenote_cache_hits_total',
  help: 'Cache lookups for entity requests, by entity type and outcome (fresh/stale/miss).',
  labelNames: ['type', 'result'] as const,
  registers: [registry],
})

export const scrapeDuration = new Histogram({
  name: 'sleevenote_scrape_duration_seconds',
  help: 'Wall-clock time of one extract() call (acquire + navigate + scroll + normalize).',
  registers: [registry],
})

// `reason` distinguishes what actually happened -- not-found, extraction-
// empty, extraction-incomplete, timeout, or an unclassified error -- so a
// dashboard can tell a Spotify redesign apart from a network blip without
// grepping logs.
export const scrapeFailures = new Counter({
  name: 'sleevenote_scrape_failures_total',
  help: 'Failed extract() calls, by reason.',
  labelNames: ['reason'] as const,
  registers: [registry],
})

// The canary. The prior art this project replaces failed by silently
// returning nothing -- this counter is what makes that failure loud instead.
// A Spotify redesign that breaks our discriminators shows up here as a
// climbing rate, not as a mysteriously empty response nobody notices.
export const extractionEmpty = new Counter({
  name: 'sleevenote_extraction_empty_total',
  help: 'Extractions that navigated successfully but yielded zero tracks -- extraction likely stopped matching Spotify\'s page.',
  registers: [registry],
})

/**
 * Which build is answering. Without this, the version in package.json is a
 * number that exists only in git: it is not in the image, not in any
 * response, and not in /health, so there is no way to ask a running instance
 * what it is -- and "which build is deployed?" is the first question every
 * incident starts with.
 *
 * `build_info` is the Prometheus convention for this: a gauge fixed at 1
 * whose labels carry the actual payload, so a dashboard can join on it and
 * an operator can read it straight out of GET /metrics.
 */
export const buildInfo = new Gauge({
  name: 'sleevenote_build_info',
  help: 'Build metadata for the running instance. Always 1; read the labels.',
  labelNames: ['version'] as const,
  registers: [registry],
})

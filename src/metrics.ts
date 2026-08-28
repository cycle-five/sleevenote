import { Registry, Counter, Histogram, Gauge } from '@prometheus-io/client'

/**
 * One registry, module-level -- the service's one exception to "no
 * module-level mutable state". Counters are process-local by nature and
 * nothing here is ever read back to make a decision; it only flows outward
 * via GET /metrics.
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

// `reason` lets a dashboard tell a Spotify redesign from a network blip
// without grepping logs.
export const scrapeFailures = new Counter({
  name: 'sleevenote_scrape_failures_total',
  help: 'Failed extract() calls, by reason.',
  labelNames: ['reason'] as const,
  registers: [registry],
})

// The canary. The prior art died by silently returning nothing; a redesign
// that breaks our discriminators shows up here as a climbing rate.
export const extractionEmpty = new Counter({
  name: 'sleevenote_extraction_empty_total',
  help: 'Extractions that navigated successfully but yielded zero tracks -- extraction likely stopped matching Spotify\'s page.',
  registers: [registry],
})

/**
 * Which build is answering -- otherwise the version exists only in git and no
 * running instance can be asked. `build_info` is the Prometheus convention: a
 * gauge fixed at 1 whose labels carry the payload.
 */
export const buildInfo = new Gauge({
  name: 'sleevenote_build_info',
  help: 'Build metadata for the running instance. Always 1; read the labels.',
  labelNames: ['version'] as const,
  registers: [registry],
})

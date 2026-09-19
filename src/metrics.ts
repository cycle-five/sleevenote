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

// Listings that came back short of their declared total (Task 1/2), broken
// down by whether the caller opted in to receive one (`?partial=allow`) or
// got a 502 by the default policy. Lets a dashboard tell "extraction is
// falling short" apart from "and callers are/aren't asking for what we have".
export const partialListings = new Counter({
  name: 'sleevenote_partial_listings_total',
  help: 'Listings that came back short, by whether the caller accepted one.',
  labelNames: ['type', 'served'] as const,
  registers: [registry],
})

/**
 * Which build is answering -- otherwise the version exists only in git and no
 * running instance can be asked. `build_info` is the Prometheus convention: a
 * gauge fixed at 1 whose labels carry the payload.
 */
// Set from `pool.stats()` at scrape time, never tracked incrementally, so
// they cannot drift from the pool. `leased` at POOL_SIZE with `waiting` above
// zero is a starved pool: on 2026-09-19 that state lasted over an hour while
// /health answered "ok".
export const poolContexts = new Gauge({
  name: 'sleevenote_pool_contexts',
  help: 'Browser contexts by state (free/leased), read from the pool at scrape time.',
  labelNames: ['state'] as const,
  registers: [registry],
})

export const poolWaiting = new Gauge({
  name: 'sleevenote_pool_waiting',
  help: 'Callers queued for a browser context, read from the pool at scrape time.',
  registers: [registry],
})

// Generations, age and memory are read from the pool at scrape time. Age and
// memory carry a constant `state="serving"` label for one reason: reset() on a
// labelled gauge empties it, so the sample is ABSENT while no browser serves.
// An unlabelled gauge resets to 0, which would read as a brand-new browser.
export const browserGenerations = new Gauge({
  name: 'sleevenote_browser_generations',
  help: 'Browser generations by state (serving/draining), read from the pool at scrape time.',
  labelNames: ['state'] as const,
  registers: [registry],
})

export const browserAge = new Gauge({
  name: 'sleevenote_browser_age_seconds',
  help: 'Age of the serving browser, read at scrape time. Absent while none is serving.',
  labelNames: ['state'] as const,
  registers: [registry],
})

export const browserMemory = new Gauge({
  name: 'sleevenote_browser_memory_bytes',
  help: "PSS of the serving browser's process tree at the last sample. Absent while unmeasurable.",
  labelNames: ['state'] as const,
  registers: [registry],
})

export const browserLaunches = new Counter({
  name: 'sleevenote_browser_launches_total',
  help: 'Browser generations launched, by reason (startup/recycle_age/recycle_leases/recycle_memory/crash).',
  labelNames: ['reason'] as const,
  registers: [registry],
})

export const browserLaunchFailures = new Counter({
  name: 'sleevenote_browser_launch_failures_total',
  help: 'Browser launches after startup that failed, relaunch or recycle.',
  registers: [registry],
})

export const buildInfo = new Gauge({
  name: 'sleevenote_build_info',
  help: 'Build metadata for the running instance. Always 1; read the labels.',
  labelNames: ['version'] as const,
  registers: [registry],
})

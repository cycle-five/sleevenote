export type Config = {
  port: number
  redisUrl: string
  poolSize: number
  contextMaxUses: number
  contextCloseTimeoutMs: number
  navTimeoutMs: number
  produceBudgetMs: number
  failureRelayTtl: number
  logLevel: string
  entityDataTimeoutMs: number
  ttl: { track: number; album: number; playlist: number; negative: number }
  browserMaxAgeMs: number
  browserMaxLeases: number
  browserMaxMemoryMb: number
  browserCheckIntervalMs: number
  browserCloseTimeoutMs: number
  browserMaxRelaunchFailures: number
  poolWaitCapMs: number
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`expected a positive number, got ${JSON.stringify(raw)}`)
  }
  return n
}

function nonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`expected a number >= 0, got ${JSON.stringify(raw)}`)
  }
  return n
}

// Upper bound on one produce() call. Measured worst case is ~118s (nav 45s +
// scroll 200x350ms + settle 3s), and this must stay comfortably above it: the
// single-flight lock derives its TTL from the same number, so a value too low
// releases the lock mid-produce and lets a second Chromium load start --
// precisely what single-flight prevents.
export const DEFAULT_PRODUCE_BUDGET_MS = 150_000

// Long enough to sit behind two warm extractions (4-8s each) on a pool of
// two; short enough that a caller who was never going to be served soon hears
// so in seconds rather than after the whole budget.
export const DEFAULT_POOL_WAIT_CAP_MS = 20_000

// Mirrors cache.ts's DEFAULT_FAILURE_TTL_SECONDS. Defined here rather than
// imported to keep config.ts free of a dependency on the cache module.
export const DEFAULT_FAILURE_TTL_SECONDS = 5

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const produceBudgetMs = num(env.PRODUCE_BUDGET_MS, DEFAULT_PRODUCE_BUDGET_MS)
  // Left unset, the cap follows the budget, so shortening the budget never
  // breaks on a knob the operator has not heard of. Set explicitly at or
  // above the budget, it could never fire: a misconfiguration worth refusing.
  const poolWaitCapMs =
    env.POOL_WAIT_CAP_MS === undefined
      ? Math.max(1, Math.min(DEFAULT_POOL_WAIT_CAP_MS, Math.floor(produceBudgetMs / 2)))
      : num(env.POOL_WAIT_CAP_MS, DEFAULT_POOL_WAIT_CAP_MS)
  if (env.POOL_WAIT_CAP_MS !== undefined && poolWaitCapMs >= produceBudgetMs) {
    throw new Error(
      `POOL_WAIT_CAP_MS (${poolWaitCapMs}) must be below PRODUCE_BUDGET_MS (${produceBudgetMs}): a cap at or above the budget can never fire`,
    )
  }

  return {
    port: num(env.PORT, 3000),
    // The service used to construct Fastify with no logger at all, which made
    // `app.log` a no-op -- so a deployed instance emitted NOTHING, not even
    // its own "listening" line, and a failing lookup left no trace to read.
    logLevel: env.LOG_LEVEL ?? 'info',
    // How long to wait for the entity query AFTER the page looks settled.
    // Deliberately far below navTimeoutMs: this covers the gap between "the
    // page went idle" and "the data arrived", measured at >5s on a cold
    // context. Reusing the 45s nav timeout would make every genuinely silent
    // extraction cost 45s before it could say so.
    entityDataTimeoutMs: num(env.ENTITY_DATA_TIMEOUT_MS, 15_000),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    poolSize: num(env.POOL_SIZE, 2),
    contextMaxUses: num(env.CONTEXT_MAX_USES, 50),
    // A context close that has not finished by then is abandoned and the slot
    // refilled. Every close happens on a release path, so an unbounded one
    // holds the slot exactly as a stuck holder does.
    contextCloseTimeoutMs: num(env.CONTEXT_CLOSE_TIMEOUT_MS, 5_000),
    navTimeoutMs: num(env.NAV_TIMEOUT_MS, 45_000),
    produceBudgetMs,
    // Seconds, not minutes: a handoff to the cohort already waiting, not a
    // negative cache for errors. Raising it throttles a broken entity at the
    // price of caching our own bugs. See docs/design-notes.md.
    failureRelayTtl: num(env.FAILURE_RELAY_TTL, DEFAULT_FAILURE_TTL_SECONDS),
    ttl: {
      // A track's artist and title never change; an album's listing is fixed at
      // release. Playlists genuinely change, so they get hours, not days.
      track: num(env.TTL_TRACK, 30 * 24 * 3600),
      album: num(env.TTL_ALBUM, 30 * 24 * 3600),
      playlist: num(env.TTL_PLAYLIST, 4 * 3600),
      negative: num(env.TTL_NEGATIVE, 600),
    },
    // The browser is recycled on the first of these to hold. See
    // docs/superpowers/specs/2026-09-19-browser-context-manager-design.md.
    browserMaxAgeMs: num(env.BROWSER_MAX_AGE_MS, 6 * 3600 * 1000),
    browserMaxLeases: num(env.BROWSER_MAX_LEASES, 1000),
    browserMaxMemoryMb: nonNegative(env.BROWSER_MAX_MEMORY_MB, 2048),
    browserCheckIntervalMs: num(env.BROWSER_CHECK_INTERVAL_MS, 60_000),
    browserCloseTimeoutMs: num(env.BROWSER_CLOSE_TIMEOUT_MS, 10_000),
    browserMaxRelaunchFailures: num(env.BROWSER_MAX_RELAUNCH_FAILURES, 5),
    poolWaitCapMs,
  }
}

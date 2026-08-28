export type Config = {
  port: number
  redisUrl: string
  poolSize: number
  contextMaxUses: number
  navTimeoutMs: number
  produceBudgetMs: number
  failureRelayTtl: number
  ttl: { track: number; album: number; playlist: number; negative: number }
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`expected a positive number, got ${JSON.stringify(raw)}`)
  }
  return n
}

// Upper bound on one produce() call. Measured worst case is ~118s (nav 45s +
// scroll 200x350ms + settle 3s), and this must stay comfortably above it: the
// single-flight lock derives its TTL from the same number, so a value too low
// releases the lock mid-produce and lets a second Chromium load start --
// precisely what single-flight prevents.
export const DEFAULT_PRODUCE_BUDGET_MS = 150_000

// Mirrors cache.ts's DEFAULT_FAILURE_TTL_SECONDS. Defined here rather than
// imported to keep config.ts free of a dependency on the cache module.
export const DEFAULT_FAILURE_TTL_SECONDS = 5

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: num(env.PORT, 3000),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    poolSize: num(env.POOL_SIZE, 2),
    contextMaxUses: num(env.CONTEXT_MAX_USES, 50),
    navTimeoutMs: num(env.NAV_TIMEOUT_MS, 45_000),
    produceBudgetMs: num(env.PRODUCE_BUDGET_MS, DEFAULT_PRODUCE_BUDGET_MS),
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
  }
}

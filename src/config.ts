export type Config = {
  port: number
  redisUrl: string
  poolSize: number
  contextMaxUses: number
  navTimeoutMs: number
  produceBudgetMs: number
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

// Upper bound on one produce() call: navigation, then the scroll loop that
// pages through a large playlist, then a settle pause. Measured worst case is
// nav 45s + scroll (200 iterations x 350ms) 70s + settle 3s = ~118s. This
// must stay comfortably above that figure -- the cache's single-flight lock
// (cache.ts derives its TTL and wait timeout from this same value) must not
// expire while its legitimate holder is still working. If it's set too low,
// the lock releases mid-produce and a second caller acquires the *real* lock
// and starts a second, concurrent Chromium load -- exactly what single-flight
// exists to prevent. A future extractor task honours this same value as its
// own overall timeout, so one number governs both.
export const DEFAULT_PRODUCE_BUDGET_MS = 150_000

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: num(env.PORT, 3000),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    poolSize: num(env.POOL_SIZE, 2),
    contextMaxUses: num(env.CONTEXT_MAX_USES, 50),
    navTimeoutMs: num(env.NAV_TIMEOUT_MS, 45_000),
    produceBudgetMs: num(env.PRODUCE_BUDGET_MS, DEFAULT_PRODUCE_BUDGET_MS),
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

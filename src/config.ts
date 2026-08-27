export type Config = {
  port: number
  redisUrl: string
  poolSize: number
  contextMaxUses: number
  navTimeoutMs: number
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: num(env.PORT, 3000),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    poolSize: num(env.POOL_SIZE, 2),
    contextMaxUses: num(env.CONTEXT_MAX_USES, 50),
    navTimeoutMs: num(env.NAV_TIMEOUT_MS, 45_000),
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

import { loadConfig } from './config.js'
import { RedisStore } from './store.js'
import { createPool } from './browser.js'
import { extract } from './extract.js'
import { buildServer } from './server.js'
import { buildInfo } from './metrics.js'
import { readVersion } from './version.js'

export type ShutdownDeps = {
  app: { close: () => Promise<void> }
  pool: { close: () => Promise<void> }
  store: { close: () => Promise<void> }
}

/**
 * Stateless service, but this process still holds two live resources that do
 * NOT tolerate being torn down mid-request: the browser pool and the Redis
 * connection. `pool.close()` in particular is a HARD shutdown -- it
 * force-closes contexts that still have outstanding leases and does not wait
 * for in-flight work (see Task 4's report). So this order is not arbitrary:
 * close the HTTP server first and let Fastify drain requests already in
 * flight, THEN close the pool those requests were using, THEN close the
 * store nothing needs anymore. Closing the pool first would kill requests
 * mid-extraction.
 *
 * Pulled out of `main()` and exported so the ordering itself -- not just
 * `main()`'s wiring -- is directly testable with fakes recording call order,
 * no real socket or signal simulation needed. See tests/index.test.ts.
 */
export async function shutdownSequence(deps: ShutdownDeps): Promise<void> {
  await deps.app.close()
  await deps.pool.close()
  await deps.store.close()
}

async function main(): Promise<void> {
  const version = readVersion()
  // Set once, at startup: this is what lets an operator ask a *running*
  // instance which build it is, instead of inferring it from a deploy log.
  buildInfo.set({ version }, 1)

  const cfg = loadConfig(process.env)
  const store = new RedisStore(cfg.redisUrl)
  const pool = await createPool(cfg)
  const app = buildServer({ cfg, store, pool, extract })

  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  app.log.info(`sleevenote ${version} listening on :${cfg.port}`)

  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`${signal} received, draining in-flight requests`)
    try {
      await shutdownSequence({ app, pool, store })
      app.log.info('shutdown complete')
      process.exit(0)
    } catch (err) {
      app.log.error(err, 'error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

// Only run the real service when this module is the process entry point
// (`node dist/src/index.js`), not when it's imported -- e.g. by
// tests/index.test.ts importing `shutdownSequence` above. Without this
// guard, importing this module for its one testable export would also try
// to load real config, connect to Redis, and launch a real browser.
const isEntryPoint = import.meta.url === `file://${process.argv[1]}`
if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}

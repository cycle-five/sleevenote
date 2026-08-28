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
 * The order is load-bearing. `pool.close()` is a hard shutdown that
 * force-closes contexts with outstanding leases, so drain HTTP first, then
 * close the pool those requests were using, then the store nothing needs.
 * Closing the pool first kills requests mid-extraction.
 *
 * Exported so the ordering itself is testable with fakes recording call order.
 */
export async function shutdownSequence(deps: ShutdownDeps): Promise<void> {
  await deps.app.close()
  await deps.pool.close()
  await deps.store.close()
}

async function main(): Promise<void> {
  const version = readVersion()
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

// Only run when this module IS the entry point. Without the guard, importing
// `shutdownSequence` for a test would also connect to Redis and launch a
// browser.
const isEntryPoint = import.meta.url === `file://${process.argv[1]}`
if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}

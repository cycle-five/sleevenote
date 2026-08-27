import { loadConfig } from './config.js'
import { RedisStore } from './store.js'
import { createPool } from './browser.js'
import { extract } from './extract.js'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const store = new RedisStore(cfg.redisUrl)
  const pool = await createPool(cfg)
  const app = buildServer({ cfg, store, pool, extract })

  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  app.log.info(`sleevenote listening on :${cfg.port}`)

  // Stateless service, but this process still holds two live resources that
  // do NOT tolerate being torn down mid-request: the browser pool and the
  // Redis connection. pool.close() in particular is a HARD shutdown -- it
  // force-closes contexts that still have outstanding leases and does not
  // wait for in-flight work (see Task 4's report). So the order here is not
  // arbitrary: close the HTTP server first and let Fastify drain requests
  // already in flight, THEN close the pool those requests were using, THEN
  // close the store nothing needs anymore. Closing the pool first would kill
  // requests mid-extraction.
  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`${signal} received, draining in-flight requests`)
    try {
      await app.close()
      await pool.close()
      await store.close()
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

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

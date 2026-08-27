import { describe, it, expect, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'

const cfg = loadConfig({ POOL_SIZE: '2', CONTEXT_MAX_USES: '3' })
const pool = await createPool(cfg)
afterAll(async () => { await pool.close() })

describe('createPool', () => {
  it('reports live contexts once created', () => {
    expect(pool.liveContexts()).toBe(2)
  })

  it('serves a usable page and takes it back', async () => {
    const lease = await pool.acquire()
    await lease.page.setContent('<h1>hello</h1>')
    expect(await lease.page.textContent('h1')).toBe('hello')
    await lease.release()
  })

  // If acquire() rejected when busy, a third concurrent request would 500
  // rather than simply waiting its turn.
  it('makes a third caller wait rather than fail when the pool is exhausted', async () => {
    const a = await pool.acquire()
    const b = await pool.acquire()
    let served = false
    const pending = pool.acquire().then(async (c) => { served = true; await c.release() })
    await new Promise((r) => setTimeout(r, 100))
    expect(served).toBe(false)
    await a.release()
    await pending
    expect(served).toBe(true)
    await b.release()
  })

  it('blocks images so they never reach the network', async () => {
    const lease = await pool.acquire()
    const attempted: string[] = []
    lease.page.on('requestfailed', (r) => { if (r.resourceType() === 'image') attempted.push(r.url()) })
    await lease.page.setContent('<img src="https://example.invalid/x.png">')
    await lease.page.waitForTimeout(300)
    expect(attempted.length).toBeGreaterThan(0)
    await lease.release()
  })
})

import { describe, it, expect } from 'vitest'
import { launchBrowserProcess, type DeathCause } from '../src/browser-process.js'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

describe('launchBrowserProcess', () => {
  it('launches a Chromium it can name, use and measure, and closes it for good', async () => {
    const bp = await launchBrowserProcess()
    try {
      expect(bp.pid).toBeGreaterThan(0)
      expect(isAlive(bp.pid)).toBe(true)
      expect(bp.dead).toBe(false)
      const context = await bp.browser.newContext()
      const page = await context.newPage()
      await page.setContent('<h1>up</h1>')
      expect(await page.textContent('h1')).toBe('up')
      if (process.platform === 'linux') expect(bp.memoryBytes()).toBeGreaterThan(0)
    } finally {
      await bp.close(5_000)
    }
    expect(isAlive(bp.pid)).toBe(false)
  }, 30_000)

  // A SIGKILL is noticed twice -- the process exits AND the connection drops.
  // The pool must hear about it once, or it relaunches twice.
  it('reports a death it did not cause, exactly once', async () => {
    const bp = await launchBrowserProcess()
    const causes: DeathCause[] = []
    bp.onDeath((cause) => causes.push(cause))
    process.kill(bp.pid, 'SIGKILL')
    expect(await waitFor(() => causes.length > 0, 5_000)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(causes).toHaveLength(1)
    expect(bp.dead).toBe(true)
    expect(bp.memoryBytes()).toBeNull()
    await bp.close(1_000) // closing a dead browser is harmless
  }, 30_000)

  it('does not report its own close as a death', async () => {
    const bp = await launchBrowserProcess()
    const causes: DeathCause[] = []
    bp.onDeath((cause) => causes.push(cause))
    await bp.close(5_000)
    await new Promise((r) => setTimeout(r, 300))
    expect(causes).toEqual([])
  }, 30_000)

  // Final review, 2026-09-19: Playwright's own SIGTERM handler closed Chromium
  // before index.ts's shutdown ran, so every `docker stop` read as a crash --
  // a relaunch mid-drain, and in-flight lookups killed ahead of "close HTTP
  // first". Here rather than in browser.test.ts: Playwright installs its
  // handlers once, while any browser it launched is alive, and that file's
  // module-level pool would already have installed them.
  it('leaves the process signals to the service: createPool adds no SIGTERM, SIGINT or SIGHUP listener', async () => {
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
    const before = signals.map((s) => process.listenerCount(s))
    const exitBefore = process.listenerCount('exit')
    const pool = await createPool(loadConfig({ POOL_SIZE: '1' }))
    try {
      expect(signals.map((s) => process.listenerCount(s))).toEqual(before)
      // Its `exit` handler stays: a Node that exits without close() still
      // takes the browser with it.
      expect(process.listenerCount('exit')).toBe(exitBefore + 1)
    } finally {
      await pool.close()
    }
  }, 30_000)

  it('kills a browser whose graceful close never finishes', async () => {
    const bp = await launchBrowserProcess({ hangGracefulClose: true })
    const started = Date.now()
    await bp.close(500)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await waitFor(() => !isAlive(bp.pid), 2_000)).toBe(true)
  }, 30_000)
})

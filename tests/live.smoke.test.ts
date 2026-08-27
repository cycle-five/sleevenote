import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'
import { extract } from '../src/extract.js'

// Opt-in: this is the only test that touches the real internet. CI runs the
// offline suite; a schedule runs this. Last measured PASS: see git log for this file.
const LIVE = process.env.SLEEVENOTE_LIVE === '1'

const cfg = loadConfig({ POOL_SIZE: '1' })

describe.skipIf(!LIVE)('live extraction against real Spotify', () => {
  // A describe callback is synchronous, so the pool is built in beforeAll
  // rather than awaited inline.
  let pool: Awaited<ReturnType<typeof createPool>>
  beforeAll(async () => { pool = await createPool(cfg) }, 60_000)
  afterAll(async () => { await pool?.close() })

  it('resolves a known track', async () => {
    const t: any = await extract('track', '0c6xIDDpzE81m2q797ordA', pool, cfg)
    expect(t.name.length).toBeGreaterThan(0)
    expect(t.artists.length).toBeGreaterThan(0)
  }, 120_000)

  it('resolves a playlist with every track usable', async () => {
    const p: any = await extract('playlist', '37i9dQZF1DX4o1oenSJRJd', pool, cfg)
    expect(p.tracks.length).toBeGreaterThan(0)
    expect(p.tracks.filter((t: any) => !t.name || t.artists.length === 0)).toEqual([])
  }, 180_000)
})

if (!LIVE) {
  console.log('SKIP live extraction -- needs real network access to open.spotify.com; set SLEEVENOTE_LIVE=1 to run')
}

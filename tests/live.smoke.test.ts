import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'
import { extract, recordResponses } from '../src/extract.js'
import { albumItemCount, albumTotalCount, normalizeAlbum } from '../src/normalize.js'
import type { Recorded } from '../src/types.js'

// Opt-in: this is the only test that touches the real internet. CI runs the
// offline suite; a schedule runs this. Last measured PASS: see git log for this file.
const LIVE = process.env.SLEEVENOTE_LIVE === '1'

const cfg = loadConfig({ POOL_SIZE: '1' })

/**
 * Every `track.trackNumber` seen across every raw pathfinder response for
 * this album, one entry per raw item (not deduplicated). `Track` -- the
 * normalized shape `normalizeAlbum` returns -- carries no `trackNumber`
 * field, so checking recovered *positions* rather than just recovered
 * *count* means reaching past normalize.ts's output to the raw responses,
 * which is the only place that signal survives. Independent of
 * normalize.ts's own merge logic (`albumItemsByPosition`) by design: this
 * walks the same raw shape but does its own thing with it, so it can't
 * share a bug with the code it's checking.
 */
function rawTrackNumbers(recorded: Recorded[]): number[] {
  const numbers: number[] = []
  for (const entry of recorded as { body: any }[]) {
    const albumUnion = entry.body?.data?.albumUnion
    if (!albumUnion || albumUnion.__typename !== 'Album') continue
    const items = albumUnion.tracksV2?.items
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const trackNumber = item?.track?.trackNumber
      if (typeof trackNumber === 'number') numbers.push(trackNumber)
    }
  }
  return numbers
}

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

  it('recovers a paginated album completely, positions intact', async () => {
    // "60 Original Hits" -- declares 60 tracks, so recovery spans the
    // >50-item split that the (discNumber, trackNumber) merge exists to
    // fix: a first batch capped at 50 items, plus a second batch carrying
    // the remainder with no `uri` and no `pagingInfo` to key on.
    const id = '5s5svl5DzlSmEvkjuL8Upw'
    const declaredTotal = 60

    const lease = await pool.acquire()
    let recorded: Recorded[]
    try {
      recorded = await recordResponses(lease.page, `https://open.spotify.com/album/${id}`, cfg.navTimeoutMs)
    } finally {
      await lease.release()
    }

    expect(albumTotalCount(recorded, id)).toBe(declaredTotal)
    expect(albumItemCount(recorded, id)).toBe(declaredTotal)

    const album = normalizeAlbum(recorded, id)
    expect(album).not.toBeNull()
    expect(album!.tracks.length).toBe(declaredTotal)

    // Weak check: count alone. A merge bug that dropped one batch and
    // duplicated another, or that let one batch clobber another's
    // (discNumber, trackNumber) slots, could still land on a plausible
    // total and no duplicate ids.
    const ids = album!.tracks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)

    // Strong check: every trackNumber from 1..declaredTotal was actually
    // recovered -- a complete, contiguous run, not just the right count of
    // *something*. Deduplicated via Set before comparing so a response the
    // browser happened to deliver twice (unrelated to the merge bug this
    // guards against) can't fail the assertion on its own. This album is a
    // known flat compilation (discNumber observed as 1 throughout -- see
    // normalize.ts), so trackNumber alone, without discNumber, is a valid
    // position key here.
    const uniqueTrackNumbers = new Set(rawTrackNumbers(recorded))
    expect(uniqueTrackNumbers.size).toBe(declaredTotal)
    expect(Array.from(uniqueTrackNumbers).sort((a, b) => a - b)).toEqual(
      Array.from({ length: declaredTotal }, (_, i) => i + 1),
    )
  }, 180_000)
})

if (!LIVE) {
  console.log('SKIP live extraction -- needs real network access to open.spotify.com; set SLEEVENOTE_LIVE=1 to run')
}

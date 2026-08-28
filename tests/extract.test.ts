import { describe, it, expect, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'
import {
  recordResponses,
  extract,
  NotFoundError,
  ExtractionEmptyError,
  ExtractionIncompleteError,
} from '../src/extract.js'
import { normalizePlaylist, playlistItemCount, playlistTotalCount } from '../src/normalize.js'
import type { Recorded } from '../src/types.js'

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v2/query'

/** A `content.items[]` entry shaped like a real playlist track item. */
function playlistItem(trackId: string, name: string) {
  return {
    itemV2: {
      data: {
        __typename: 'Track',
        name,
        uri: `spotify:track:${trackId}`,
        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Some Artist' } }] },
        trackDuration: { totalMilliseconds: 200_000 },
      },
    },
  }
}

const cfg = loadConfig({ POOL_SIZE: '1' })
const pool = await createPool(cfg)
afterAll(async () => { await pool.close() })

describe('recordResponses', () => {
  it('records JSON responses the page fetches and ignores non-JSON', async () => {
    const lease = await pool.acquire()

    await lease.page.route('https://fake.test/**', async (route) => {
      const u = route.request().url()
      if (u.endsWith('/data.json')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hello: 'world' }) })
      }
      if (u.endsWith('/page')) {
        return route.fulfill({
          status: 200, contentType: 'text/html',
          body: `<html><body><script>fetch('https://fake.test/data.json');fetch('https://fake.test/plain.txt')</script></body></html>`,
        })
      }
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'not json' })
    })

    const recorded = await recordResponses(lease.page, 'https://fake.test/page', 10_000)
    await lease.release()

    const bodies = recorded.map((r) => r.body)
    expect(bodies).toContainEqual({ hello: 'world' })
    expect(recorded.every((r) => r.url.endsWith('.json'))).toBe(true)
  })
})

// `extract()` acquires its own lease internally, so there's no handle to the
// page it will use until after it's already navigating. The way to route
// that page ahead of time, given the pool never leaks its browser context
// (Task 4 deliberately keeps `Lease` down to just `.page`), is: acquire a
// lease from a pool of size 1, attach routes to that page, release it
// unused, then call `extract()` -- pool size 1 guarantees it gets handed
// back the exact same `Page` object, routes and all.
async function routedPage(p: Awaited<ReturnType<typeof createPool>>) {
  const lease = await p.acquire()
  await lease.release()
  return lease.page
}

/** A page-bearing `data.playlistV2` response, entity fields optional. */
function playlistPageResponse(
  id: string,
  opts: { offset: number; limit: number; itemCount: number; totalCount: number; entity?: boolean },
): Recorded {
  const items = Array.from({ length: opts.itemCount }, (_, i) => playlistItem(`t${opts.offset + i}`, `T${opts.offset + i}`))
  const content = { totalCount: opts.totalCount, pagingInfo: { offset: opts.offset, limit: opts.limit }, items }
  const playlistV2 = opts.entity
    ? {
        __typename: 'Playlist',
        name: 'Union Test Playlist',
        uri: `spotify:playlist:${id}`,
        ownerV2: { data: { name: 'Someone' } },
        images: { items: [] },
        content,
      }
    : { __typename: 'Playlist', content }
  return { url: PATHFINDER_URL, status: 200, body: { data: { playlistV2 } } }
}

// Fix round 4 (corrected): the first attempt at this fix computed `seen` as
// the union of each page's [offset, offset+items.length) range, which fixed
// the COUNT but left a worse bug in place -- normalizePlaylist itself
// (via the old playlistPages, which every one of these tests would still
// have been feeding from) still concatenated pages with no dedup, so a
// duplicated or overlapping page didn't just get miscounted, it produced an
// actual duplicate Track in the returned playlist. The real fix dedupes at
// the source: playlistItemsByIndex keys every item by absolute list
// position (offset + i) in a Map, so both normalizePlaylist's track list
// and playlistItemCount's count are built from the same
// already-deduplicated data -- there's exactly one place a duplicate or
// overlapping fetch gets resolved, not two. These are pure unit tests (no
// browser involved) because the defect is arithmetic/data-shape, not a
// scrolling or navigation behavior.
describe('playlist pagination: dedup by absolute index, not sum or naive concatenation', () => {
  it('collapses a duplicated page instead of summing it, so a genuinely missing page is still detected', () => {
    const id = 'dup-page'
    const recorded: Recorded[] = [
      playlistPageResponse(id, { offset: 0, limit: 2, itemCount: 2, totalCount: 4, entity: true }),
      // The same page 0 window recorded a second time (e.g. a retried
      // fetch). Offset 2 -- the genuinely missing page -- is never recorded.
      playlistPageResponse(id, { offset: 0, limit: 2, itemCount: 2, totalCount: 4 }),
    ]
    // Indices {0,1} deduplicated is 2 distinct positions, not the naive
    // sum 2+2=4.
    expect(playlistItemCount(recorded, id)).toBe(2)
    expect(playlistTotalCount(recorded, id)).toBe(4)
  })

  it('collapses overlapping ranges instead of summing them, so a genuine gap past the overlap is still detected', () => {
    const id = 'overlap-incomplete'
    const recorded: Recorded[] = [
      playlistPageResponse(id, { offset: 0, limit: 3, itemCount: 3, totalCount: 6, entity: true }),
      playlistPageResponse(id, { offset: 2, limit: 3, itemCount: 3, totalCount: 6 }),
    ]
    // Indices {0,1,2} union {2,3,4} = {0,1,2,3,4}, 5 distinct positions --
    // not the sum 3+3=6. Index 5 was genuinely never seen.
    expect(playlistItemCount(recorded, id)).toBe(5)
    expect(playlistTotalCount(recorded, id)).toBe(6)
  })

  it('succeeds when overlapping ranges still cover the full declared range, and produces no duplicate tracks', () => {
    const id = 'overlap-complete'
    const recorded: Recorded[] = [
      playlistPageResponse(id, { offset: 0, limit: 3, itemCount: 3, totalCount: 6, entity: true }),
      playlistPageResponse(id, { offset: 2, limit: 4, itemCount: 4, totalCount: 6 }),
    ]
    // Indices {0,1,2} union {2,3,4,5} = {0..5}, 6 distinct positions --
    // matches declared, even though the naive sum (3+4=7) overshoots it. An
    // aggressive-but-successful scroll must not be rejected for fetching
    // more than it strictly needed to.
    expect(playlistItemCount(recorded, id)).toBe(6)
    expect(playlistTotalCount(recorded, id)).toBe(6)

    // The assertion the union-only fix would have missed entirely: index 2
    // was recorded by BOTH pages. A correct count alone doesn't prove the
    // returned playlist itself is duplicate-free -- normalizePlaylist must
    // actually deduplicate the track it builds from index 2, not just agree
    // on a total.
    const playlist = normalizePlaylist(recorded, id)
    expect(playlist).not.toBeNull()
    expect(playlist!.tracks.length).toBe(6)
    expect(new Set(playlist!.tracks.map((t) => t.id)).size).toBe(6)
  })

  it('gives the same result on the real, non-overlapping fixtures, with no duplicate track URIs', async () => {
    const large = JSON.parse(await readFile('tests/fixtures/playlist-large.json', 'utf8')) as Recorded[]
    const small = JSON.parse(await readFile('tests/fixtures/playlist-small.json', 'utf8')) as Recorded[]
    const largeId = '37i9dQZF1DX4o1oenSJRJd'
    const smallId = '37i9dQZF1DXcBWIGoYBM5M'
    // docs/captured-shapes.md records these fixtures' four/two pages as
    // non-overlapping (offsets 0/25, 25/50, 75/50, 125/25 for the large one;
    // 0/25, 25/25 for the small one), so dedup-by-index should equal the
    // previously-verified counts -- confirming the real captures don't
    // overlap and this fix doesn't regress them.
    expect(playlistItemCount(large, largeId)).toBe(150)
    expect(playlistItemCount(small, smallId)).toBe(50)

    const largePlaylist = normalizePlaylist(large, largeId)
    const smallPlaylist = normalizePlaylist(small, smallId)
    expect(new Set(largePlaylist!.tracks.map((t) => t.id)).size).toBe(largePlaylist!.tracks.length)
    expect(new Set(smallPlaylist!.tracks.map((t) => t.id)).size).toBe(smallPlaylist!.tracks.length)
  })
})

describe('extract', () => {
  it('resolves a track by dispatching to normalizeTrack', async () => {
    const tCfg = loadConfig({ POOL_SIZE: '1' })
    const tPool = await createPool(tCfg)
    try {
      const id = 'trackHappyPathId'
      const page = await routedPage(tPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              trackUnion: {
                __typename: 'Track',
                name: 'Test Track',
                uri: `spotify:track:${id}`,
                firstArtist: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Test Artist' } }] },
                otherArtists: { items: [] },
                duration: { totalMilliseconds: 123456 },
              },
            },
          }),
        }),
      )

      const result = await extract('track', id, tPool, tCfg)
      expect(result.type).toBe('track')
      expect(result.name).toBe('Test Track')
      if (result.type === 'track') {
        expect(result.artists.map((a) => a.name)).toEqual(['Test Artist'])
        expect(result.durationMs).toBe(123456)
      }
    } finally {
      await tPool.close()
    }
  }, 20_000)

  it('resolves an album with its track list via normalizeAlbum', async () => {
    const aCfg = loadConfig({ POOL_SIZE: '1' })
    const aPool = await createPool(aCfg)
    try {
      const id = 'albumHappyPathId'
      const page = await routedPage(aPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              albumUnion: {
                __typename: 'Album',
                name: 'Test Album',
                uri: `spotify:album:${id}`,
                artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                coverArt: { sources: [{ url: 'https://img.example/album.jpg', width: 640, height: 640 }] },
                tracksV2: {
                  totalCount: 1,
                  items: [
                    {
                      track: {
                        name: 'Album Track One',
                        uri: 'spotify:track:albumtrack1',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                  ],
                },
              },
            },
          }),
        }),
      )

      const result = await extract('album', id, aPool, aCfg)
      expect(result.type).toBe('album')
      if (result.type === 'album') {
        expect(result.tracks.map((t) => t.name)).toEqual(['Album Track One'])
      }
    } finally {
      await aPool.close()
    }
  }, 20_000)

  it('throws NotFoundError, and still releases the lease, when nothing matches', async () => {
    const nCfg = loadConfig({ POOL_SIZE: '1' })
    const nPool = await createPool(nCfg)
    try {
      const id = 'notFoundId'
      const page = await routedPage(nPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>nothing here</body></html>' }),
      )

      await expect(extract('track', id, nPool, nCfg)).rejects.toThrow(NotFoundError)

      // Pool size 1: if extract() left the lease unreleased on this throwing
      // path, this would never resolve -- there is no second context for it
      // to be handed instead.
      let acquired = false
      const reacquire = nPool.acquire().then((l) => { acquired = true; return l })
      await Promise.race([reacquire, new Promise((r) => setTimeout(r, 2_000))])
      expect(acquired).toBe(true)
      await (await reacquire).release()
    } finally {
      await nPool.close()
    }
  }, 20_000)

  it('throws ExtractionEmptyError, not NotFoundError, and still releases the lease, on a zero-track playlist', async () => {
    const eCfg = loadConfig({ POOL_SIZE: '1' })
    const ePool = await createPool(eCfg)
    try {
      const id = 'emptyPlaylistId'
      const page = await routedPage(ePool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              playlistV2: {
                __typename: 'Playlist',
                name: 'Empty Playlist',
                uri: `spotify:playlist:${id}`,
                ownerV2: { data: { name: 'Someone' } },
                images: { items: [] },
                content: {
                  totalCount: 0,
                  pagingInfo: { limit: 25, offset: 0 },
                  items: [],
                },
              },
            },
          }),
        }),
      )

      // This is the whole point of the distinct error: the playlist is real
      // (name/uri matched), navigation succeeded, and the response we
      // parsed says zero tracks -- that must not surface as "not found".
      let caught: unknown
      try {
        await extract('playlist', id, ePool, eCfg)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ExtractionEmptyError)
      expect(caught).not.toBeInstanceOf(NotFoundError)

      let acquired = false
      const reacquire = ePool.acquire().then((l) => { acquired = true; return l })
      await Promise.race([reacquire, new Promise((r) => setTimeout(r, 2_000))])
      expect(acquired).toBe(true)
      await (await reacquire).release()
    } finally {
      await ePool.close()
    }
  }, 30_000)

  it('resolves a non-empty playlist via normalizePlaylist', async () => {
    const pCfg = loadConfig({ POOL_SIZE: '1' })
    const pPool = await createPool(pCfg)
    try {
      const id = 'playlistHappyPathId'
      const page = await routedPage(pPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              playlistV2: {
                __typename: 'Playlist',
                name: 'Test Playlist',
                uri: `spotify:playlist:${id}`,
                ownerV2: { data: { name: 'Someone' } },
                images: { items: [] },
                content: {
                  totalCount: 2,
                  pagingInfo: { limit: 25, offset: 0 },
                  items: [playlistItem('pt1', 'Playlist Track One'), playlistItem('pt2', 'Playlist Track Two')],
                },
              },
            },
          }),
        }),
      )

      const result = await extract('playlist', id, pPool, pCfg)
      expect(result.type).toBe('playlist')
      if (result.type === 'playlist') {
        expect(result.tracks.map((t) => t.name)).toEqual(['Playlist Track One', 'Playlist Track Two'])
      }
    } finally {
      await pPool.close()
    }
  }, 20_000)

  // Fix round 1: the zero-tracks check alone can't see a *partial* recovery
  // -- some tracks came back, just not all of them. This drives the
  // totalCount-vs-recovered comparison directly, with a single response (no
  // scrolling involved), so it's independent of whether the scroll loop
  // itself works -- that's what the next test is for.
  it('throws ExtractionIncompleteError when recovered tracks fall short of the declared total', async () => {
    const iCfg = loadConfig({ POOL_SIZE: '1' })
    const iPool = await createPool(iCfg)
    try {
      const id = 'incompletePlaylistId'
      const page = await routedPage(iPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              playlistV2: {
                __typename: 'Playlist',
                name: 'Incomplete Playlist',
                uri: `spotify:playlist:${id}`,
                ownerV2: { data: { name: 'Someone' } },
                images: { items: [] },
                content: {
                  // Declares 5 tracks total; this single response carries 2.
                  totalCount: 5,
                  pagingInfo: { limit: 2, offset: 0 },
                  items: [playlistItem('it1', 'Track A'), playlistItem('it2', 'Track B')],
                },
              },
            },
          }),
        }),
      )

      let caught: unknown
      try {
        await extract('playlist', id, iPool, iCfg)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ExtractionIncompleteError)
      expect(caught).not.toBeInstanceOf(ExtractionEmptyError)
      expect(caught).not.toBeInstanceOf(NotFoundError)
    } finally {
      await iPool.close()
    }
  }, 20_000)

  // Album counterpart of the playlist test above. These are two different
  // behaviours, not one tested twice: they read different JSON paths
  // (tracksV2.totalCount vs content.totalCount) through different helpers
  // (albumTotalCount vs playlistTotalCount) -- fix round 2 found that the
  // playlist branch alone being tested left the album branch's own
  // JSON-path wiring completely unverified.
  it('throws ExtractionIncompleteError when an album falls short of its declared track total', async () => {
    const iaCfg = loadConfig({ POOL_SIZE: '1' })
    const iaPool = await createPool(iaCfg)
    try {
      const id = 'incompleteAlbumId'
      const page = await routedPage(iaPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              albumUnion: {
                __typename: 'Album',
                name: 'Incomplete Album',
                uri: `spotify:album:${id}`,
                artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                coverArt: { sources: [{ url: 'https://img.example/album.jpg', width: 640, height: 640 }] },
                tracksV2: {
                  // Declares 5 tracks total; this single response carries 2.
                  totalCount: 5,
                  items: [
                    {
                      track: {
                        name: 'Track A',
                        uri: 'spotify:track:ia1',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                    {
                      track: {
                        name: 'Track B',
                        uri: 'spotify:track:ia2',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                  ],
                },
              },
            },
          }),
        }),
      )

      let caught: unknown
      try {
        await extract('album', id, iaPool, iaCfg)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ExtractionIncompleteError)
      expect(caught).not.toBeInstanceOf(ExtractionEmptyError)
      expect(caught).not.toBeInstanceOf(NotFoundError)
    } finally {
      await iaPool.close()
    }
  }, 20_000)

  // Fix round 3: this is the regression test for a false-positive the team
  // lead found by execution, not theory. A malformed item (no name) is
  // correctly dropped by normalize.ts's own validation (Task 2's rule --
  // useless to a search-query consumer) -- that is not a missed page, and
  // must not trip ExtractionIncompleteError. declared === seen (3 raw items
  // present, 3 declared) even though only 2 survive validation into the
  // returned track list. Before this fix, comparing declared against
  // tracks.length (2) instead of seen (3) would wrongly throw here -- and
  // because ExtractionIncompleteError is never cached, that would fail
  // every retry forever, which is worse than the truncation this check
  // exists to catch.
  it('does not throw ExtractionIncompleteError for a playlist that dropped a malformed item but missed nothing', async () => {
    const mCfg = loadConfig({ POOL_SIZE: '1' })
    const mPool = await createPool(mCfg)
    try {
      const id = 'malformedItemPlaylistId'
      const page = await routedPage(mPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              playlistV2: {
                __typename: 'Playlist',
                name: 'Malformed Item Playlist',
                uri: `spotify:playlist:${id}`,
                ownerV2: { data: { name: 'Someone' } },
                images: { items: [] },
                content: {
                  totalCount: 3,
                  pagingInfo: { limit: 25, offset: 0 },
                  items: [
                    playlistItem('one', 'One'),
                    {
                      itemV2: {
                        data: {
                          __typename: 'Track',
                          // Malformed: no name -- dropped by trackFromNode.
                          name: '',
                          uri: 'spotify:track:two',
                          artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Some Artist' } }] },
                          trackDuration: { totalMilliseconds: 200_000 },
                        },
                      },
                    },
                    playlistItem('three', 'Three'),
                  ],
                },
              },
            },
          }),
        }),
      )

      const result = await extract('playlist', id, mPool, mCfg)
      expect(result.type).toBe('playlist')
      if (result.type === 'playlist') {
        expect(result.tracks.map((t) => t.name)).toEqual(['One', 'Three'])
      }
    } finally {
      await mPool.close()
    }
  }, 20_000)

  // Album counterpart of the test above -- same reasoning, same fix, same
  // exposure: normalizeAlbum drops malformed items too.
  it('does not throw ExtractionIncompleteError for an album that dropped a malformed item but missed nothing', async () => {
    const maCfg = loadConfig({ POOL_SIZE: '1' })
    const maPool = await createPool(maCfg)
    try {
      const id = 'malformedItemAlbumId'
      const page = await routedPage(maPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              albumUnion: {
                __typename: 'Album',
                name: 'Malformed Item Album',
                uri: `spotify:album:${id}`,
                artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                coverArt: { sources: [{ url: 'https://img.example/album.jpg', width: 640, height: 640 }] },
                tracksV2: {
                  totalCount: 3,
                  items: [
                    {
                      track: {
                        name: 'One',
                        uri: 'spotify:track:one',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                    {
                      track: {
                        // Malformed: no name -- dropped by trackFromNode.
                        name: '',
                        uri: 'spotify:track:two',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                    {
                      track: {
                        name: 'Three',
                        uri: 'spotify:track:three',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                  ],
                },
              },
            },
          }),
        }),
      )

      const result = await extract('album', id, maPool, maCfg)
      expect(result.type).toBe('album')
      if (result.type === 'album') {
        expect(result.tracks.map((t) => t.name)).toEqual(['One', 'Three'])
      }
    } finally {
      await maPool.close()
    }
  }, 20_000)

  // Fix round 3 supplement: the playlist item -> Track conversion has no
  // __typename filter at all (unlike normalizeTrack, which checks
  // __typename === 'Track' before accepting), so a podcast episode or local
  // file in a real playlist reaches trackFromNode and returns null via a
  // DIFFERENT path than the malformed-name test above: it has a real name,
  // but no `artists` field at all (episodes don't have artists the way
  // tracks do), so `artistsFromItems` returns [] and trackFromNode's
  // "artists.length === 0" check drops it. Every fixture in this repo is an
  // editorial playlist (totalCount === items.length exactly), which is why
  // this never showed up there -- user playlists routinely mix in episodes
  // and local files. seen (raw item count) must still equal declared here,
  // same as the malformed-name case, because seen counts every item
  // regardless of why (or whether) it became a Track.
  it('does not throw ExtractionIncompleteError for a playlist containing a non-track item (e.g. a podcast episode)', async () => {
    const eCfg = loadConfig({ POOL_SIZE: '1' })
    const ePool = await createPool(eCfg)
    try {
      const id = 'episodeItemPlaylistId'
      const page = await routedPage(ePool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              playlistV2: {
                __typename: 'Playlist',
                name: 'Episode Item Playlist',
                uri: `spotify:playlist:${id}`,
                ownerV2: { data: { name: 'Someone' } },
                images: { items: [] },
                content: {
                  totalCount: 3,
                  pagingInfo: { limit: 25, offset: 0 },
                  items: [
                    playlistItem('one', 'One'),
                    {
                      itemV2: {
                        data: {
                          __typename: 'Episode',
                          name: 'Bonus Episode',
                          uri: 'spotify:episode:ep1',
                          // No `artists` field at all -- episodes don't have
                          // one the way tracks do. Dropped via a different
                          // check (artists.length === 0) than the
                          // malformed-name case above (name absent).
                          trackDuration: { totalMilliseconds: 1_800_000 },
                        },
                      },
                    },
                    playlistItem('three', 'Three'),
                  ],
                },
              },
            },
          }),
        }),
      )

      const result = await extract('playlist', id, ePool, eCfg)
      expect(result.type).toBe('playlist')
      if (result.type === 'playlist') {
        expect(result.tracks.map((t) => t.name)).toEqual(['One', 'Three'])
      }
    } finally {
      await ePool.close()
    }
  }, 20_000)

  // Album counterpart -- normalizeAlbum's item -> Track conversion has the
  // same missing __typename filter.
  it('does not throw ExtractionIncompleteError for an album containing a non-track item', async () => {
    const eaCfg = loadConfig({ POOL_SIZE: '1' })
    const eaPool = await createPool(eaCfg)
    try {
      const id = 'episodeItemAlbumId'
      const page = await routedPage(eaPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('https://api-partner.spotify.com/pathfinder/v2/query')</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              albumUnion: {
                __typename: 'Album',
                name: 'Episode Item Album',
                uri: `spotify:album:${id}`,
                artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                coverArt: { sources: [{ url: 'https://img.example/album.jpg', width: 640, height: 640 }] },
                tracksV2: {
                  totalCount: 3,
                  items: [
                    {
                      track: {
                        name: 'One',
                        uri: 'spotify:track:one',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                    {
                      track: {
                        __typename: 'Episode',
                        name: 'Bonus Episode',
                        uri: 'spotify:episode:ep1',
                        // No `artists` field -- dropped the same way as the
                        // playlist counterpart above.
                        duration: { totalMilliseconds: 1_800_000 },
                      },
                    },
                    {
                      track: {
                        name: 'Three',
                        uri: 'spotify:track:three',
                        artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
                        duration: { totalMilliseconds: 200_000 },
                      },
                    },
                  ],
                },
              },
            },
          }),
        }),
      )

      const result = await extract('album', id, eaPool, eaCfg)
      expect(result.type).toBe('album')
      if (result.type === 'album') {
        expect(result.tracks.map((t) => t.name)).toEqual(['One', 'Three'])
      }
    } finally {
      await eaPool.close()
    }
  }, 20_000)

  // The regression test for the two historical scroll bugs (see
  // docs/captured-shapes.md, "Pagination"): page.mouse.wheel firing at the
  // cursor's default (0,0) instead of the list container, and jumping
  // straight to scrollTop = scrollHeight, which skips the middle of a
  // virtualized list. Unlike every other test in this file, this page has a
  // real scrollable container, and each fetch is wired to the container's
  // *current* scrollTop (a page-index derived from where scrollTop is right
  // now), not to "has scrollTop ever passed X". That distinction matters: a
  // wheel event that scrolls nothing leaves scrollTop at 0 forever (only the
  // unconditional page-0 fetch ever fires), and a jump straight to the
  // bottom fires only the last page's fetch, skipping the middle page
  // entirely -- exactly like the real virtualized list does. Either bug
  // would leave this test recovering fewer than 6 tracks against a declared
  // total of 6, which is caught either as an incomplete recovery by the
  // completeness check above, or by the length/order assertions below.
  it('recovers every page of a playlist through a genuinely scrolled virtualized container', async () => {
    const sCfg = loadConfig({ POOL_SIZE: '1' })
    const sPool = await createPool(sCfg)
    try {
      const id = 'scrollPaginationId'
      const page = await routedPage(sPool)

      // Every fetch below hits the exact same URL, with no query string --
      // deliberately: normalize.ts's `pathfinderData` only recognizes the
      // real pathfinder endpoint by an *exact* match (production
      // distinguishes requests by POST body, never by query string, per
      // docs/captured-shapes.md), and a query-string-tagged URL would
      // silently fall outside that match, making this test pass or fail for
      // the wrong reason. Pages are told apart by call order instead, via
      // the `pageIndex` counter closed over below.
      const html = `<html><body>
        <div id="wrap" style="height:400px; overflow:auto;">
          <div style="height:2000px;"></div>
        </div>
        <script>
          fetch('https://api-partner.spotify.com/pathfinder/v2/query');
          var wrap = document.getElementById('wrap');
          var fired = new Set([0]);
          wrap.addEventListener('scroll', function () {
            var idx = Math.min(2, Math.floor(wrap.scrollTop / 640));
            if (!fired.has(idx)) {
              fired.add(idx);
              fetch('https://api-partner.spotify.com/pathfinder/v2/query');
            }
          });
        </script>
      </body></html>`

      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: html }),
      )
      let pageIndex = -1
      await page.route('https://api-partner.spotify.com/pathfinder/v2/query', (route) => {
        pageIndex++
        const offset = pageIndex * 2
        const content = {
          totalCount: 6,
          pagingInfo: { limit: 2, offset },
          items: [
            playlistItem(`pt${offset}`, `Track ${offset}`),
            playlistItem(`pt${offset + 1}`, `Track ${offset + 1}`),
          ],
        }
        // Only the page-0 response is entity-bearing (name/uri present),
        // matching docs/captured-shapes.md's rule that pages past the first
        // carry no name/uri.
        const playlistV2 =
          pageIndex === 0
            ? {
                __typename: 'Playlist',
                name: 'Scrollable Playlist',
                uri: `spotify:playlist:${id}`,
                ownerV2: { data: { name: 'Someone' } },
                images: { items: [] },
                content,
              }
            : { __typename: 'Playlist', content }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { playlistV2 } }),
        })
      })

      const result = await extract('playlist', id, sPool, sCfg)
      expect(result.type).toBe('playlist')
      if (result.type === 'playlist') {
        expect(result.tracks.length).toBe(6)
        expect(result.tracks.map((t) => t.name)).toEqual([
          'Track 0', 'Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5',
        ])
      }
    } finally {
      await sPool.close()
    }
  }, 30_000)

  it('honours cfg.produceBudgetMs as an overall ceiling, rejecting well before navigation+scroll would finish', async () => {
    const bCfg = loadConfig({ POOL_SIZE: '1', PRODUCE_BUDGET_MS: '5' })
    const bPool = await createPool(bCfg)
    try {
      const id = 'budgetId'
      const page = await routedPage(bPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>no fetches</body></html>' }),
      )

      const start = Date.now()
      await expect(extract('track', id, bPool, bCfg)).rejects.toThrow(/produceBudgetMs/)
      // The real navigation+scroll+settle path for this page is ~3.35s
      // (recordResponses' fixed scroll/settle timings). A 5ms budget should
      // win that race by a wide margin.
      expect(Date.now() - start).toBeLessThan(1_000)
    } finally {
      // The background work (runExtraction, including its own
      // `finally { lease.release() }`) is still in flight here -- see
      // withBudget's doc comment in src/extract.ts. Closing the pool now is
      // still safe: Task 4's close() force-tears-down contexts still out on
      // a lease, and releaseRecord() no-ops once the pool is closed.
      await bPool.close()
    }
  }, 10_000)
})

import { describe, it, expect, afterAll, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page, Request } from 'playwright'
import { createPool, BrowserUnavailableError, type LaunchEvent } from '../src/browser.js'
import { loadConfig } from '../src/config.js'
import {
  recordResponses,
  extract,
  withOffset,
  isWindowedQuery,
  pageOffsets,
  declaredTotalFrom,
  MAX_PAGES,
  NotFoundError,
  ExtractionEmptyError,
  ExtractionSilentError,
  ExtractionTimeoutError,
} from '../src/extract.js'
import {
  PATHFINDER_URL,
  normalizePlaylist,
  playlistItemCount,
  playlistTotalCount,
  albumTotalCount,
} from '../src/normalize.js'
import type { Recorded } from '../src/types.js'


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

/** The `trackUnion` shape normalizeTrack reads, matching the track test above. */
function trackUnionFor(id: string, name: string) {
  return {
    __typename: 'Track',
    name,
    uri: `spotify:track:${id}`,
    firstArtist: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Test Artist' } }] },
    otherArtists: { items: [] },
    duration: { totalMilliseconds: 123456 },
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

    const capture = await recordResponses(lease.page, 'https://fake.test/page', 'track', 'fakeId', 10_000, 500)
    await lease.release()

    const bodies = capture.responses.map((r) => r.body)
    expect(bodies).toContainEqual({ hello: 'world' })
    expect(capture.responses.every((r) => r.url.endsWith('.json'))).toBe(true)
    expect(capture.navStatus).toBe(200)
    // Nothing failed, so there is nothing for runExtraction to rule out.
    expect(capture.pageCallFailed).toBe(false)
  })
})

describe('withOffset', () => {
  const template = {
    url: PATHFINDER_URL,
    headers: { authorization: 'Bearer t' },
    body: {
      operationName: 'fetchPlaylist',
      variables: { uri: 'spotify:playlist:abc', offset: 0, limit: 25 },
      extensions: { persistedQuery: { sha256Hash: 'deadbeef' } },
    },
  }

  it('moves the window without disturbing anything else', () => {
    const next = withOffset(template, 25, 100)
    expect(next.body.variables).toMatchObject({ uri: 'spotify:playlist:abc', offset: 25, limit: 100 })
    expect(next.body.operationName).toBe('fetchPlaylist')
    expect(next.body.extensions).toEqual(template.body.extensions)
    expect(next.headers).toEqual(template.headers)
  })

  it('does not mutate the template it was given', () => {
    withOffset(template, 25, 100)
    expect(template.body.variables).toMatchObject({ offset: 0, limit: 25 })
  })
})

// This is the predicate `onRequest` uses to decide whether to capture a
// template at all. If it silently returned false for a request that should
// have been captured, Task 6's pagination loop would fall back to the scroll
// heuristic with nobody the wiser -- exactly today's broken behaviour, now
// dressed up as a legitimate "partial listing". A pure unit test catches that
// without needing a live network check.
describe('isWindowedQuery', () => {
  const windowedBody = { operationName: 'fetchPlaylist', variables: { uri: 'spotify:playlist:abc', offset: 0, limit: 25 } }

  it('is true for a pathfinder URL whose body has variables.offset defined', () => {
    expect(isWindowedQuery(PATHFINDER_URL, windowedBody)).toBe(true)
  })

  it('is false for a non-pathfinder URL, even with a windowed-looking body', () => {
    expect(isWindowedQuery('https://api-partner.spotify.com/other-endpoint', windowedBody)).toBe(false)
  })

  it('is false for a pathfinder URL with no variables at all', () => {
    expect(isWindowedQuery(PATHFINDER_URL, { operationName: 'fetchArtist' })).toBe(false)
  })

  it('is false for a pathfinder URL whose variables has no offset -- the entity-header query', () => {
    expect(isWindowedQuery(PATHFINDER_URL, { operationName: 'fetchTrack', variables: { uri: 'spotify:track:abc' } })).toBe(false)
  })
})

// The arithmetic of the pagination loop, separated from the browser so it can
// be tested at all. Getting `pageOffsets` wrong is not a visible failure once
// Phase 1 shipped: asking for too few pages returns a short listing, which is
// now a legitimate answer to an opt-in caller, so a loop that under-runs looks
// exactly like the feature working. MAX_PAGES matters for the opposite reason
// -- the total it walks toward is a number Spotify supplies.
describe('pageOffsets', () => {
  it('walks the window to the declared total and stops', () => {
    expect(pageOffsets(50, 25, 0)).toEqual([25])          // 25 already seen
    expect(pageOffsets(150, 50, 0)).toEqual([50, 100])
    expect(pageOffsets(25, 100, 0)).toEqual([])           // one page covered it
  })

  it('is bounded even against an absurd declared total', () => {
    expect(pageOffsets(1_000_000, 1, 0).length).toBeLessThanOrEqual(MAX_PAGES)
  })

  it('asks for nothing when the total is unknown', () => {
    expect(pageOffsets(null, 25, 0)).toEqual([])
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

/** The bearer the harvested template has to carry through to every repeat. */
const HARVEST_TOKEN = 'Bearer BQD-fake-harvested-token'

/**
 * A page that issues exactly ONE pathfinder request, shaped like the web
 * player's own: a POST whose JSON body carries `operationName`, a `variables`
 * object with `uri`/`offset`/`limit`, and the persisted-query hash, sent with
 * the bearer and client tokens that authenticate it. That is the request
 * `onRequest` has to recognise and `withOffset` has to be able to repeat.
 *
 * Nothing on this page is scrollable, deliberately: if the harvest fails
 * there is no second strategy to quietly rescue the listing, so the failure
 * shows up as a short listing rather than as a slower path to the same
 * answer.
 */
function windowedQueryPage(id: string, limit: number): string {
  return `<html><body><script>
    fetch('${PATHFINDER_URL}', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': '${HARVEST_TOKEN}',
        'client-token': 'AABfakeClientToken',
      },
      body: JSON.stringify({
        operationName: 'fetchPlaylistContents',
        variables: { uri: 'spotify:playlist:${id}', offset: 0, limit: ${limit} },
        extensions: { persistedQuery: { version: 1, sha256Hash: 'deadbeefdeadbeef' } },
      }),
    });
  </script></body></html>`
}

/**
 * Route the pathfinder endpoint, answering the CORS preflight first.
 *
 * A cross-origin POST carrying `authorization` and `content-type:
 * application/json` provokes an OPTIONS preflight, and a route that ignores
 * it fails the fetch outright -- so the page would issue no windowed query at
 * all and the test would be measuring the fallback. `respond` is called only
 * for the real POST, with the window it asked for.
 */
async function routePathfinder(
  page: Page,
  respond: (vars: { offset: number; limit: number }, req: Request) => unknown,
): Promise<void> {
  await page.route(PATHFINDER_URL, (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          // Reflected rather than '*': a wildcard does not cover
          // `Authorization`, which is exactly the header being repeated here.
          'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*',
        },
      })
    }
    const vars = (req.postDataJSON() as { variables: { offset: number; limit: number } }).variables
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify(respond(vars, req)),
    })
  })
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

  // The shortfall verdict now lives entirely in normalize (Task 1):
  // `complete` is derivable from `declaredItems` and `tracks.length` alone,
  // with no involvement from extract.ts. This is a short listing, not an
  // empty one, so it must come back rather than throw.
  it('returns a short listing instead of throwing, marked incomplete', () => {
    const id = '37i9dQZF1DXcBWIGoYBM5M'
    // Declares four, records two: the shape a truncated scroll produces.
    const recorded = [playlistPageResponse(id, { offset: 0, limit: 2, itemCount: 2, totalCount: 4, entity: true })]
    const pl = normalizePlaylist(recorded, id)!
    expect(pl.tracks).toHaveLength(2)
    expect(pl.declaredItems).toBe(4)
    expect(pl.complete).toBe(false)
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

  // A 200 that yields nothing is OUR failure. Reporting it as absence is what
  // served a live playlist as "not found" -- and, being negative-cached, kept
  // serving it that way for TTL_NEGATIVE.
  it('throws ExtractionSilentError, not NotFoundError, and still releases the lease, when the page loaded fine but nothing matched', async () => {
    // Short entity-data bound: no query is ever issued here, and the point is
    // that a silent extraction reports quickly rather than burning the wait.
    const nCfg = loadConfig({ POOL_SIZE: '1', ENTITY_DATA_TIMEOUT_MS: '500' })
    const nPool = await createPool(nCfg)
    try {
      const id = 'notFoundId'
      const page = await routedPage(nPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>nothing here</body></html>' }),
      )

      await expect(extract('track', id, nPool, nCfg)).rejects.toThrow(ExtractionSilentError)

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

  // The production failure, reproduced: a cold context spends the whole
  // networkidle/scroll/settle window on bootstrap and the entity query fires
  // AFTER it. Guessing via networkidle recorded 21 responses, none of them the
  // pathfinder query, and reported a live playlist as a silent extraction.
  it('waits for the entity query when it arrives after the page would otherwise be considered settled', async () => {
    const lCfg = loadConfig({ POOL_SIZE: '1' })
    const lPool = await createPool(lCfg)
    try {
      const id = 'lateTrackId'
      const page = await routedPage(lPool)

      // The page settles immediately -- nothing in flight -- and only issues
      // the entity query afterwards, exactly as a cold context does while it
      // works through /api/token, /v1/clienttoken, remote-config and consent.
      // networkidle + scroll + the 3s settle all elapse before the query.
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body>loading<script>setTimeout(() => fetch('${PATHFINDER_URL}'), 5000)</script></body></html>`,
        }),
      )
      await page.route('https://api-partner.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { trackUnion: trackUnionFor(id, 'Late Arrival') } }),
        }),
      )

      const track = await extract('track', id, lPool, lCfg)
      expect(track.type).toBe('track')
      expect(track.name).toBe('Late Arrival')
    } finally {
      await lPool.close()
    }
  }, 60_000)

  // Measured against the real site: a dead track or album answers 404, and a
  // dead playlist answers 400 -- so the test is "not ok", never "=== 404".
  it.each([
    ['track', 404],
    ['album', 404],
    ['playlist', 400],
  ] as const)('throws NotFoundError when Spotify answers a %s navigation with %i', async (kind, status) => {
    const cfg404 = loadConfig({ POOL_SIZE: '1' })
    const pool404 = await createPool(cfg404)
    try {
      const page = await routedPage(pool404)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status, contentType: 'text/html', body: '<html><body>Page not found</body></html>' }),
      )
      await expect(extract(kind, 'goneId', pool404, cfg404)).rejects.toThrow(NotFoundError)
    } finally {
      await pool404.close()
    }
  }, 20_000)

  it('carries the navigation status as evidence, so the two cases are distinguishable in a log', async () => {
    const eCfg = loadConfig({ POOL_SIZE: '1', ENTITY_DATA_TIMEOUT_MS: '500' })
    const ePool = await createPool(eCfg)
    try {
      const page = await routedPage(ePool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>nothing</body></html>' }),
      )
      const err = await extract('track', 'someId', ePool, eCfg).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ExtractionSilentError)
      expect((err as ExtractionSilentError).evidence).toMatchObject({ navStatus: 200, recorded: 0 })
    } finally {
      await ePool.close()
    }
  }, 20_000)

  it('does not scroll a page that already said the entity is gone', async () => {
    const sCfg = loadConfig({ POOL_SIZE: '1' })
    const sPool = await createPool(sCfg)
    try {
      const page = await routedPage(sPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 404, contentType: 'text/html', body: '<html><body>gone</body></html>' }),
      )
      const started = Date.now()
      await expect(extract('track', 'goneId', sPool, sCfg)).rejects.toThrow(NotFoundError)
      // The scroll settle alone is 3s; bailing on the navigation status skips it.
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      await sPool.close()
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
  //
  // Was: 'throws ExtractionIncompleteError when recovered tracks fall short
  // of the declared total'. The shortfall verdict moved to normalize
  // (Task 1); extract.ts no longer throws on it, it returns the short
  // listing with `complete: false`. Same behavioural claim, relocated.
  it('returns a short listing instead of throwing, marked incomplete -- playlist falls short of its declared total', async () => {
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

      const result = await extract('playlist', id, iPool, iCfg)
      expect(result.type).toBe('playlist')
      if (result.type === 'playlist') {
        expect(result.tracks.map((t) => t.name)).toEqual(['Track A', 'Track B'])
        expect(result.declaredItems).toBe(5)
        expect(result.complete).toBe(false)
      }
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
  //
  // Was: 'throws ExtractionIncompleteError when an album falls short of its
  // declared track total'. Same relocation as the playlist test above.
  it('returns a short listing instead of throwing, marked incomplete -- album falls short of its declared total', async () => {
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

      const result = await extract('album', id, iaPool, iaCfg)
      expect(result.type).toBe('album')
      if (result.type === 'album') {
        expect(result.tracks.map((t) => t.name)).toEqual(['Track A', 'Track B'])
        expect(result.declaredItems).toBe(5)
        expect(result.complete).toBe(false)
      }
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

  // The pagination path, end to end through a real browser page: harvest the
  // page's own windowed query, repeat it at each remaining offset, and let
  // the responses arrive through the same interceptor the scroll path filled.
  //
  // This is the half of the design doc's testing section that the
  // `isWindowedQuery` and `pageOffsets` unit tests cannot cover. Those judge
  // request bodies the test itself wrote, so they prove the predicate is
  // self-consistent -- never that a request shaped like the web player's own
  // satisfies it, which is the actual risk. (tests/live.smoke.test.ts is not
  // this test either: it recovers a live album 60/60 without ever asserting
  // that a template was harvested, so it passes just as happily if the scroll
  // fallback did the work.)
  //
  // Three things have to hold at once, and only the combination is
  // meaningful: a real-shaped POST is recognised (the page has no scrollable
  // container, so a failed harvest cannot be rescued -- it would show up as
  // offsets [0] and 2 tracks of 6), the offsets walk to the declared total,
  // and the Recorded[] that results normalizes into a complete listing.
  it("harvests the page's own pathfinder POST and pages by offset to the declared total", async () => {
    const pCfg = loadConfig({ POOL_SIZE: '1' })
    const pPool = await createPool(pCfg)
    try {
      const id = 'paginatedPlaylistId'
      const page = await routedPage(pPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: windowedQueryPage(id, 2) }),
      )

      const offsetsSeen: number[] = []
      const authSeen: (string | undefined)[] = []
      await routePathfinder(page, (vars, req) => {
        offsetsSeen.push(vars.offset)
        authSeen.push(req.headers()['authorization'])
        const content = {
          totalCount: 6,
          pagingInfo: { offset: vars.offset, limit: vars.limit },
          items: [
            playlistItem(`pt${vars.offset}`, `Track ${vars.offset}`),
            playlistItem(`pt${vars.offset + 1}`, `Track ${vars.offset + 1}`),
          ],
        }
        // Only the first window is entity-bearing, per
        // docs/captured-shapes.md: pages past the first carry no name/uri.
        const playlistV2 =
          vars.offset === 0
            ? {
                __typename: 'Playlist',
                name: 'Paginated Playlist',
                uri: `spotify:playlist:${id}`,
                ownerV2: { data: { name: 'Someone' } },
                images: { items: [] },
                content,
              }
            : { __typename: 'Playlist', content }
        return { data: { playlistV2 } }
      })

      const result = await extract('playlist', id, pPool, pCfg)

      // The page asked for offset 0; everything after it is ours.
      expect(offsetsSeen).toEqual([0, 2, 4])
      // Repeated, not reconstructed: the credentials on every window are the
      // ones the page itself sent, which is why no token handling of our own
      // is needed.
      expect([...new Set(authSeen)]).toEqual([HARVEST_TOKEN])

      expect(result.type).toBe('playlist')
      if (result.type === 'playlist') {
        expect(result.declaredItems).toBe(6)
        expect(result.complete).toBe(true)
        expect(result.tracks.map((t) => t.name)).toEqual([
          'Track 0', 'Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5',
        ])
      }
    } finally {
      await pPool.close()
    }
  }, 30_000)

  // Fix wave, finding 4. Three different causes produce a short listing and
  // only one of them (a window failing mid-loop) used to leave a trace, so an
  // operator looking at one could not tell which had happened -- and since
  // partial listings shipped, a shortfall is handed to an opt-in caller
  // looking exactly like a complete answer.
  it('warns when no template could be harvested and it falls back to scrolling', async () => {
    const wCfg = loadConfig({ POOL_SIZE: '1' })
    const wPool = await createPool(wCfg)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const id = 'noTemplateId'
      const page = await routedPage(wPool)
      // A bare GET: nothing to repeat, so the scroll fallback is taken.
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<html><body><script>fetch('${PATHFINDER_URL}')</script></body></html>`,
        }),
      )
      await page.route(PATHFINDER_URL, (route) =>
        route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          body: JSON.stringify(playlistPageResponse(id, { offset: 0, limit: 1, itemCount: 1, totalCount: 1, entity: true }).body),
        }),
      )

      const result = await extract('playlist', id, wPool, wCfg)
      expect(result.type).toBe('playlist')
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
        /no windowed pathfinder query to repeat/,
      )
    } finally {
      warn.mockRestore()
      await wPool.close()
    }
  }, 30_000)

  // The quietest of the three: with no declared total the loop fetches no
  // windows at all, and the verdict is `complete: true` by definition ("we
  // cannot tell, so do not claim a shortfall"), so nothing else in the
  // response marks it.
  it('warns when nothing declared a total, so no windows are fetched', async () => {
    const nCfg = loadConfig({ POOL_SIZE: '1' })
    const nPool = await createPool(nCfg)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const id = 'noTotalId'
      const page = await routedPage(nPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: windowedQueryPage(id, 2) }),
      )
      let requests = 0
      await routePathfinder(page, (vars) => {
        requests++
        return {
          data: {
            playlistV2: {
              __typename: 'Playlist',
              name: 'Totalless Playlist',
              uri: `spotify:playlist:${id}`,
              ownerV2: { data: { name: 'Someone' } },
              images: { items: [] },
              // No totalCount: the window is all anyone can know about.
              content: { pagingInfo: { offset: vars.offset, limit: vars.limit }, items: [playlistItem('pt0', 'Track 0')] },
            },
          },
        }
      })

      const result = await extract('playlist', id, nPool, nCfg)
      expect(result.type).toBe('playlist')
      if (result.type === 'playlist') expect(result.declaredItems).toBeNull()
      // The template was harvested; there was simply no total to walk toward.
      expect(requests).toBe(1)
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/no declared total/)
    } finally {
      warn.mockRestore()
      await nPool.close()
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

// The number the pagination loop walks toward. It has to come from the same
// counters the completeness verdict reads, or the loop can stop at a total the
// verdict then calls short -- a listing marked incomplete that nothing will
// ever complete, because pagination believed it was done.
describe('declaredTotalFrom', () => {
  /** The minimum `albumUnion` shape `albumTotalCount` will read a total off. */
  function albumTotalResponse(id: string, totalCount: number): Recorded {
    return {
      url: PATHFINDER_URL,
      status: 200,
      body: {
        data: {
          albumUnion: { __typename: 'Album', uri: `spotify:album:${id}`, tracksV2: { totalCount } },
        },
      },
    }
  }

  it('reads an album total off the same counter the completeness check uses', () => {
    const recorded = [albumTotalResponse('albumId', 60)]
    expect(declaredTotalFrom('album', recorded, 'albumId')).toBe(60)
    expect(declaredTotalFrom('album', recorded, 'albumId')).toBe(albumTotalCount(recorded, 'albumId'))
  })

  it('reads a playlist total off the same counter the completeness check uses', () => {
    const recorded = [
      playlistPageResponse('plId', { offset: 0, limit: 25, itemCount: 25, totalCount: 50, entity: true }),
    ]
    expect(declaredTotalFrom('playlist', recorded, 'plId')).toBe(50)
    expect(declaredTotalFrom('playlist', recorded, 'plId')).toBe(playlistTotalCount(recorded, 'plId'))
  })

  it('is null for a track -- one item, nothing to page through', () => {
    const recorded = [albumTotalResponse('albumId', 60)]
    expect(declaredTotalFrom('track', recorded, 'albumId')).toBeNull()
  })

  it('is null when nothing declared a total, so the loop asks for nothing', () => {
    expect(declaredTotalFrom('album', [], 'albumId')).toBeNull()
    expect(declaredTotalFrom('playlist', [], 'plId')).toBeNull()
  })
})

const TIMED_OUT = Symbol('timed out')

/** `p`'s value if it settles within `ms`, else TIMED_OUT. Never rejects on `p`'s behalf. */
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), ms) })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// Production, 2026-09-19: see tests/browser.test.ts's "a lease past its
// deadline". These are the extraction half -- the budget has to reach the
// pool, and the two waits that had no bound of their own get one, so a stall
// costs seconds instead of the whole budget.
describe('extract: a stuck extraction', () => {
  it('gives the context back when the budget runs out, not when the stuck work finishes', async () => {
    // The page never issues the entity query, so the extraction sits in its
    // entity-data wait for 8s. The budget is 1s.
    const bCfg = loadConfig({ POOL_SIZE: '1', PRODUCE_BUDGET_MS: '1000', ENTITY_DATA_TIMEOUT_MS: '8000' })
    const bPool = await createPool(bCfg)
    try {
      const page = await routedPage(bPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>nothing yet</body></html>' }),
      )
      await expect(extract('track', 'stuckId', bPool, bCfg)).rejects.toThrow(ExtractionTimeoutError)

      // Pool of one. Before the fix this waited out the rest of the 8s.
      const next = await settlesWithin(bPool.acquire(), 2_000)
      expect(next).not.toBe(TIMED_OUT)
      if (next !== TIMED_OUT) await next.release()
    } finally {
      await bPool.close()
    }
  }, 30_000)

  it('stops waiting on a JSON response whose body never finishes arriving', async () => {
    // A real server: page.route can only fulfil a whole body, and the hang
    // needs headers that arrive and a body that does not.
    const server: Server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' })
        // Both fetches start well after the page has gone network-idle, which
        // is where production stalled: past `goto`, inside the body wait.
        res.end(`<html><body><script>
          setTimeout(() => fetch('/stall.json'), 1500);
          setTimeout(() => fetch('${PATHFINDER_URL}', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': '${HARVEST_TOKEN}' },
            body: JSON.stringify({
              operationName: 'fetchPlaylistContents',
              variables: { uri: 'spotify:playlist:stallId', offset: 0, limit: 25 },
            }),
          }), 1800);
        </script></body></html>`)
        return
      }
      if (req.url === '/stall.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"never":') // ...and never another byte
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port

    const sCfg = loadConfig({ POOL_SIZE: '1' })
    const sPool = await createPool(sCfg)
    try {
      const lease = await sPool.acquire()
      await routePathfinder(lease.page, (vars) =>
        playlistPageResponse('stallId', { offset: vars.offset, limit: 25, itemCount: 25, totalCount: 25, entity: true }).body,
      )
      const capture = await settlesWithin(
        // The entity wait has to outlast the 1.8s pathfinder fetch, or the
        // capture never reaches the body wait at all and takes the scroll path.
        recordResponses(lease.page, `http://127.0.0.1:${port}/page`, 'playlist', 'stallId', 10_000, 2_500),
        10_000,
      )
      expect(capture).not.toBe(TIMED_OUT)
      // What did arrive is kept: the stall costs a bounded wait, not the listing.
      if (capture !== TIMED_OUT) expect(capture.responses.some((r) => r.url.startsWith(PATHFINDER_URL))).toBe(true)
      await lease.release()
    } finally {
      await sPool.close()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  }, 30_000)

  it('gives up on a pagination window that never answers, and serves the short listing', async () => {
    const id = 'silentWindowId'
    const wCfg = loadConfig({ POOL_SIZE: '1', ENTITY_DATA_TIMEOUT_MS: '500' })
    const wPool = await createPool(wCfg)
    try {
      const page = await routedPage(wPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: windowedQueryPage(id, 25) }),
      )
      await page.route(PATHFINDER_URL, (route) => {
        const req = route.request()
        if (req.method() === 'OPTIONS') {
          return route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*',
            },
          })
        }
        const { offset } = (req.postDataJSON() as { variables: { offset: number } }).variables
        // The second window is never answered -- not refused, not failed.
        if (offset > 0) return
        return route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          body: JSON.stringify(playlistPageResponse(id, { offset: 0, limit: 25, itemCount: 25, totalCount: 50, entity: true }).body),
        })
      })

      const result = await settlesWithin(extract('playlist', id, wPool, wCfg), 15_000)
      expect(result).not.toBe(TIMED_OUT)
      if (result !== TIMED_OUT && result.type === 'playlist') {
        expect(result.tracks).toHaveLength(25)
        expect(result.complete).toBe(false)
      }
    } finally {
      await wPool.close()
    }
  }, 30_000)

  // The other catch that swallows a page call: a response body read. One the
  // browser dies under has to be flagged just like a failed window.
  it('flags a body read that the browser died under', async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><body><script>
          setTimeout(() => fetch('/stall.json'), 600);
          setTimeout(() => fetch('${PATHFINDER_URL}', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': '${HARVEST_TOKEN}' },
            body: JSON.stringify({
              operationName: 'fetchPlaylistContents',
              variables: { uri: 'spotify:playlist:readId', offset: 0, limit: 25 },
            }),
          }), 800);
        </script></body></html>`)
        return
      }
      if (req.url === '/stall.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"never":') // ...and never another byte
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port

    const launches: LaunchEvent[] = []
    const rPool = await createPool(loadConfig({ POOL_SIZE: '1' }), {
      observer: { launched: (e) => { launches.push(e) }, launchFailed: () => {} },
    })
    try {
      const lease = await rPool.acquire()
      let pathfinderAnswered = (): void => {}
      const answered = new Promise<void>((resolve) => { pathfinderAnswered = resolve })
      // 25 of 25: no window to fetch, so the body read is the only page call
      // left that can fail.
      await routePathfinder(lease.page, () => {
        pathfinderAnswered()
        return playlistPageResponse('readId', { offset: 0, limit: 25, itemCount: 25, totalCount: 25, entity: true }).body
      })
      const capturing = recordResponses(lease.page, `http://127.0.0.1:${port}/page`, 'playlist', 'readId', 10_000, 5_000)
      expect(await settlesWithin(answered, 10_000)).not.toBe(TIMED_OUT)
      // Now inside the bounded wait for /stall.json's body.
      await new Promise((r) => setTimeout(r, 300))
      process.kill(launches[0]!.pid, 'SIGKILL')
      const capture = await settlesWithin(capturing, 10_000)
      expect(capture).not.toBe(TIMED_OUT)
      if (capture !== TIMED_OUT) expect(capture.pageCallFailed).toBe(true)
      await lease.release()
    } finally {
      await rPool.close()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  }, 30_000)

  // Final review, 2026-09-19: the window loop above swallows every failed
  // page call, "Browser closed" included, and returned a normal capture. A
  // crash mid-pagination went out as a short listing: a 200 to a caller that
  // opts into partials -- cracktunes does -- cached for up to 30 days, and a
  // 502 that blamed Spotify to one that does not.
  it('reports a browser crash while a window is pending as BrowserUnavailableError, not a short listing', async () => {
    const id = 'crashWindowId'
    const launches: LaunchEvent[] = []
    // A window long enough to still be pending when the browser is killed.
    const cCfg = loadConfig({ POOL_SIZE: '1', ENTITY_DATA_TIMEOUT_MS: '10000' })
    const cPool = await createPool(cCfg, {
      observer: { launched: (e) => { launches.push(e) }, launchFailed: () => {} },
    })
    try {
      const page = await routedPage(cPool)
      await page.route('https://open.spotify.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: windowedQueryPage(id, 25) }),
      )
      let windowAsked = (): void => {}
      const asked = new Promise<void>((resolve) => { windowAsked = resolve })
      await page.route(PATHFINDER_URL, (route) => {
        const req = route.request()
        if (req.method() === 'OPTIONS') {
          return route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*',
            },
          })
        }
        const { offset } = (req.postDataJSON() as { variables: { offset: number } }).variables
        if (offset > 0) {
          windowAsked() // ...and never answered
          return
        }
        return route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          body: JSON.stringify(playlistPageResponse(id, { offset: 0, limit: 25, itemCount: 25, totalCount: 50, entity: true }).body),
        })
      })

      const pending = extract('playlist', id, cPool, cCfg).catch((e: unknown) => e)
      expect(await settlesWithin(asked, 10_000)).not.toBe(TIMED_OUT)
      process.kill(launches[0]!.pid, 'SIGKILL')
      const outcome = await settlesWithin(pending, 10_000)
      expect(outcome).toBeInstanceOf(BrowserUnavailableError)
    } finally {
      await cPool.close()
    }
  }, 30_000)

  it('reports a browser crash mid-extraction as BrowserUnavailableError, not as the Playwright error it interrupted', async () => {
    const launches: LaunchEvent[] = []
    const cCfg = loadConfig({ POOL_SIZE: '1' })
    const cPool = await createPool(cCfg, {
      observer: { launched: (e) => { launches.push(e) }, launchFailed: () => {} },
    })
    try {
      const page = await routedPage(cPool)
      // The document never arrives, so the extraction sits in goto.
      await page.route('https://open.spotify.com/**', () => {})
      const pending = extract('track', 'crashId', cPool, cCfg).catch((e: unknown) => e)
      await new Promise((r) => setTimeout(r, 500))
      process.kill(launches[0]!.pid, 'SIGKILL')
      expect(await settlesWithin(pending, 10_000)).toBeInstanceOf(BrowserUnavailableError)
    } finally {
      await cPool.close()
    }
  }, 30_000)
})

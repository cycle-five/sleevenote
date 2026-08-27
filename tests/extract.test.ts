import { describe, it, expect, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'
import { recordResponses, extract, NotFoundError, ExtractionEmptyError } from '../src/extract.js'

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
})

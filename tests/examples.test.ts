// Guards docs/examples/*.json -- the committed wire contract an out-of-repo
// Rust client builds against -- against silent drift from src/types.ts.
// Casting parsed JSON to these types means a field rename here fails
// `tsc --noEmit`; the `expect` calls below check the file actually has the
// field, with the right JSON type and nullability, at runtime.
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { Artist, Track, Album, Playlist } from '../src/types.js'

type ErrorBody = { error: string; id: string; message: string }

async function load<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(`docs/examples/${name}.json`, 'utf8')) as T
}

function checkArtist(a: Artist) {
  expect(typeof a.name).toBe('string')
  expect(a.id === null || typeof a.id === 'string').toBe(true)
}

function checkTrack(t: Track) {
  expect(typeof t.id).toBe('string')
  expect(t.type).toBe('track')
  expect(typeof t.name).toBe('string')
  expect(Array.isArray(t.artists)).toBe(true)
  expect(t.artists.length).toBeGreaterThan(0)
  t.artists.forEach(checkArtist)
  if (t.album === null) {
    expect(t.album).toBeNull()
  } else {
    expect(typeof t.album.name).toBe('string')
    expect(t.album.id === null || typeof t.album.id === 'string').toBe(true)
    expect(t.album.image === null || typeof t.album.image === 'string').toBe(true)
  }
  expect(t.durationMs === null || typeof t.durationMs === 'number').toBe(true)
  expect(typeof t.url).toBe('string')
}

function checkErrorBody(b: ErrorBody, expectedError: string) {
  expect(b.error).toBe(expectedError)
  expect(typeof b.id).toBe('string')
  expect(typeof b.message).toBe('string')
}

describe('docs/examples/track.json', () => {
  it('matches the Track contract', async () => {
    const track = await load<Track>('track')
    checkTrack(track)
    // This fixture is the case where the album is known -- exercise it.
    expect(track.album).not.toBeNull()
  })
})

describe('docs/examples/album.json', () => {
  it('matches the Album contract', async () => {
    const album = await load<Album>('album')
    expect(typeof album.id).toBe('string')
    expect(album.type).toBe('album')
    expect(typeof album.name).toBe('string')
    expect(Array.isArray(album.artists)).toBe(true)
    album.artists.forEach(checkArtist)
    expect(album.image === null || typeof album.image === 'string').toBe(true)
    expect(typeof album.url).toBe('string')
    expect(Array.isArray(album.tracks)).toBe(true)
    album.tracks.forEach(checkTrack)
    expect(typeof album.unresolvedItems).toBe('number')
    // Per CONTRACT.md: 60 tracks, none unresolved.
    expect(album.tracks.length).toBe(60)
    expect(album.unresolvedItems).toBe(0)
    // A track nested in an album carries a null `album` -- the API doesn't
    // repeat the album it's already inside.
    expect(album.tracks[0]?.album).toBeNull()
  })
})

describe('docs/examples/playlist.json', () => {
  it('matches the Playlist contract', async () => {
    const playlist = await load<Playlist>('playlist')
    expect(typeof playlist.id).toBe('string')
    expect(playlist.type).toBe('playlist')
    expect(typeof playlist.name).toBe('string')
    expect(playlist.owner === null || typeof playlist.owner === 'string').toBe(true)
    expect(playlist.image === null || typeof playlist.image === 'string').toBe(true)
    expect(typeof playlist.url).toBe('string')
    expect(Array.isArray(playlist.tracks)).toBe(true)
    playlist.tracks.forEach(checkTrack)
    expect(typeof playlist.unresolvedItems).toBe('number')
    // Per CONTRACT.md: 2 tracks, 2 unresolved (a local file each).
    expect(playlist.tracks.length).toBe(2)
    expect(playlist.unresolvedItems).toBe(2)
    // One of the two is a podcast episode -- its url is /episode/, not
    // /track/. A client that assumes `url` always contains "/track/" breaks
    // on exactly this fixture.
    expect(playlist.tracks.some((t) => t.url.includes('/episode/'))).toBe(true)
  })
})

describe('docs/examples/notfound.json', () => {
  it('matches the error contract shape', async () => {
    checkErrorBody(await load<ErrorBody>('notfound'), 'not_found')
  })
})

describe('docs/examples/invalid.json', () => {
  it('matches the error contract shape', async () => {
    checkErrorBody(await load<ErrorBody>('invalid'), 'invalid_id')
  })
})

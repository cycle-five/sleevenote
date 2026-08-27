import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { normalizeTrack, normalizeAlbum, normalizePlaylist } from '../src/normalize.js'
import type { Recorded } from '../src/types.js'

async function fixture(name: string): Promise<Recorded[]> {
  return JSON.parse(await readFile(`tests/fixtures/${name}.json`, 'utf8')) as Recorded[]
}

describe('normalizeTrack', () => {
  it('extracts a track with a name and at least one artist', async () => {
    const track = normalizeTrack(await fixture('track'), '0c6xIDDpzE81m2q797ordA')
    expect(track).not.toBeNull()
    expect(track!.name.length).toBeGreaterThan(0)
    expect(track!.artists.length).toBeGreaterThan(0)
    expect(track!.artists[0]!.name.length).toBeGreaterThan(0)
    expect(track!.type).toBe('track')
    expect(track!.url).toContain('0c6xIDDpzE81m2q797ordA')
  })

  it('returns null rather than throwing when the entity is absent', async () => {
    expect(normalizeTrack([], 'nope')).toBeNull()
    expect(normalizeTrack(await fixture('track'), 'a-different-id')).toBeNull()
  })
})

describe('normalizeAlbum', () => {
  it('extracts an album with a name and tracks that each have a name and an artist', async () => {
    const album = normalizeAlbum(await fixture('album'), '6ymZBbRSmzAvoSGmwAFoxm')
    expect(album).not.toBeNull()
    expect(album!.name.length).toBeGreaterThan(0)
    expect(album!.type).toBe('album')
    expect(album!.url).toContain('6ymZBbRSmzAvoSGmwAFoxm')
    expect(album!.tracks.length).toBeGreaterThan(0)
    for (const t of album!.tracks) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.artists.length).toBeGreaterThan(0)
    }
  })

  it('returns null rather than throwing when the entity is absent', async () => {
    expect(normalizeAlbum([], 'nope')).toBeNull()
    expect(normalizeAlbum(await fixture('album'), 'a-different-id')).toBeNull()
  })
})

describe('normalizePlaylist', () => {
  it('extracts every track, each with a usable name and artist', async () => {
    const pl = normalizePlaylist(await fixture('playlist-small'), '37i9dQZF1DXcBWIGoYBM5M')
    expect(pl).not.toBeNull()
    expect(pl!.tracks.length).toBeGreaterThan(0)
    for (const t of pl!.tracks) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.artists.length).toBeGreaterThan(0)
    }
  })

  // The two fields cracktunes actually consumes. If these regress, every
  // downstream search query silently gets worse, so assert them explicitly.
  it('never yields a track with an empty name or no artists', async () => {
    const pl = normalizePlaylist(await fixture('playlist-large'), '37i9dQZF1DX4o1oenSJRJd')
    expect(pl).not.toBeNull()
    const bad = pl!.tracks.filter((t) => !t.name || t.artists.length === 0)
    expect(bad).toEqual([])
  })

  // Guards the defect that blocked Task 1: a scroll that fails to drive the
  // virtualized container yields page one only, which still looks like a
  // perfectly valid playlist. Assert the whole thing came back.
  it('recovers every page, not just the first', async () => {
    const pl = normalizePlaylist(await fixture('playlist-large'), '37i9dQZF1DX4o1oenSJRJd')
    expect(pl!.tracks.length).toBeGreaterThan(100)
  })
})

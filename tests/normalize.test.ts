import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  normalizeTrack,
  normalizeAlbum,
  normalizePlaylist,
  albumItemCount,
  albumTotalCount,
  playlistItemCount,
  playlistTotalCount,
} from '../src/normalize.js'
import type { Recorded } from '../src/types.js'

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v2/query'

/** A `tracksV2.items[]` entry shaped like a real album track item. */
function albumTrackItem(trackId: string, name: string, trackNumber: number, discNumber = 1) {
  return {
    track: {
      name,
      uri: `spotify:track:${trackId}`,
      artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
      duration: { totalMilliseconds: 200_000 },
      trackNumber,
      discNumber,
    },
  }
}

/** The entity-bearing `albumUnion` response: has `uri`, `name`, etc. */
function albumEntityResponse(id: string, totalCount: number, items: unknown[]): Recorded {
  return {
    url: PATHFINDER_URL,
    status: 200,
    body: {
      data: {
        albumUnion: {
          __typename: 'Album',
          name: 'Union Test Album',
          uri: `spotify:album:${id}`,
          artists: { items: [{ uri: 'spotify:artist:a1', profile: { name: 'Album Artist' } }] },
          coverArt: { sources: [{ url: 'https://img.example/album.jpg', width: 640, height: 640 }] },
          tracksV2: { totalCount, items },
        },
      },
    },
  }
}

/**
 * A later `albumUnion` batch: same shape, but no `uri` -- exactly how the
 * real second (and any later) response for a >50-track album arrives, per
 * `docs/captured-shapes.md`'s "Album" pagination findings.
 */
function albumBatchResponse(totalCount: number, items: unknown[]): Recorded {
  return {
    url: PATHFINDER_URL,
    status: 200,
    body: {
      data: {
        albumUnion: {
          __typename: 'Album',
          tracksV2: { totalCount, items },
        },
      },
    },
  }
}

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

  // Regression test for the >50-track pagination bug (see
  // docs/captured-shapes.md's "Album" pagination findings). tracksV2 arrives
  // across multiple responses; only the first carries `uri`. Items are keyed
  // by (discNumber, trackNumber), not concatenated by arrival order, so this
  // also proves overlap/duplication across batches collapses instead of
  // producing a duplicate Track: batch two redundantly repeats trackNumber
  // 50 (the last item of batch one) before continuing with 51..60 -- 61 raw
  // items total, but only 60 distinct positions.
  it('recovers every track across multiple tracksV2 batches, not just the uri-bearing one', () => {
    const id = 'sixtyTrackAlbumId'
    const batchOneItems = Array.from({ length: 50 }, (_, i) =>
      albumTrackItem(`t${i + 1}`, `Track ${i + 1}`, i + 1),
    )
    const batchTwoItems = [
      albumTrackItem('t50-dup', 'Track 50 (duplicate arrival)', 50),
      ...Array.from({ length: 10 }, (_, i) => albumTrackItem(`t${i + 51}`, `Track ${i + 51}`, i + 51)),
    ]
    const recorded = [
      albumEntityResponse(id, 60, batchOneItems),
      albumBatchResponse(60, batchTwoItems),
    ]

    const expectedNames = Array.from({ length: 60 }, (_, i) => `Track ${i + 1}`)
    // Position 50 was recorded twice; the later-arriving write (batch two's
    // duplicate) wins -- same "later write for an already-seen position
    // simply replaces it" rule playlistItemsByIndex documents.
    expectedNames[49] = 'Track 50 (duplicate arrival)'

    const album = normalizeAlbum(recorded, id)
    expect(album).not.toBeNull()
    expect(album!.tracks.length).toBe(60)
    expect(album!.tracks.map((t) => t.name)).toEqual(expectedNames)
    expect(new Set(album!.tracks.map((t) => t.id)).size).toBe(60)
    expect(albumItemCount(recorded, id)).toBe(60)
  })

  // The second batch has no `uri` to match against the entity, so
  // `tracksV2.totalCount` agreeing with the entity's declared total is the
  // only available discriminator (see albumItemsByPosition's doc comment for
  // its limits). A batch that disagrees must not be merged in.
  it('does not merge a tracksV2 batch whose totalCount disagrees with the entity', () => {
    const id = 'mismatchedTotalAlbumId'
    const batchOneItems = Array.from({ length: 50 }, (_, i) =>
      albumTrackItem(`t${i + 1}`, `Track ${i + 1}`, i + 1),
    )
    const strayItems = Array.from({ length: 10 }, (_, i) => albumTrackItem(`s${i + 1}`, `Stray ${i + 1}`, i + 51))
    const recorded = [
      albumEntityResponse(id, 60, batchOneItems),
      // Declares a different total (999) -- e.g. a different album's batch
      // captured in the same recording. Must be rejected, not merged.
      albumBatchResponse(999, strayItems),
    ]

    const album = normalizeAlbum(recorded, id)
    expect(album).not.toBeNull()
    expect(album!.tracks.length).toBe(50)
    expect(album!.tracks.some((t) => t.name.startsWith('Stray'))).toBe(false)
    expect(albumItemCount(recorded, id)).toBe(50)
  })

  // Merging batches must not paper over a genuine gap: this models a scroll
  // that fetched the entity page plus one more batch and then stopped early
  // -- 55 of 60 declared tracks recovered across two batches, not one. This
  // is what extract.ts's completeness check (declared !== seen) still needs
  // to be able to see; albumItemCount is what it reads `seen` from.
  it('still falls short of the declared total when merged batches genuinely miss tracks', () => {
    const id = 'shortfallAlbumId'
    const batchOneItems = Array.from({ length: 50 }, (_, i) =>
      albumTrackItem(`t${i + 1}`, `Track ${i + 1}`, i + 1),
    )
    const batchTwoItems = Array.from({ length: 5 }, (_, i) => albumTrackItem(`t${i + 51}`, `Track ${i + 51}`, i + 51))
    const recorded = [
      albumEntityResponse(id, 60, batchOneItems),
      albumBatchResponse(60, batchTwoItems),
    ]

    expect(albumTotalCount(recorded, id)).toBe(60)
    expect(albumItemCount(recorded, id)).toBe(55)
    expect(albumItemCount(recorded, id)).not.toBe(albumTotalCount(recorded, id))
  })

  // The confirmed real batch shape (docs/captured-shapes.md, four albums up
  // to 150 tracks): batch one caps at 50, and the ENTIRE remainder arrives
  // as a single second batch -- not further 50-item pages. The 60-track
  // tests above happen to have a small, roughly page-sized second batch;
  // this one proves the merge doesn't assume symmetric or capped batch
  // sizes by giving it a 100-item second batch.
  it('recovers all 150 tracks when the second batch is much larger than the first (the confirmed real shape)', () => {
    const id = 'oneFiftyTrackAlbumId'
    const batchOneItems = Array.from({ length: 50 }, (_, i) =>
      albumTrackItem(`t${i + 1}`, `Track ${i + 1}`, i + 1),
    )
    const batchTwoItems = Array.from({ length: 100 }, (_, i) => albumTrackItem(`t${i + 51}`, `Track ${i + 51}`, i + 51))
    const recorded = [
      albumEntityResponse(id, 150, batchOneItems),
      albumBatchResponse(150, batchTwoItems),
    ]

    const album = normalizeAlbum(recorded, id)
    expect(album).not.toBeNull()
    expect(album!.tracks.length).toBe(150)
    expect(album!.tracks.map((t) => t.name)).toEqual(Array.from({ length: 150 }, (_, i) => `Track ${i + 1}`))
    expect(albumItemCount(recorded, id)).toBe(150)
  })

  // Confirmed live against a genuine 2-disc album (78dSB74LrGEdjilKcR3bIW,
  // Shostakovich's "The Golden Age, Op. 22"): disc 1 ran trackNumber 1..17,
  // disc 2 restarted at trackNumber 1..22, discNumber observed as exactly
  // {1, 2}. Keying by trackNumber alone -- as every other test in this file
  // could get away with, since none of them vary discNumber -- would
  // collapse disc 1 track 1 and disc 2 track 1 into one key and silently
  // drop one of them. This is the regression test for that: two tracks that
  // share a trackNumber but differ in discNumber must both survive.
  it('keys disc 2 track 1 separately from disc 1 track 1 on a multi-disc album', () => {
    const id = 'twoDiscAlbumId'
    const items = [
      albumTrackItem('d1t1', 'Disc 1 Track 1', 1, 1),
      albumTrackItem('d1t2', 'Disc 1 Track 2', 2, 1),
      albumTrackItem('d2t1', 'Disc 2 Track 1', 1, 2),
      albumTrackItem('d2t2', 'Disc 2 Track 2', 2, 2),
    ]
    const recorded = [albumEntityResponse(id, 4, items)]

    const album = normalizeAlbum(recorded, id)
    expect(album).not.toBeNull()
    expect(album!.tracks.map((t) => t.name)).toEqual([
      'Disc 1 Track 1',
      'Disc 1 Track 2',
      'Disc 2 Track 1',
      'Disc 2 Track 2',
    ])
    expect(albumItemCount(recorded, id)).toBe(4)
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

// `Recorded[]` reaches the normalizer via `JSON.parse(...) as Recorded[]`
// with no runtime validation, so a capture tool that pushed `null` for a
// response it failed to parse -- or a track item Spotify served with a gap
// in it -- is a realistic input, not an adversarial one. These pin the
// "never throw, missing fields become null" rules with edge cases that
// don't occur in the real fixtures, so nothing else in the suite covers
// them.
describe('robustness against malformed recordings', () => {
  it('does not throw on a null or undefined array entry', () => {
    expect(() => normalizeTrack([null as unknown as Recorded], 'x')).not.toThrow()
    expect(() => normalizeTrack([undefined as unknown as Recorded], 'x')).not.toThrow()
    expect(normalizeTrack([null as unknown as Recorded], 'x')).toBeNull()
    expect(normalizeTrack([undefined as unknown as Recorded], 'x')).toBeNull()

    expect(() => normalizeAlbum([null as unknown as Recorded], 'x')).not.toThrow()
    expect(normalizeAlbum([null as unknown as Recorded], 'x')).toBeNull()

    expect(() => normalizePlaylist([null as unknown as Recorded], 'x')).not.toThrow()
    expect(normalizePlaylist([null as unknown as Recorded], 'x')).toBeNull()
  })

  it('drops malformed items from a playlist track list but keeps the well-formed ones', () => {
    const recorded: Recorded[] = [
      {
        url: 'https://api-partner.spotify.com/pathfinder/v2/query',
        status: 200,
        body: {
          data: {
            playlistV2: {
              __typename: 'Playlist',
              name: 'Malformed Items',
              uri: 'spotify:playlist:playlistid',
              ownerV2: { data: { name: 'Someone' } },
              images: { items: [] },
              content: {
                totalCount: 4,
                pagingInfo: { limit: 25, offset: 0 },
                items: [
                  null,
                  {
                    itemV2: {
                      data: {
                        __typename: 'Track',
                        name: '',
                        uri: 'spotify:track:noname',
                        artists: { items: [{ profile: { name: 'X' }, uri: 'spotify:artist:x' }] },
                        trackDuration: { totalMilliseconds: 1000 },
                      },
                    },
                  },
                  {
                    itemV2: {
                      data: {
                        __typename: 'Track',
                        name: 'No Artists',
                        uri: 'spotify:track:noartists',
                        artists: { items: [] },
                        trackDuration: { totalMilliseconds: 1000 },
                      },
                    },
                  },
                  {
                    itemV2: {
                      data: {
                        __typename: 'Track',
                        name: 'Well Formed',
                        uri: 'spotify:track:wellformed',
                        artists: { items: [{ profile: { name: 'Y' }, uri: 'spotify:artist:y' }] },
                        trackDuration: { totalMilliseconds: 2000 },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]

    const pl = normalizePlaylist(recorded, 'playlistid')
    expect(pl).not.toBeNull()
    expect(pl!.tracks.map((t) => t.name)).toEqual(['Well Formed'])
  })

  it('yields durationMs: null and album: null (not undefined) when those fields are absent', () => {
    const recorded: Recorded[] = [
      {
        url: 'https://api-partner.spotify.com/pathfinder/v2/query',
        status: 200,
        body: {
          data: {
            trackUnion: {
              __typename: 'Track',
              name: 'No Duration Or Album',
              uri: 'spotify:track:sparse',
              firstArtist: { items: [{ profile: { name: 'Z' }, uri: 'spotify:artist:z' }] },
              otherArtists: { items: [] },
              // deliberately no `duration`, no `albumOfTrack`
            },
          },
        },
      },
    ]

    const track = normalizeTrack(recorded, 'sparse')
    expect(track).not.toBeNull()
    expect(track!.durationMs).toBe(null)
    expect(track!.album).toBe(null)
  })
})

// Every other fixture is Spotify editorial content, which is all Tracks. A
// real user's playlist is not: it holds podcast Episodes and LocalTracks
// (files on the user's own machine). This fixture has one Track, one Episode
// and two LocalTracks.
//
// See docs/design-notes.md ("Non-Track playlist items").
describe('normalizePlaylist -- a real user playlist with mixed item kinds', () => {
  const MIXED = '3tlExkExp1aaYcU91Qhp79'

  it('sees every item Spotify declares, including the ones it cannot represent', async () => {
    const recorded = await fixture('playlist-mixed')
    // The completeness check compares these two, NOT tracks.length. If it
    // compared tracks.length this playlist would raise
    // ExtractionIncompleteError on every request and, because that error is
    // never cached, fail forever.
    expect(playlistTotalCount(recorded, MIXED)).toBe(4)
    expect(playlistItemCount(recorded, MIXED)).toBe(4)
  })

  it('admits the Episode as a track, attributed to its show', async () => {
    const playlist = (await normalizePlaylist(await fixture('playlist-mixed'), MIXED))!
    const episode = playlist.tracks.find((t) => t.name === '178: Ubiquiti')
    expect(episode).toBeDefined()
    expect(episode!.artists.map((a) => a.name)).toEqual(['Darknet Diaries'])
    // /episode/, not /track/: the id is an episode id and a /track/ URL built
    // from it would 404.
    expect(episode!.url).toBe('https://open.spotify.com/episode/6CQAC1k7sUVk8FQsXABlRU')
    expect(episode!.durationMs).toBeGreaterThan(0)
  })

  it('counts the LocalTracks it cannot represent instead of dropping them silently', async () => {
    const playlist = (await normalizePlaylist(await fixture('playlist-mixed'), MIXED))!
    expect(playlist.name).toBe('Song, Podcast, Local file')
    expect(playlist.tracks).toHaveLength(2)
    // The two local files. Without this a consumer could not tell a
    // two-track playlist from a four-item one it could only half resolve.
    expect(playlist.unresolvedItems).toBe(2)
    // tracks + unresolved must account for every item seen.
    expect(playlist.tracks.length + playlist.unresolvedItems).toBe(
      playlistItemCount(await fixture('playlist-mixed'), MIXED),
    )
  })

  it('cannot represent a LocalTrack because its uri carries no id', async () => {
    const recorded = await fixture('playlist-mixed')
    const local = findItemData(recorded, 'LocalTrack')
    // `spotify:local:<artist>:<album>:<title>:<seconds>` -- the id position is
    // empty, so a LocalTrack has no Spotify identity to resolve. Observed on
    // this account: the artist and album positions are empty too, even for a
    // file whose owner had tagged it.
    expect(local!['uri']).toMatch(/^spotify:local:/)
    expect(String(local!['uri']).split(':')[2]).toBe('')
    expect(local!['artistName']).toBe('')
  })
})

/** First `itemV2.data` in the recorded stream whose `__typename` matches. */
function findItemData(recorded: Recorded[], typename: string): Record<string, unknown> | null {
  for (const r of recorded as unknown as Record<string, any>[]) {
    const items = r?.['body']?.data?.playlistV2?.content?.items
    if (!Array.isArray(items)) continue
    for (const it of items) {
      const data = it?.itemV2?.data
      if (data?.__typename === typename) return data as Record<string, unknown>
    }
  }
  return null
}

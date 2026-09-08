import { describe, it, expect } from 'vitest'
import { tracksToCache } from '../src/fanout.js'

function playlistTrack(id: string, name: string) {
  return {
    id,
    type: 'track',
    name,
    artists: [{ name: 'Someone', id: null }],
    album: { name: "Oh Shit I'm Feeling It", id: 'alb1', image: null },
    durationMs: 1,
    url: `https://open.spotify.com/track/${id}`,
  }
}

// Shaped like normalize.ts's trackFromEpisode: type 'track', a real album
// (the show), but a /episode/ url rather than /track/.
function episodeTrack(id: string) {
  return {
    id,
    type: 'track',
    name: 'Darknet Diaries -- 178: Ubiquiti',
    artists: [{ name: 'Darknet Diaries', id: null }],
    album: { name: 'Darknet Diaries', id: null, image: null },
    durationMs: 1,
    url: `https://open.spotify.com/episode/${id}`,
  }
}

function playlistWithOneTrack() {
  return {
    id: 'pl1',
    type: 'playlist',
    name: 'A Playlist',
    owner: 'someone',
    image: null,
    url: 'https://open.spotify.com/playlist/pl1',
    tracks: [playlistTrack('t1', 'A Song')],
    unresolvedItems: 0,
    declaredItems: 1,
    complete: true,
  } as any
}

function playlistWithSongAndEpisode() {
  return {
    ...playlistWithOneTrack(),
    tracks: [playlistTrack('t1', 'A Song'), episodeTrack('e1')],
    declaredItems: 2,
  } as any
}

describe('tracksToCache', () => {
  it('gives an album track the parent album it was listed without', () => {
    // `Track.album` is null on every track inside an Album, deliberately --
    // repeating the parent across 60 entries is noise. Cached verbatim that
    // is a track record that has lost its album, so it is filled in here.
    const album = {
      type: 'album', id: 'al1', name: '60 Original Hits', image: 'http://art',
      artists: [{ name: 'Elvis', id: 'a1' }], url: 'u', unresolvedItems: 0,
      declaredItems: 1, complete: true,
      tracks: [{ id: 't1', type: 'track', name: 'King Creole', artists: [{ name: 'Elvis', id: 'a1' }],
                 album: null, durationMs: 1, url: 'https://open.spotify.com/track/t1' }],
    } as any
    const [track] = tracksToCache(album)
    expect(track!.album).toEqual({ name: '60 Original Hits', id: 'al1', image: 'http://art' })
  })

  it('leaves a playlist track alone, because it already carries its album', () => {
    const [track] = tracksToCache(playlistWithOneTrack())
    expect(track!.album?.name).toBe('Oh Shit I\'m Feeling It')
  })

  it('skips podcast episodes, which are not tracks', () => {
    // A playlist can hold them. Their url is /episode/<id>, they are not a
    // valid /v1/track/:id response, and caching one under a track key would
    // answer a future track lookup with something that is not a track.
    expect(tracksToCache(playlistWithSongAndEpisode())).toHaveLength(1)
  })
})

export type Artist = { name: string; id: string | null }

export type Track = {
  id: string
  type: 'track'
  name: string
  artists: Artist[]
  album: { name: string; id: string | null; image: string | null } | null
  durationMs: number | null
  url: string
}

export type Album = {
  id: string
  type: 'album'
  name: string
  artists: Artist[]
  image: string | null
  url: string
  tracks: Track[]
  // Items Spotify listed that could not be represented as a Track. Without
  // this the drop is silent and a consumer cannot tell a short collection
  // from a truncated one. Compare against `tracks.length`.
  unresolvedItems: number
}

export type Playlist = {
  id: string
  type: 'playlist'
  name: string
  owner: string | null
  image: string | null
  url: string
  tracks: Track[]
  // Items Spotify listed that could not be represented as a Track -- local
  // files, mostly. Without this the drop is silent and a consumer cannot tell
  // a short playlist from one whose contents it could not resolve.
  unresolvedItems: number
}

export type Recorded = { url: string; status: number; body: unknown }

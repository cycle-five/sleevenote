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
}

export type Playlist = {
  id: string
  type: 'playlist'
  name: string
  owner: string | null
  image: string | null
  url: string
  tracks: Track[]
}

export type Recorded = { url: string; status: number; body: unknown }

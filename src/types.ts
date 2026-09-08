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
  // Spotify's own declared total, or null when the page declared none.
  // Evidence for `complete`; kept so a consumer can say "25 of 50" rather
  // than only "incomplete".
  declaredItems: number | null
  // Whether every declared item was seen. Derivable from the fields above,
  // and sent anyway so the rule -- including "declared nothing, so we cannot
  // claim a shortfall" -- lives in one place rather than in each consumer.
  complete: boolean
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
  // Spotify's own declared total, or null when the page declared none.
  // Evidence for `complete`; kept so a consumer can say "25 of 50" rather
  // than only "incomplete".
  declaredItems: number | null
  // Whether every declared item was seen. Derivable from the fields above,
  // and sent anyway so the rule -- including "declared nothing, so we cannot
  // claim a shortfall" -- lives in one place rather than in each consumer.
  complete: boolean
}

export type Recorded = { url: string; status: number; body: unknown }

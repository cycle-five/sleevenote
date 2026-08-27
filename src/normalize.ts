import type { Album, Artist, Playlist, Recorded, Track } from './types.js'

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v2/query'

// --- generic helpers -------------------------------------------------------

/** Narrow an arbitrary JSON value to a plain object, otherwise null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** Every recorded pathfinder response's `data` object, in recording order. */
function pathfinderData(recorded: Recorded[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of recorded) {
    // `recorded` reaches us via `JSON.parse(...) as Recorded[]` with no
    // runtime validation, so a malformed entry (null, a non-object) is a
    // realistic input, not just an adversarial one -- never throw on it.
    const entry = asRecord(raw)
    if (!entry) continue
    if (asString(entry['url']) !== PATHFINDER_URL) continue
    const body = asRecord(entry['body'])
    const data = body ? asRecord(body['data']) : null
    if (data) out.push(data)
  }
  return out
}

/**
 * Parse the id segment out of a Spotify URI, e.g.
 * `spotify:track:0c6xIDDpzE81m2q797ordA` -> `0c6xIDDpzE81m2q797ordA`.
 * This is the uniform, reliable way to get an id -- `.id` fields are
 * inconsistently present across contexts, but `.uri` always is.
 */
function idFromUri(uri: unknown): string | null {
  const s = asString(uri)
  if (!s) return null
  const parts = s.split(':')
  const id = parts[2]
  return id && id.length > 0 ? id : null
}

/**
 * Pick the best image URL out of a `coverArt`/`images`-style sources array:
 * `{ sources: [{ url, width, height }] }`. Rule: the entry with the largest
 * `width`; if `width` is absent (null) on every entry, take the last entry.
 */
function bestImage(sourcesHolder: unknown): string | null {
  const holder = asRecord(sourcesHolder)
  const sources = holder ? asArray(holder['sources']) : null
  if (!sources || sources.length === 0) return null

  const entries: { url: string; width: number | null }[] = []
  for (const raw of sources) {
    const rec = asRecord(raw)
    if (!rec) continue
    const url = asString(rec['url'])
    if (!url) continue
    entries.push({ url, width: asNumber(rec['width']) })
  }
  if (entries.length === 0) return null

  // Largest width wins. If every entry's width is null, fall back to the
  // last entry in the array.
  let best: { url: string; width: number | null } | null = null
  for (const entry of entries) {
    if (entry.width === null) continue
    if (best === null || best.width === null || entry.width > best.width) best = entry
  }
  return (best ?? entries[entries.length - 1])!.url
}

function durationMs(durationHolder: unknown): number | null {
  const rec = asRecord(durationHolder)
  if (!rec) return null
  return asNumber(rec['totalMilliseconds'])
}

/** `{ items: [{ profile: { name }, uri | id }] }` -> Artist[] */
function artistsFromItems(itemsHolder: unknown): Artist[] {
  const holder = asRecord(itemsHolder)
  const items = holder ? asArray(holder['items']) : null
  if (!items) return []
  const artists: Artist[] = []
  for (const raw of items) {
    const rec = asRecord(raw)
    if (!rec) continue
    const profile = asRecord(rec['profile'])
    const name = profile ? asString(profile['name']) : null
    if (!name) continue
    artists.push({ name, id: idFromUri(rec['uri']) })
  }
  return artists
}

/** Build a Track from an `albumOfTrack`-shaped holder (track/playlist contexts). */
function albumRefFrom(albumHolder: unknown): Track['album'] {
  const rec = asRecord(albumHolder)
  if (!rec) return null
  const name = asString(rec['name'])
  if (!name) return null
  return {
    name,
    id: idFromUri(rec['uri']),
    image: bestImage(rec['coverArt']),
  }
}

/** Build a Track from a track-shaped node, given the field name for duration. */
function trackFromNode(node: unknown, durationField: 'duration' | 'trackDuration'): Track | null {
  const rec = asRecord(node)
  if (!rec) return null

  const name = asString(rec['name'])
  if (!name) return null

  const id = idFromUri(rec['uri'])
  if (!id) return null

  const artists = artistsFromItems(rec['artists'])
  if (artists.length === 0) return null

  return {
    id,
    type: 'track',
    name,
    artists,
    album: albumRefFrom(rec['albumOfTrack']),
    durationMs: durationMs(rec[durationField]),
    url: `https://open.spotify.com/track/${id}`,
  }
}

// --- track -------------------------------------------------------------

export function normalizeTrack(recorded: Recorded[], id: string): Track | null {
  for (const data of pathfinderData(recorded)) {
    const trackUnion = asRecord(data['trackUnion'])
    if (!trackUnion) continue
    if (asString(trackUnion['__typename']) !== 'Track') continue
    if (idFromUri(trackUnion['uri']) !== id) continue

    const name = asString(trackUnion['name'])
    if (!name) return null

    const artists = [
      ...artistsFromItems(trackUnion['firstArtist']),
      ...artistsFromItems(trackUnion['otherArtists']),
    ]
    if (artists.length === 0) return null

    return {
      id,
      type: 'track',
      name,
      artists,
      album: albumRefFrom(trackUnion['albumOfTrack']),
      durationMs: durationMs(trackUnion['duration']),
      url: `https://open.spotify.com/track/${id}`,
    }
  }
  return null
}

// --- album ---------------------------------------------------------------

export function normalizeAlbum(recorded: Recorded[], id: string): Album | null {
  for (const data of pathfinderData(recorded)) {
    const albumUnion = asRecord(data['albumUnion'])
    if (!albumUnion) continue
    if (asString(albumUnion['__typename']) !== 'Album') continue
    // Reject the merch-widget response, which also uses this key but has no
    // tracksV2 field.
    const tracksV2 = asRecord(albumUnion['tracksV2'])
    if (!tracksV2) continue
    if (idFromUri(albumUnion['uri']) !== id) continue

    const name = asString(albumUnion['name'])
    if (!name) return null

    const items = asArray(tracksV2['items']) ?? []
    const tracks: Track[] = []
    for (const raw of items) {
      const rec = asRecord(raw)
      const trackNode = rec ? rec['track'] : null
      const track = trackFromNode(trackNode, 'duration')
      if (track) tracks.push(track)
    }

    return {
      id,
      type: 'album',
      name,
      artists: artistsFromItems(albumUnion['artists']),
      image: bestImage(albumUnion['coverArt']),
      url: `https://open.spotify.com/album/${id}`,
      tracks,
    }
  }
  return null
}

// --- playlist --------------------------------------------------------------

export function normalizePlaylist(recorded: Recorded[], id: string): Playlist | null {
  const targetUri = `spotify:playlist:${id}`
  const candidates = pathfinderData(recorded)
    .map((data) => asRecord(data['playlistV2']))
    .filter((p): p is Record<string, unknown> => p !== null)

  // Entity-bearing response: the one where `name` is present and `uri`
  // matches the requested id. NOT the first `__typename === "Playlist"` --
  // a permissions-only fragment for this same playlist, with no name/uri/
  // content, is fired first in every fixture.
  const entity = candidates.find(
    (p) => asString(p['name']) !== null && asString(p['uri']) === targetUri,
  )
  if (!entity) return null

  const name = asString(entity['name'])
  if (!name) return null

  const ownerV2 = asRecord(entity['ownerV2'])
  const ownerData = ownerV2 ? asRecord(ownerV2['data']) : null
  const owner = ownerData ? asString(ownerData['name']) : null

  const imagesHolder = asRecord(entity['images'])
  const imageItems = imagesHolder ? asArray(imagesHolder['items']) : null
  const firstImage = imageItems && imageItems.length > 0 ? imageItems[0] : null
  const image = bestImage(firstImage)

  // Page-bearing responses: every response with a `content.pagingInfo`,
  // independent of whether name/uri are set. The entity response is itself
  // page one; pages past the first carry no uri, so uri cannot be used to
  // find them. Concatenate items in pagingInfo.offset order.
  const pages: { offset: number; items: unknown[] }[] = []
  for (const p of candidates) {
    const content = asRecord(p['content'])
    if (!content) continue
    const pagingInfo = asRecord(content['pagingInfo'])
    if (!pagingInfo) continue
    const offset = asNumber(pagingInfo['offset']) ?? 0
    const items = asArray(content['items']) ?? []
    pages.push({ offset, items })
  }
  pages.sort((a, b) => a.offset - b.offset)

  const tracks: Track[] = []
  for (const page of pages) {
    for (const raw of page.items) {
      const rec = asRecord(raw)
      const itemV2 = rec ? asRecord(rec['itemV2']) : null
      const trackNode = itemV2 ? itemV2['data'] : null
      const track = trackFromNode(trackNode, 'trackDuration')
      if (track) tracks.push(track)
    }
  }

  return {
    id,
    type: 'playlist',
    name,
    owner,
    image,
    url: `https://open.spotify.com/playlist/${id}`,
    tracks,
  }
}

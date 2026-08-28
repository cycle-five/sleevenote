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
    // `recorded` arrives unvalidated, so malformed entries are realistic
    // input, not adversarial. Never throw on them.
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
 * `spotify:track:0c6xIDD...` -> `0c6xIDD...`. Uses `.uri` because `.id` is
 * inconsistently present across contexts and `.uri` always is.
 */
function idFromUri(uri: unknown): string | null {
  const s = asString(uri)
  if (!s) return null
  const parts = s.split(':')
  const id = parts[2]
  return id && id.length > 0 ? id : null
}

/**
 * Best image from `{ sources: [{ url, width, height }] }`: largest `width`,
 * falling back to the last entry when every `width` is null.
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

/**
 * The one `data.albumUnion` that is this album -- not the merch-widget
 * response sharing the key, not a different album. Factored out so
 * `albumTotalCount` reads its total off the same entity the tracks come from.
 */
function findAlbumUnion(recorded: Recorded[], id: string): Record<string, unknown> | null {
  for (const data of pathfinderData(recorded)) {
    const albumUnion = asRecord(data['albumUnion'])
    if (!albumUnion) continue
    if (asString(albumUnion['__typename']) !== 'Album') continue
    // Reject the merch-widget response, which also uses this key but has no
    // tracksV2 field.
    const tracksV2 = asRecord(albumUnion['tracksV2'])
    if (!tracksV2) continue
    if (idFromUri(albumUnion['uri']) !== id) continue
    return albumUnion
  }
  return null
}

export function normalizeAlbum(recorded: Recorded[], id: string): Album | null {
  const albumUnion = findAlbumUnion(recorded, id)
  if (!albumUnion) return null

  const name = asString(albumUnion['name'])
  if (!name) return null

  const tracks: Track[] = []
  for (const raw of albumItemsByPosition(recorded, id)) {
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

/**
 * The album's declared track count. Compare against `albumItemCount`, never
 * against `normalizeAlbum(...).tracks.length`.
 */
export function albumTotalCount(recorded: Recorded[], id: string): number | null {
  const albumUnion = findAlbumUnion(recorded, id)
  if (!albumUnion) return null
  const tracksV2 = asRecord(albumUnion['tracksV2'])
  return tracksV2 ? asNumber(tracksV2['totalCount']) : null
}

/**
 * Every `albumUnion.tracksV2` batch for this album. Later batches carry no
 * `uri` and albums have no `pagingInfo`, so a matching `totalCount` is the
 * only discriminator the shape offers -- a real filter, but not a guarantee.
 * See docs/design-notes.md ("Album batches").
 */
function albumTrackBatches(recorded: Recorded[], id: string): Record<string, unknown>[] {
  const declaredTotal = albumTotalCount(recorded, id)
  if (declaredTotal === null) return []
  const batches: Record<string, unknown>[] = []
  for (const data of pathfinderData(recorded)) {
    const albumUnion = asRecord(data['albumUnion'])
    if (!albumUnion) continue
    if (asString(albumUnion['__typename']) !== 'Album') continue
    const tracksV2 = asRecord(albumUnion['tracksV2'])
    if (!tracksV2) continue
    if (asNumber(tracksV2['totalCount']) !== declaredTotal) continue
    batches.push(tracksV2)
  }
  return batches
}

/**
 * Every track-item across every batch, deduplicated by
 * `(discNumber, trackNumber)` -- Spotify's own absolute position, playing the
 * role `pagingInfo.offset` plays for a playlist. Keying by position rather
 * than arrival order collapses an overlapping batch instead of emitting a
 * duplicate Track.
 *
 * `discNumber` must be part of the key, not a tiebreaker: `trackNumber`
 * restarts at 1 on each disc. See docs/design-notes.md ("Album batches").
 */
function albumItemsByPosition(recorded: Recorded[], id: string): unknown[] {
  const byKey = new Map<string, { sortKey: number; raw: unknown }>()
  let arrivalIndex = 0
  for (const tracksV2 of albumTrackBatches(recorded, id)) {
    const items = asArray(tracksV2['items']) ?? []
    for (const raw of items) {
      const idx = arrivalIndex++
      const rec = asRecord(raw)
      const track = rec ? asRecord(rec['track']) : null
      const trackNumber = track ? asNumber(track['trackNumber']) : null
      const discNumber = track ? asNumber(track['discNumber']) : null
      if (trackNumber !== null) {
        byKey.set(`${discNumber ?? 1}:${trackNumber}`, {
          sortKey: (discNumber ?? 1) * 1_000_000 + trackNumber,
          raw,
        })
      } else {
        // No genuine position. A unique fallback key keeps the item counted
        // and returned rather than silently overwritten, sorted after every
        // properly-keyed entry.
        byKey.set(`raw:${idx}`, { sortKey: 1_000_000_000_000 + idx, raw })
      }
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((entry) => entry.raw)
}

/**
 * Distinct track positions recovered, BEFORE `normalizeAlbum` drops malformed
 * ones. Completeness is about what Spotify declared versus what we saw, not
 * about what survived validation -- see docs/design-notes.md ("Completeness").
 */
export function albumItemCount(recorded: Recorded[], id: string): number | null {
  const albumUnion = findAlbumUnion(recorded, id)
  if (!albumUnion) return null
  return albumItemsByPosition(recorded, id).length
}

// --- playlist --------------------------------------------------------------

/** Every `data.playlistV2` recorded, decoys and permission fragments included. */
function playlistCandidates(recorded: Recorded[]): Record<string, unknown>[] {
  return pathfinderData(recorded)
    .map((data) => asRecord(data['playlistV2']))
    .filter((p): p is Record<string, unknown> => p !== null)
}

/**
 * The one entity-bearing response: `name` present and `uri` matching the id.
 * NOT the first `__typename === "Playlist"` -- a permissions-only fragment
 * for the same playlist fires first in every fixture.
 */
function findPlaylistEntity(recorded: Recorded[], id: string): Record<string, unknown> | null {
  const targetUri = `spotify:playlist:${id}`
  return (
    playlistCandidates(recorded).find(
      (p) => asString(p['name']) !== null && asString(p['uri']) === targetUri,
    ) ?? null
  )
}

/**
 * Every track-item across every page-bearing response, deduplicated by
 * absolute list position (`offset + i`) rather than concatenated. A repeated
 * or overlapping page -- the likeliest product of a misbehaving scroll --
 * becomes a harmless overwrite instead of a duplicate Track.
 *
 * "Page-bearing" means `pagingInfo` is present; pages past the first carry no
 * `uri`, so `uri` cannot be used to find them.
 */
function playlistItemsByIndex(recorded: Recorded[]): unknown[] {
  const byIndex = new Map<number, unknown>()
  for (const p of playlistCandidates(recorded)) {
    const content = asRecord(p['content'])
    if (!content) continue
    const pagingInfo = asRecord(content['pagingInfo'])
    if (!pagingInfo) continue
    const offset = asNumber(pagingInfo['offset']) ?? 0
    const items = asArray(content['items']) ?? []
    items.forEach((item, i) => {
      byIndex.set(offset + i, item)
    })
  }
  return Array.from(byIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, item]) => item)
}

export function normalizePlaylist(recorded: Recorded[], id: string): Playlist | null {
  const entity = findPlaylistEntity(recorded, id)
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

  const tracks: Track[] = []
  for (const raw of playlistItemsByIndex(recorded)) {
    const rec = asRecord(raw)
    const itemV2 = rec ? asRecord(rec['itemV2']) : null
    const trackNode = itemV2 ? itemV2['data'] : null
    const track = trackFromNode(trackNode, 'trackDuration')
    if (track) tracks.push(track)
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

/**
 * The playlist's declared track count. Compare against `playlistItemCount`,
 * never against `normalizePlaylist(...).tracks.length` -- a truncated
 * playlist looks entirely valid.
 */
export function playlistTotalCount(recorded: Recorded[], id: string): number | null {
  const entity = findPlaylistEntity(recorded, id)
  if (!entity) return null
  const content = asRecord(entity['content'])
  return content ? asNumber(content['totalCount']) : null
}

/**
 * Distinct positions covered, BEFORE `normalizePlaylist` drops malformed ones.
 * Not a sum of `items.length` (an overlapping page would inflate it) and not a
 * count of distinct URIs (a playlist may legitimately repeat a track).
 * See docs/design-notes.md ("Completeness").
 */
export function playlistItemCount(recorded: Recorded[], id: string): number | null {
  const entity = findPlaylistEntity(recorded, id)
  if (!entity) return null
  return playlistItemsByIndex(recorded).length
}

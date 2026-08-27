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

/**
 * The one `data.albumUnion` that is this album (not the merch-widget
 * response sharing the same key, not a different album), by the same rules
 * `normalizeAlbum` uses. Factored out so `albumTotalCount` can read
 * `tracksV2.totalCount` off the same entity `normalizeAlbum` reads its
 * tracks from, without re-deriving "which response is the real one" a
 * second time.
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

  const tracksV2 = asRecord(albumUnion['tracksV2'])
  const items = tracksV2 ? (asArray(tracksV2['items']) ?? []) : []
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

/**
 * The album's declared track count (`tracksV2.totalCount`). A caller
 * compares this against `albumItemCount` -- NOT against
 * `normalizeAlbum(...).tracks.length` -- to detect a partial recovery.
 * Returns `null` if the entity itself can't be found, or if `totalCount` is
 * absent/non-numeric.
 */
export function albumTotalCount(recorded: Recorded[], id: string): number | null {
  const albumUnion = findAlbumUnion(recorded, id)
  if (!albumUnion) return null
  const tracksV2 = asRecord(albumUnion['tracksV2'])
  return tracksV2 ? asNumber(tracksV2['totalCount']) : null
}

/**
 * The number of raw track-item entries actually present in `tracksV2.items`
 * for this album -- BEFORE `normalizeAlbum` drops malformed ones (no name,
 * no artists; see `trackFromNode`). Deliberately not the same thing as
 * `normalizeAlbum(...).tracks.length`: a track dropped for being malformed
 * is Task 2's validation rule doing its job (a nameless/artist-less track is
 * useless to a search-query consumer), not a sign that a page was missed.
 * Completeness is about whether we saw everything Spotify declared, not
 * about how much of what we saw survived validation -- compare THIS against
 * `albumTotalCount` to detect the former without being fooled by the
 * latter. Returns `null` only if the entity itself can't be found (mirrors
 * `albumTotalCount`); returns `0` if the entity has no `items` array at all.
 *
 * Unlike `playlistItemCount`, this is a plain array length, not a union of
 * ranges: `findAlbumUnion` (like `normalizeAlbum`) only ever reads
 * `tracksV2.items` off a single response -- there is no pagination for
 * albums per `docs/captured-shapes.md`, so there is nothing to sum or
 * duplicate across multiple pages in the first place. If a duplicate copy
 * of the same album response were ever recorded, `findAlbumUnion` returning
 * the first match (not all of them) means it's simply never read twice.
 */
export function albumItemCount(recorded: Recorded[], id: string): number | null {
  const albumUnion = findAlbumUnion(recorded, id)
  if (!albumUnion) return null
  const tracksV2 = asRecord(albumUnion['tracksV2'])
  const items = tracksV2 ? asArray(tracksV2['items']) : null
  return items ? items.length : 0
}

// --- playlist --------------------------------------------------------------

/**
 * Every `data.playlistV2` recorded, decoys and permission fragments
 * included -- the raw candidate set both `findPlaylistEntity` and
 * `normalizePlaylist`'s page-gathering loop filter from.
 */
function playlistCandidates(recorded: Recorded[]): Record<string, unknown>[] {
  return pathfinderData(recorded)
    .map((data) => asRecord(data['playlistV2']))
    .filter((p): p is Record<string, unknown> => p !== null)
}

/**
 * The one entity-bearing `playlistV2` response: `name` present and `uri`
 * matching the requested id. NOT the first `__typename === "Playlist"` -- a
 * permissions-only fragment for this same playlist, with no name/uri/
 * content, is fired first in every fixture. Factored out so
 * `playlistTotalCount` can read `content.totalCount` off the same response
 * `normalizePlaylist` reads `name`/`owner`/`image` from, rather than
 * re-deriving the discriminator.
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
 * Every page-bearing response's raw `content.items` array, unsorted --
 * "page-bearing" meaning `content.pagingInfo` is present, independent of
 * whether `name`/`uri` are also set (the entity response is itself page
 * one; pages past the first carry no uri, so uri can't be used to find
 * them). Factored out so `playlistItemCount` can count the same raw items
 * `normalizePlaylist` sorts and converts, without re-deriving which
 * responses are pages.
 */
function playlistPages(recorded: Recorded[]): { offset: number; items: unknown[] }[] {
  const pages: { offset: number; items: unknown[] }[] = []
  for (const p of playlistCandidates(recorded)) {
    const content = asRecord(p['content'])
    if (!content) continue
    const pagingInfo = asRecord(content['pagingInfo'])
    if (!pagingInfo) continue
    const offset = asNumber(pagingInfo['offset']) ?? 0
    const items = asArray(content['items']) ?? []
    pages.push({ offset, items })
  }
  return pages
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

  // Concatenate items in pagingInfo.offset order.
  const pages = playlistPages(recorded)
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

/**
 * The playlist's declared track count (`content.totalCount`, read off the
 * entity-bearing response). A caller compares this against
 * `playlistItemCount` -- NOT against `normalizePlaylist(...).tracks.length`
 * -- to detect a partial scroll recovery: the exact failure mode that
 * silently truncated a playlist during Task 1, because a truncated playlist
 * still looks like a completely valid one. Returns `null` if the entity
 * itself can't be found, or if `totalCount` is absent/non-numeric.
 */
export function playlistTotalCount(recorded: Recorded[], id: string): number | null {
  const entity = findPlaylistEntity(recorded, id)
  if (!entity) return null
  const content = asRecord(entity['content'])
  return content ? asNumber(content['totalCount']) : null
}

/**
 * The total length of the union of `[offset, offset + length)` ranges in
 * `intervals`, collapsing duplicate and overlapping ranges instead of
 * summing their lengths. Summing would let a page recorded twice, or two
 * overlapping page windows, inflate the count past what was actually
 * covered -- and a misbehaving scroll (the exact thing `playlistItemCount`
 * exists to catch) is the most plausible source of a duplicated or
 * overlapping fetch, so summing is weakest precisely where this check needs
 * to be strongest. Zero-length intervals are dropped; they cover nothing
 * and would otherwise need special-casing in the merge below.
 */
function unionCoverage(intervals: { offset: number; length: number }[]): number {
  const sorted = intervals
    .filter((iv) => iv.length > 0)
    .map((iv) => ({ start: iv.offset, end: iv.offset + iv.length }))
    .sort((a, b) => a.start - b.start)

  let total = 0
  let runStart: number | null = null
  let runEnd = 0
  for (const iv of sorted) {
    if (runStart === null) {
      runStart = iv.start
      runEnd = iv.end
    } else if (iv.start > runEnd) {
      // A genuine gap: close out the run so far and start a new one.
      total += runEnd - runStart
      runStart = iv.start
      runEnd = iv.end
    } else if (iv.end > runEnd) {
      // Overlaps (or exactly abuts) the current run -- extend it.
      runEnd = iv.end
    }
    // Else: iv is entirely contained in the current run (a duplicate or a
    // strict subset) -- it adds no new coverage.
  }
  if (runStart !== null) total += runEnd - runStart
  return total
}

/**
 * The number of *distinct* track-item positions actually covered across
 * every page-bearing response for this playlist -- BEFORE
 * `normalizePlaylist` drops malformed ones (no name, no artists; see
 * `trackFromNode`). Deliberately not the same thing as
 * `normalizePlaylist(...).tracks.length`: a track dropped for being
 * malformed is Task 2's validation rule doing its job (a nameless/
 * artist-less track is useless to a search-query consumer), not a sign that
 * a page went unfetched. Completeness is about pagination coverage -- did
 * we see everything Spotify declared -- not about how much of what we saw
 * survived validation; compare THIS against `playlistTotalCount` to detect
 * the former without being fooled by the latter.
 *
 * Deliberately the size of the UNION of each page's `[offset, offset +
 * items.length)` range, not the sum of `items.length` across pages: summing
 * lets a duplicated or overlapping page inflate the count until it matches
 * the declared total even though real positions were never covered -- and
 * NOT a count of distinct track URIs either, since a playlist may
 * legitimately contain the same track twice, which URI-distinctness would
 * wrongly undercount as missing. Returns `null` only if the entity itself
 * can't be found (mirrors `playlistTotalCount`).
 */
export function playlistItemCount(recorded: Recorded[], id: string): number | null {
  const entity = findPlaylistEntity(recorded, id)
  if (!entity) return null
  const intervals = playlistPages(recorded).map((page) => ({ offset: page.offset, length: page.items.length }))
  return unionCoverage(intervals)
}

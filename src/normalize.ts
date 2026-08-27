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
 * Every `albumUnion.tracksV2` batch recorded for this album, in recording
 * order -- the raw candidate set `albumItemsByPosition` merges track items
 * out of.
 *
 * A >50-track album splits `tracksV2.items` across multiple responses (see
 * docs/captured-shapes.md's "Album" pagination findings), and only the
 * first of those also happens to be the entity-bearing response
 * `findAlbumUnion` returns -- later batches carry no `uri` at all, so
 * uri-matching (which correctly picks out the *entity*, above) can't also
 * be used to find every *batch*. There is likewise no `pagingInfo` on an
 * album batch the way there is on a playlist page, so `playlistItemsByIndex`'s
 * "page-bearing" filter has no album equivalent either.
 *
 * `tracksV2.totalCount` matching the entity's declared total is the only
 * discriminator the recorded shape actually offers here. It is a real
 * filter -- it rejects a differently-sized album's batch outright -- but it
 * is NOT a guarantee: two different albums that happen to declare the same
 * track count, captured in the same recording, would be indistinguishable
 * by this check alone. No stronger per-batch signal (an album id, a batch
 * index) has been observed in the wild to discriminate on instead.
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
 * Every track-item across every `tracksV2` batch for this album,
 * deduplicated by `(discNumber, trackNumber)` and returned in that order --
 * the album counterpart of `playlistItemsByIndex`.
 *
 * An early pass at this fix searched the recorded shape for something
 * `pagingInfo`-like, found nothing (albums genuinely have no such field),
 * and concluded there was no positional signal at all -- proposing
 * concatenation in arrival order instead. That's wrong: every
 * `tracksV2.items[].track` entry carries its own `discNumber` and
 * `trackNumber`, Spotify's own absolute position for the item, which serves
 * the same role `pagingInfo.offset` serves for a playlist. Keying by that
 * pair -- not arrival order -- is exact rather than inferred,
 * order-independent, and collapses a duplicate/overlapping batch into one
 * entry instead of producing a duplicate `Track`, for the same reasons
 * `playlistItemsByIndex`'s doc comment gives for keying by absolute index.
 *
 * A raw item missing `trackNumber` (a malformed/adversarial recording --
 * every real album item observed carries one) has no genuine position to
 * key by. Rather than collapse into, and get silently overwritten by,
 * whichever other trackNumber-less item happens to key the same, it gets an
 * always-unique fallback key derived from arrival order, so it's still
 * counted and returned -- matching this file's "never throw, never
 * silently drop" rule for malformed input -- just without a defined
 * position relative to the properly-keyed entries.
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
        // No genuine position -- see doc comment above. This sort key is
        // well above any real (discNumber, trackNumber) pair could produce,
        // so these entries sort after every properly-keyed one and among
        // themselves preserve arrival order.
        byKey.set(`raw:${idx}`, { sortKey: 1_000_000_000_000 + idx, raw })
      }
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((entry) => entry.raw)
}

/**
 * The number of distinct track positions actually recovered across every
 * `tracksV2` batch for this album -- BEFORE `normalizeAlbum` drops malformed
 * ones (no name, no artists; see `trackFromNode`). Deliberately not the same
 * thing as `normalizeAlbum(...).tracks.length`: a track dropped for being
 * malformed is Task 2's validation rule doing its job (a nameless/
 * artist-less track is useless to a search-query consumer), not a sign that
 * a batch was missed. Completeness is about whether we saw everything
 * Spotify declared, not about how much of what we saw survived validation --
 * compare THIS against `albumTotalCount` to detect the former without being
 * fooled by the latter. Returns `null` only if the entity itself can't be
 * found (mirrors `albumTotalCount`).
 *
 * This is simply the size of `albumItemsByPosition`'s deduplicated result --
 * both it and `normalizeAlbum` build from that single source, so the count
 * and the track list can never disagree about how many items were seen, the
 * same property `playlistItemCount`/`normalizePlaylist` have via
 * `playlistItemsByIndex`.
 */
export function albumItemCount(recorded: Recorded[], id: string): number | null {
  const albumUnion = findAlbumUnion(recorded, id)
  if (!albumUnion) return null
  return albumItemsByPosition(recorded, id).length
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
 * Every track-item across every page-bearing response for this playlist,
 * deduplicated by ABSOLUTE list position (`offset + i` within a page's
 * `items` array) and returned in index order -- not simply concatenated
 * page by page. "Page-bearing" means `content.pagingInfo` is present,
 * independent of whether `name`/`uri` are also set (the entity response is
 * itself page one; pages past the first carry no uri, so uri can't be used
 * to find them).
 *
 * Deduplication happens HERE, at the source, rather than being reconstructed
 * from a count derived some other way: a page recorded twice, or two
 * overlapping page windows -- the most plausible product of a misbehaving
 * scroll, which is exactly the failure this whole area of the code exists
 * to catch -- must not merely be miscounted, it must not produce a
 * duplicate `Track` in the list `normalizePlaylist` actually returns either.
 * Keying by absolute index makes a duplicate or overlapping fetch a
 * harmless overwrite (a later write for an index already seen simply
 * replaces it with -- in every real case -- identical data) instead of a
 * second list entry. Both `normalizePlaylist` (which converts each entry to
 * a `Track`) and `playlistItemCount` (which just measures how many distinct
 * positions were covered) build from this single deduplicated source, so
 * there is exactly one place a duplicate/overlap gets resolved, not two.
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
 * This is simply the size of `playlistItemsByIndex`'s deduplicated-by-index
 * result -- NOT a sum of `items.length` across pages (a duplicated or
 * overlapping page would inflate that past what was actually covered) and
 * NOT a count of distinct track URIs either (a playlist may legitimately
 * contain the same track twice, which URI-distinctness would wrongly flag
 * as missing). Returns `null` only if the entity itself can't be found
 * (mirrors `playlistTotalCount`).
 */
export function playlistItemCount(recorded: Recorded[], id: string): number | null {
  const entity = findPlaylistEntity(recorded, id)
  if (!entity) return null
  return playlistItemsByIndex(recorded).length
}

import type { Album, Playlist, Track } from './types.js'

/**
 * The tracks from a listing that are worth caching under their own id.
 *
 * Enrichment is not optional. An album lists its tracks with `album: null`,
 * so storing them verbatim would put album-less records under keys that a
 * later `/v1/track/:id` reads. Because every writer produces an equivalent
 * record after enrichment, fan-out can overwrite freely and no
 * read-before-write is needed.
 *
 * Podcast episodes travel through a Playlist's `tracks` shaped like a Track
 * (see normalize.ts's `trackFromEpisode`), but their url is `/episode/<id>`,
 * not `/track/<id>` -- caching one under a track key would answer a future
 * track lookup with something that is not a track. They are dropped.
 */
export function tracksToCache(entity: Album | Playlist): Track[] {
  const parent =
    entity.type === 'album'
      ? { name: entity.name, id: entity.id, image: entity.image }
      : null

  return entity.tracks
    .filter((t) => !t.url.includes('/episode/'))
    .map((t) => (parent !== null && t.album === null ? { ...t, album: parent } : t))
}

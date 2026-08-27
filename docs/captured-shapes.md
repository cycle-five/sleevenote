# Captured shapes

This document is the contract for `normalize.ts`. It states, without hedging,
where in Spotify's raw responses each field of the published model
(`docs/superpowers/specs/2026-08-27-sleevenote-design.md`, "Response model")
actually lives, based on inspection of the fixtures in `tests/fixtures/`
recorded by `tools/capture.ts`.

All JSON paths below use dot/bracket notation rooted at a fixture entry's
`body` field (i.e. `body.data.trackUnion.name`, not `data.trackUnion.name`).

## The one URL, disambiguated by response shape

Every entity — track, album, playlist, and a handful of irrelevant
recommendation/merch widgets — is served by **the same URL**:

```
https://api-partner.spotify.com/pathfinder/v2/query
```

It is a GraphQL endpoint called by POST; the request body (which this probe
does not record) carries the operation name and variables. The response body
is always `{ "data": { <oneKey>: ... } }` with no `extensions` or
`operationName` field, so **the only way to identify which response carries
which entity is the name of that one key under `data`**:

| entity | key under `data` |
|---|---|
| track | `trackUnion` |
| album | `albumUnion` |
| playlist | `playlistV2` |

A page load fires several `pathfinder/v2/query` responses beyond the entity
itself (locale strings, extracted colors, a merch widget, "you might also
like" widgets). Filter on the key names above and on the discriminators noted
per-entity below; do not assume the first `pathfinder` response is the right
one, and do not assume there is only one per key.

**Known decoy, present in every fixture including `track.json` and
`album.json`:** four `pathfinder` responses per page load carry
`data.playlistV2 = { "__typename": "NotFound", "message": "Object with uri
'spotify:playlist:37i9dQZF1EYkqdzj48dyYq' not found" }`. This is a fixed,
hardcoded playlist reference the page queries unconditionally (observed on
track, album, and playlist pages alike) and it 404s for an anonymous session.
It shares the `playlistV2` key with the real playlist entity, so playlist
extraction must discriminate on `__typename === "Playlist"` (see below), never
on "the response has a `playlistV2` key."

`.id` fields are **inconsistently present** across contexts — see the table
below. The reliable, uniform way to get an entity or artist id is to parse it
out of `.uri`, which is always present and always of the form
`spotify:<type>:<id>` (e.g. `spotify:track:0c6xIDDpzE81m2q797ordA` →
`0c6xIDDpzE81m2q797ordA`). Do not rely on `.id` being there.

## Track

Carried by the `pathfinder/v2/query` response whose `data.trackUnion` is
present and whose `data.trackUnion.__typename === "Track"`.

| model field | JSON path | notes |
|---|---|---|
| `id` | `data.trackUnion.id` | present here (unlike album/playlist contexts); still safe to parse from `.uri` for consistency |
| `type` | — | constant `"track"`, not derived from the payload |
| `name` | `data.trackUnion.name` | |
| `artists[].name` | `data.trackUnion.firstArtist.items[].profile.name` and `data.trackUnion.otherArtists.items[].profile.name` | primary artist(s) and featured artist(s) are two separate lists with the same item shape; concatenate them |
| `artists[].id` | `data.trackUnion.firstArtist.items[].id` / `...otherArtists.items[].id` | present in this context |
| `album.name` | `data.trackUnion.albumOfTrack.name` | |
| `album.id` | `data.trackUnion.albumOfTrack.id` | present in this context |
| `album.image` | `data.trackUnion.albumOfTrack.coverArt.sources[].url` | `sources` is an array of `{ url, width, height }` at multiple sizes (e.g. 64/300/640px); pick one, e.g. the largest |
| `durationMs` | `data.trackUnion.duration.totalMilliseconds` | field is named `duration`, not `trackDuration`, in this context |
| `url` | — | constructed: `https://open.spotify.com/track/<id>` |

## Album

Carried by the `pathfinder/v2/query` response whose `data.albumUnion` is
present, has `__typename === "Album"`, and (to reject the small merch-widget
response that also uses this key) has a `tracksV2` field.

| model field | JSON path | notes |
|---|---|---|
| `id` | not present as `.id` at this level | parse from `data.albumUnion.uri` (`spotify:album:<id>`) |
| `type` | — | constant `"album"` |
| `name` | `data.albumUnion.name` | |
| `url` | — | constructed: `https://open.spotify.com/album/<id>` |
| `image` | `data.albumUnion.coverArt.sources[].url` | same multi-size array shape as track |
| `tracks[]` | `data.albumUnion.tracksV2.items[].track` | `tracksV2.items` is the full track list; see below |
| `tracks[].totalCount` (for verifying completeness) | `data.albumUnion.tracksV2.totalCount` | in the captured fixture (`6ymZBbRSmzAvoSGmwAFoxm`, 15 tracks) `totalCount === items.length`; the whole album came back in one response, no pagination observed for albums |

Each `data.albumUnion.tracksV2.items[].track` maps to a `Track`:

| `Track` field | JSON path (relative to `.track`) | notes |
|---|---|---|
| `id` | not present | parse from `.uri` (`spotify:track:<id>`) |
| `name` | `.name` | |
| `artists[].name` | `.artists.items[].profile.name` | |
| `artists[].id` | not present | parse from `.artists.items[].uri` |
| `durationMs` | `.duration.totalMilliseconds` | same field name as the standalone track query |
| `album` | not present on this item | the album is the enclosing entity; the caller already has its name/id/image |

## Playlist

Carried by the `pathfinder/v2/query` response whose `data.playlistV2` is
present **and** `data.playlistV2.__typename === "Playlist"` (not
`"NotFound"` — see the decoy note above).

| model field | JSON path | notes |
|---|---|---|
| `id` | not present as `.id` | parse from `data.playlistV2.uri` (`spotify:playlist:<id>`) |
| `type` | — | constant `"playlist"` |
| `name` | `data.playlistV2.name` | |
| `url` | — | constructed: `https://open.spotify.com/playlist/<id>` |
| `image` | `data.playlistV2.images.items[0].sources[0].url` | observed with exactly one item and one source per fixture; `width`/`height` were `null` in both captures |
| `owner` | `data.playlistV2.ownerV2.data.name` | note the extra `.data` nesting under `ownerV2`; `.username` and `.uri` are also there if needed |
| `tracks[]` | `data.playlistV2.content.items[].itemV2.data` | see below; **see "Pagination" — a single response only carries one page. Concatenate `content.items` across every matching response in `pagingInfo.offset` order to get the full list.** |

Each `data.playlistV2.content.items[].itemV2.data` maps to a `Track`:

| `Track` field | JSON path (relative to `.itemV2.data`) | notes |
|---|---|---|
| `id` | not present | parse from `.uri` |
| `name` | `.name` | |
| `artists[].name` | `.artists.items[].profile.name` | |
| `artists[].id` | not present | parse from `.artists.items[].uri` |
| `durationMs` | `.trackDuration.totalMilliseconds` | **field is named `trackDuration` here, not `duration`** — this differs from both the standalone track query and the album track list |
| `album.name` / `.image` | `.albumOfTrack.name` / `.albumOfTrack.coverArt.sources[].url` | same shape as the track query's `albumOfTrack`, but **no `.id`** here (parse from `.albumOfTrack.uri`) |

Pagination metadata, needed to detect incompleteness, sits alongside the
items:

- `data.playlistV2.content.totalCount` — the playlist's real track count, as reported by Spotify itself.
- `data.playlistV2.content.pagingInfo.limit` / `.offset` — the window this particular response covers.

## Pagination

**Observed track count for `playlist-large` (`37i9dQZF1DX4o1oenSJRJd`, "All
Out 2000s"): 150 tracks recovered.**
**Real length, per `data.playlistV2.content.totalCount`: 150.**
**Scrolling produced every page; recovery is complete.**

The first capture attempt (see git history: commit `fcd889a` and the fix in
`8c27e02`) used `page.mouse.wheel(0, 20_000)`, which fires at the mouse
cursor's position — defaulting to `(0,0)`, outside Spotify's virtualized
track-list container — and scrolled nothing at all. `pagingInfo.offset`
stayed pinned at `0` through 30 scroll attempts and only the first 25 of the
playlist's tracks were ever fetched. That was reported and correctly
diagnosed as an implementation defect in the probe, not a limit of
interception itself; see the Task 1 report
(`.superpowers/sdd/2026-08-27-sleevenote/task-1-report.md`) for that account.

The corrected probe drives the actual scrollable element (found by walking
the DOM for the largest element whose `scrollHeight` exceeds its
`clientHeight`) and steps it by ~80% of its own height per iteration,
stopping only once `scrollTop` stops advancing — rather than jumping straight
to `scrollTop = scrollHeight`, which was tried and skips the middle of a
virtualized list (it produced `offset=0` then `offset=125` directly, missing
everything in between).

With that fix, `playlist-large` yielded **four** content-bearing
`playlistV2` responses, `pagingInfo` advancing across all of them, summing to
exactly `totalCount` with no duplicates:

| response | `pagingInfo.offset` | `pagingInfo.limit` | `content.items.length` |
|---|---|---|---|
| 1 | 0 | 25 | 25 |
| 2 | 25 | 50 | 50 |
| 3 | 75 | 50 | 50 |
| 4 | 125 | 50 | 25 (only 25 remained) |

The four windows' item counts sum to `25+50+50+25 = 150`, matching
`content.totalCount` exactly, with 150 distinct track URIs across them — no
gaps, no repeats. **A consumer of these fixtures must concatenate
`content.items` across every response whose `data.playlistV2.__typename ===
"Playlist"` and whose `uri` matches the requested playlist, in
`pagingInfo.offset` order, not just read the first one.**

`playlist-small` (`37i9dQZF1DXcBWIGoYBM5M`, "Today's Top Hits") shows the
same complete-recovery pattern at a smaller scale: `content.totalCount` 50,
two content-bearing responses (`offset: 0`/25 items, `offset: 25`/25 items),
50 distinct track URIs, no gaps.

**Conclusion: interception does return a playlist's full track list, not
just its first page — but only when the scroll gesture actually drives the
virtualized list container, incrementally rather than jumping to the end.**
Approach A (browser interception) stands; Approach C is not needed. This
supersedes the BLOCKED finding from the first capture attempt, which was
correct given the probe it was testing but described a bug in the probe, not
a limit of the architecture.

**Note on the target list:** the two playlist fixture targets were swapped
from the original plan (`playlist-small` is now `37i9dQZF1DXcBWIGoYBM5M`,
`playlist-large` is now `37i9dQZF1DX4o1oenSJRJd`) because Spotify had resized
them since the plan was written — the id the plan called "large" now holds
only 50 tracks, and the one it called "small" holds 150. Names above reflect
sizes measured at capture time (2026-08-27), not the ids' original labels.

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
`album.json`:** three to four `pathfinder` responses per page load (3 in
`album.json`, 4 in `track.json`, `playlist-small.json`, and
`playlist-large.json`) carry `data.playlistV2 = { "__typename": "NotFound",
"message": "Object with uri 'spotify:playlist:37i9dQZF1EYkqdzj48dyYq' not
found" }`. This is a fixed, hardcoded playlist reference the page queries
unconditionally (observed on track, album, and playlist pages alike) and it
404s for an anonymous session. It shares the `playlistV2` key with the real
playlist entity, so playlist extraction must never discriminate merely on
"the response has a `playlistV2` key" — nor is `__typename === "Playlist"`
enough by itself; see "Playlist" below for the two rules that are actually
needed, and why.

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
| `album.image` | `data.trackUnion.albumOfTrack.coverArt.sources[].url` | `sources` is an array of `{ url, width, height }` at multiple sizes (e.g. 64/300/640px). Rule: take the entry with the largest `width`; if `width` is absent (`null`) on every entry — observed for playlist `images`, below — take the last entry in the array. |
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
| `artists[].name` | `data.albumUnion.artists.items[].profile.name` | the album's own artist(s), not a per-track list; same item shape as every other artist list in this corpus |
| `artists[].id` | `data.albumUnion.artists.items[].uri` | parse from `.uri` (`.id` is also present directly at this level, but parse from `.uri` for consistency with the rest of the corpus) |
| `image` | `data.albumUnion.coverArt.sources[].url` | same multi-size array shape as track; same sizing rule (largest `width`, else last entry) |
| `tracks[]` | `data.albumUnion.tracksV2.items[].track` | `tracksV2.items` is the full track list across every batch; see "Album" under "Pagination" below -- a >50-track album splits across multiple responses |
| `tracks[].totalCount` (for verifying completeness) | `data.albumUnion.tracksV2.totalCount` | in the small captured fixture (`6ymZBbRSmzAvoSGmwAFoxm`, 15 tracks) `totalCount === items.length` in a single response; **this does not hold for larger albums -- see "Album" under "Pagination" below** |

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

**`__typename === "Playlist"` alone is not a sufficient discriminator — it
also matches a permissions-only fragment that carries none of the entity's
fields.** Every playlist page load fires several `pathfinder/v2/query`
responses whose `data.playlistV2` is present; two separate rules are needed,
because two separate things are being located in that set, and neither rule
is "the first response where `__typename === Playlist`":

- **Entity-bearing response** (`name`, `owner`, `image`, id) — the one
  response where `data.playlistV2.name` is present **and**
  `data.playlistV2.uri === "spotify:playlist:<requested id>"`. Verified to
  match exactly one response in every playlist fixture.
- **Page-bearing responses** (for concatenating the track list, see
  "Pagination" below) — every response where
  `data.playlistV2.content.pagingInfo` is present, independent of whether
  `name`/`uri` are also set. The entity-bearing response is itself
  page-bearing: it carries page one, at `pagingInfo.offset === 0`. A page
  response past the first has `name` and `uri` both `undefined` — **do not
  use `uri` to identify pages**, only to identify the entity response.

Two shapes share the `playlistV2` key and satisfy neither rule; skip them:

- `data.playlistV2.__typename === "NotFound"` — the fixed decoy playlist
  reference described above. No `name`, `uri`, or `content`.
- `data.playlistV2.__typename === "Playlist"` with only `basePermission`,
  `currentUserCapabilities`, and `members` present (`name`, `uri`, and
  `content` all `undefined`) — a permissions fragment for the *requested*
  playlist, not the decoy, fired once per playlist page load and observed to
  arrive **before** the entity response in every fixture. This is exactly
  what makes "first response with `__typename === Playlist`" pick the wrong
  one — it is the failure mode this section exists to rule out.

| model field | JSON path | notes |
|---|---|---|
| `id` | not present as `.id` | parse from `data.playlistV2.uri` (`spotify:playlist:<id>`) |
| `type` | — | constant `"playlist"` |
| `name` | `data.playlistV2.name` | |
| `url` | — | constructed: `https://open.spotify.com/playlist/<id>` |
| `image` | `data.playlistV2.images.items[0].sources[0].url` | observed with exactly one item and one source per fixture; `width`/`height` were `null` in both captures, so the sizing rule's fallback (last entry — which is also the only entry here) applies |
| `owner` | `data.playlistV2.ownerV2.data.name` | note the extra `.data` nesting under `ownerV2`; `.username` and `.uri` are also there if needed |
| `tracks[]` | `data.playlistV2.content.items[].itemV2.data` | see below; a single response only carries one page — concatenate `content.items` across every **page-bearing** response (rule above), in `pagingInfo.offset` order, to get the full list. See "Pagination". |

Each `data.playlistV2.content.items[].itemV2.data` maps to a `Track`:

| `Track` field | JSON path (relative to `.itemV2.data`) | notes |
|---|---|---|
| `id` | not present | parse from `.uri` |
| `name` | `.name` | |
| `artists[].name` | `.artists.items[].profile.name` | |
| `artists[].id` | not present | parse from `.artists.items[].uri` |
| `durationMs` | `.trackDuration.totalMilliseconds` | **field is named `trackDuration` here, not `duration`** — this differs from both the standalone track query and the album track list |
| `album.name` / `.image` | `.albumOfTrack.name` / `.albumOfTrack.coverArt.sources[].url` | same shape and sizing rule as the track query's `albumOfTrack`, but **no `.id`** here (parse from `.albumOfTrack.uri`) |

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
`content.items` across every response with `data.playlistV2.content.pagingInfo`
present (the page-bearing rule in "Playlist" above), in `pagingInfo.offset`
order, not just read the first one — and not filter these by `uri`, since
only the first page carries it.**

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

### Album

The 15-track fixture (`6ymZBbRSmzAvoSGmwAFoxm`) was captured whole in one
`albumUnion` response, which the original writeup (above) mistook for "albums
don't paginate." A fix-wave investigation against `5s5svl5DzlSmEvkjuL8Upw`
("60 Original Hits", declared 60 tracks) found otherwise: **albums over ~50
tracks split across multiple `pathfinder/v2/query` responses**, the same way
large playlists do, just without `pagingInfo`:

```
resp 1: items=50 total=60 hasUri=true   pagingInfo=undefined   trackNumber 1..50
resp 2: items=10 total=60 hasUri=false  pagingInfo=undefined   trackNumber 51..60
```

Two things distinguish this from the playlist case:

- **No `pagingInfo`/offset at all** on either response — `content.pagingInfo`
  is a `playlistV2`-only field. An early pass at this fix concluded from that
  absence that albums carry no positional signal whatsoever and proposed
  concatenating batches in arrival order. That is wrong: every
  `tracksV2.items[].track` entry carries its own **`discNumber` and
  `trackNumber`**, running 1..50 then 51..60 across the two responses above.
  That's Spotify's own absolute position for the item, serving the same role
  `pagingInfo.offset` serves for a playlist — so albums are keyed by
  `(discNumber, trackNumber)` (`albumItemsByPosition` in `src/normalize.ts`),
  not concatenated by arrival order.
- **The second (and any later) batch has no `uri`** on its `albumUnion` — only
  the first batch is also the entity-bearing response. Where the playlist
  page-gathering loop uses "`content.pagingInfo` present" as its
  uri-independent filter, the album loop can't: there is no `pagingInfo` to
  check. It uses `tracksV2.totalCount` matching the entity's declared total
  instead — the only discriminator the shape offers, with the caveat spelled
  out in `albumItemsByPosition`'s doc comment: it can't tell apart two
  different albums that happen to declare the same track count in the same
  recording.

Live re-verification after the fix (see the task report for the exact
recovered counts): both `5s5svl5DzlSmEvkjuL8Upw` and `1ff9TZHVP9QNfXqL3pwrTk`
(each declaring 60 tracks) resolve to all 60, in `trackNumber` order, sourced
from two `tracksV2` batches per album, keyed and deduplicated exactly as
described above.

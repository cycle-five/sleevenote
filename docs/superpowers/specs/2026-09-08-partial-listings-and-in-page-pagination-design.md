# Partial listings, in-page pagination, and track fan-out

**Date:** 2026-09-08
**Status:** approved, not yet implemented
**Scope:** this repo only. The Rust client and cracktunes are follow-ups.

## The problem

`GET /v1/playlist/37i9dQZF1DXcBWIGoYBM5M` -- Today's Top Hits -- answers:

```json
{"error":"extraction_incomplete","id":"37i9dQZF1DXcBWIGoYBM5M",
 "message":"playlist ... saw 25 of 50 declared tracks ... -- extraction was incomplete"}
```

Measured against the deployed `0.3.1` on 2026-09-07. Tracks and albums are
fine on the same instance (`/v1/album/5s5svl5DzlSmEvkjuL8Upw`: 60 of 60, 0
unresolved). Large editorial playlists are the shape that fails.

Two symptoms, one cause. `recordResponses` scrolls a virtualised list up to
`SCROLL_MAX_ITERATIONS` (200) times at `SCROLL_STEP_DELAY_MS` (350ms), then
waits `SCROLL_SETTLE_MS` (3s), choosing its scroll container by walking
`querySelectorAll('*')` for the largest scrollable element. That heuristic
is both the 8-15s cold resolve and the shortfall: it stopped scrolling
before the list was through.

The data itself is not the problem. `normalize.ts` already parses
`api-partner.spotify.com/pathfinder/v2/query` bodies. The browser is a
wrapper that establishes a session and provokes those queries; scrolling is
how it provokes more of them.

## Decisions

Settled before design. Each rules out an option worth naming.

1. **Partials are opt-in.** Without `?partial=allow`, `extraction_incomplete`
   stays a 502 exactly as today. Serving partials as ordinary 200s would
   reintroduce the failure the completeness check exists to catch --
   "a truncated playlist looks exactly like a complete one" -- for every
   consumer that does not know to check. Policy belongs to the caller; the
   service reports facts.
2. **A partial is cached; a strict caller re-produces.** Storing it saves the
   scrape for opt-in callers. A strict caller treats a cached partial as a
   miss, which leaves the retry path the never-cache rule protects open, and
   is no worse than today, where `ExtractionIncompleteError` is never cached
   and every strict request re-scrapes anyway.
3. **The browser stays; the scroll goes.** Pagination is driven by pathfinder
   calls issued *from inside the page*, which already holds a valid session.
   No token, TOTP or persisted-hash handling of our own. Direct HTTP with
   harvested credentials is faster still (~200-500ms against ~2-4s) but takes
   on Spotify's token scheme as a maintenance burden; that trade is not worth
   making while navigation is the only remaining cost.
4. **Minimal seam.** Extraction returns a completeness verdict instead of
   throwing on a shortfall, and paginated responses arrive through the
   existing `page.on('response')` interceptor into the same `Recorded[]`
   corpus. `normalize.ts`, `evidenceFrom`, the seen-vs-declared counting
   rules and the whole recorded-fixture corpus are untouched.

## 1. Wire contract: opt-in partial listings

`Album` and `Playlist` gain two fields, present on **every** response of that
kind, complete or not:

```ts
declaredItems: number | null   // Spotify's own total; null when it declared none
complete: boolean              // whether we saw all of them
```

`complete` is `declaredItems === null || tracks.length + unresolvedItems === declaredItems`.
A consumer could derive it, and it is sent anyway so the rule lives in one
place -- including the "Spotify declared nothing, so we cannot tell, so do not
claim a shortfall" case, which is the arm most likely to be got wrong
independently.

`seenItems` is deliberately **not** added: it is exactly
`tracks.length + unresolvedItems`, and a field that is always the sum of two
others is a chance for them to disagree.

Adding fields is backward compatible: an existing client ignores unknown keys.
The reverse would not be -- a client that *requires* them breaks against an
older server -- which is the follow-up's problem, not this one's.

### Request

`?partial=allow` on `GET /v1/album/:id` and `GET /v1/playlist/:id`.

| | complete | short |
|---|---|---|
| no flag | 200 | 502 `extraction_incomplete` (unchanged) |
| `?partial=allow` | 200 | **200**, `complete: false` |

Meaningless on `/v1/track/:id` -- a track has no listing. Accepted and
ignored rather than rejected: a client that sets it uniformly should not have
to special-case one route.

Every other failure is untouched. `not_found`, `extraction_empty`,
`extraction_silent` and `timeout` ignore the flag entirely: a partial listing
is a listing, and none of those produced one.

## 2. Extraction: pagination instead of scrolling

`recordResponses` gains a request interceptor alongside its response one. The
page's first pathfinder request carries everything a repeat needs: operation
name, persisted-query hash, headers (`Authorization`, `client-token`), and the
variables object holding `offset`/`limit`.

With that template captured, the scroll loop is replaced by:

```
harvest template from the first pathfinder request
read totalCount from the first response
while offset + limit < totalCount and pages < MAX_PAGES:
    offset += limit
    page.evaluate(() => fetch(PATHFINDER_URL, {...template, variables: {...offset}}))
```

`fetch` issued in page context emits Playwright `response` events, so the
bodies land in the same `Recorded[]` the scroll path filled. Nothing
downstream can tell the difference, which is the point.

**The scroll loop is retained as a fallback**, entered when no request
template can be harvested. It is the degraded path, not dead code:
pagination can still be cut short by a navigation failure or a token expiring
mid-loop, so decision 1's partial handling remains live after this lands.
That is why the two changes are independent and why partials ship first.

Bounds: `MAX_PAGES` caps the loop, and the existing `produceBudgetMs` still
governs the whole produce.

## 3. Fan-out: cache the tracks a listing already contains

After a successful album or playlist produce, write each contained track to
`v1:track:{id}` at the track TTL (30 days). Best effort -- a failed write is
logged and never fails the request.

**Album tracks must be enriched first.** `Track.album` is `null` on every
track inside an `Album`, deliberately, because repeating the parent across 60
entries is noise. Writing those verbatim would poison the track cache with
album-less records. Each is given the parent's `{name, id, image}` before
storage, which makes the cached record *better* than the listing entry and
turns a later `/v1/track/:id` for an album track from a full browser scrape
into a cache hit. That is the highest-value case here.

Playlist tracks already carry their album and are stored as-is, except that
**podcast episodes are skipped**: their `url` is `/episode/<id>`, they are not
valid `/v1/track/:id` responses, and caching one under a track key would
answer a future track lookup with something that is not a track.

Partial listings fan out too. The tracks that did arrive are real.

Overwriting an existing entry is fine and no read-before-write is needed:
after enrichment every writer produces an equivalent record, so last-write-wins
cannot lose information. This is the reason enrichment is not optional.

## 4. Cache mechanics

No change to the stored shape. The verdict is already inside the value,
because `complete` is a response field.

`withCache` gains an optional predicate:

```ts
acceptsCached?: (value: T) => boolean
```

Applied at all three places an entry is considered -- the initial freshness
check, the waiter poll, and the stale-on-error fallback. A strict caller
passes `(v) => v.complete !== false`; an opt-in caller passes nothing.

Consequences, stated so they are not discovered later:

- A strict request behind a cached partial re-produces. If the result is still
  short it 502s, having refreshed the cached partial on the way past, which
  opt-in callers then benefit from.
- Single-flight is weaker than it was, and deliberately so. The lock is keyed
  on the entity, not the caller's strictness, so it still stops two callers
  producing the *same* answer concurrently. But a strict caller and an opt-in
  caller are not asking the same question: a strict caller racing a holder
  that produces a partial refuses what the holder wrote and produces a second
  time. That is the previous bullet arriving by another route, not a
  regression -- the alternative is serving a strict caller a listing it
  explicitly refused. It produces promptly, on seeing the refused entry,
  rather than after polling out the whole `produceBudgetMs`.
- A strict caller can be served a *stale complete* entry in preference to a
  fresh partial. That is correct: it asked for a complete listing.

## Testing

The existing fixture corpus and every test over it stay as they are.

- **Verdict**: a recorded capture where `seen < declared` yields
  `complete: false` and the listing, rather than a throw. Both statuses
  asserted through the route: 502 without the flag, 200 with it.
- **Field arithmetic**: `complete` true when `declaredItems` is null; true
  when `tracks.length + unresolvedItems === declaredItems` with items dropped
  by validation (the case the seen-vs-`tracks.length` rule exists for).
- **Cache predicate**: cached partial + strict caller re-produces; + opt-in
  caller hits; stale complete preferred over fresh partial for a strict
  caller.
- **Fan-out**: album tracks come back with the parent album attached; playlist
  episodes are not written; a store failure does not fail the request.
- **Pagination**: template harvest and offset arithmetic are unit tested
  against recorded requests. The browser loop itself is integration-tested
  against a live id, alongside the existing suite.

## Out of scope

- `crack-sleevenote`: model the new fields, add the `partial` flag. Follow-up issue.
- `cracktunes`: opt in, and word the "queued 25 of 50" message. Follow-up issue.
- Retiring the browser from the data path entirely. Revisit only if navigation
  becomes the dominant cost after this lands.
- Negative-cache tuning for editorial ids. It was on the table and is dropped:
  it is a workaround for extraction that fails, and this stops it failing.

## Risks

- **Template harvest breaks** if Spotify changes how the web player issues
  pathfinder queries. Mitigated by the retained scroll fallback, which
  degrades to today's behaviour rather than an outage.
- **Redis growth** from fan-out: bounded by the 30-day track TTL and by
  listing sizes already fetched. Worth a metric, not a mechanism.
- **`?partial=allow` becomes the default caller habit**, eroding the
  invariant. This is why the flag is per-request rather than a server setting:
  the choice stays visible at each call site.

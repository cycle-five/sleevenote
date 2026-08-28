# sleevenote — design

A browser-backed HTTP service that resolves a music-entity URL to normalized
metadata, with no provider API key.

**Status:** design approved 2026-08-27. Not yet implemented.

**First consumer:** `cracktunes`, whose Spotify integration is dead (see
Background). First provider: Spotify. The name is deliberately provider-neutral —
sleeve notes are the printed metadata on an album sleeve, which is exactly the
payload this returns.

---

## Background — why this exists

`cracktunes` resolved Spotify links through the Spotify Web API via `rspotify`.
Two Spotify decisions killed that, and neither is recoverable by configuration:

1. **2024-11-27** — Spotify deprecated `recommendations`, `related-artists`,
   `audio-features`, `audio-analysis`, `featured-playlists` and
   `category-playlists`. Apps holding extended quota before that date were
   grandfathered; everything else receives 403. The reference page still carries
   a "Deprecated" banner. Not walked back, no replacement, no waitlist.

2. **~2025-12 onward** — creation of new Web API apps is blocked. The developer
   dashboard either greys out the button (*"New integrations are currently on
   hold while we make updates to improve reliability and performance"*) or fails
   with an unexplained *"Something went wrong."* It was marked resolved once and
   regressed. No timeline has been given.

Together these mean an operator without pre-existing credentials **cannot obtain
them at all**. This is not a misconfiguration to fix; it is a capability that has
been withdrawn.

Two off-the-shelf escapes were tested on 2026-08-27 and both are dead:

| approach | result |
|---|---|
| Odesli / song.link public API | `401 PUBLIC_API_ACCESS_DEPRECATED` |
| Spotify oEmbed (unauthenticated) | returns `title` only — no artist, and for a playlist only the playlist's own name |

`dantheman213/spotify-playlist-to-json` (MIT, Puppeteer, headless Chrome) has the
right shape but is not salvageable: last pushed 2023-03-03, pinned to Puppeteer
`^2.0.0` against a current 25.9.0, built on `node:12.3.1-slim` (EOL 2022-04-30),
and **all four of its scraping selectors** — `.tracklist-row`, `.tracklist-name`,
`.mo-info-name`, `.cover-art-image` — return zero matches against today's
Spotify. Its async job pattern and MIT posture are worth taking; its code is not.

## Goal

Resolve a Spotify track, album or playlist URL to normalized metadata —
reliably enough that `cracktunes` can build a search query from it, and cheaply
enough that repeat lookups never touch a browser.

Explicitly **not** a goal: recommendations. See Out of scope.

## Constraints

- **No provider API key.** That is the entire point; if credentials were
  obtainable this service would not exist.
- **Stateless service.** All shared state in Redis, so instances scale
  horizontally and any one of them may be replaced at will.
- **No auth, rate limiting or quotas inside the service.** Those belong to a
  load balancer in front of it. Keeping them out is what lets the private
  deployment and a future public deployment be the same artifact.
- **Private deployment initially**, on a private network, reachable only inside the
  estate. Repo private until it works, then public.

## Decisions

### TypeScript + Playwright

The browser layer is the entire risk surface, so it gets the most mature
tooling available rather than the tooling that matches the consumer's language.
Playwright ships and version-pins its own Chromium and maintains a container
image, which removes the hand-rolled Chrome-in-Docker problem that rotted the
prior art. Its network interception (`page.route`, `page.on('response')`) is the
core technique here.

The service talks HTTP, so its language is invisible to `cracktunes`.

### Extraction by network interception, not DOM scraping

Playwright loads the entity page; we listen for the JSON the page's own
JavaScript fetches from Spotify's internal API and normalize that.

We never parse HTML. Spotify's class names are hashed and change between
deploys — that is precisely what killed the prior art — whereas the data layer
those pages consume changes far more slowly. Reading the data layer instead of
the view layer is the single most important decision here.

Verified 2026-08-27: the initial HTML is a ~157KB shell titled "Spotify – Web
Player" containing **no** `og:title`, no JSON-LD, no `__NEXT_DATA__` and no
bootstrapped `accessToken`. Everything is client-rendered, which is why a real
browser is required and why a plain HTTP fetcher cannot work.

### Documented but not built: token harvest (Approach C)

Use the browser to capture the `Authorization` header its requests carry, then
issue direct HTTP calls with that token until it expires — browser only for
refresh. A cache miss would drop from seconds to roughly 200ms, and paginated
playlists would become a handful of cheap calls.

Deferred deliberately. Spotify moved token acquisition behind a runtime
verification step, and depending on the token lifecycle means owning more of
Spotify's anti-automation surface. Approach C is a contained change *behind the
same cache and the same HTTP interface* if playlist latency proves painful — not
a rewrite. Revisit only with evidence.

### Redis, not an embedded store

The cache is the shared state of a stateless service, so it must live outside
any single instance. Redis is also swappable and distributable if the topology
changes. An embedded store (SQLite) was considered and rejected: it would weld
the service to one instance and foreclose the horizontal-scaling seam.

Redis is not currently deployed in the estate and will need standing up.

## Architecture

```
cracktunes ──HTTP──▶ [ LB: auth, rate limiting ]   ◀── future, public deployments only
                             │
                             ▼
                    sleevenote (stateless, N instances)
                       │               │
                       │               └──▶ Redis  (cache + single-flight locks)
                       ▼
               Playwright / headless Chromium
                       │
                       ▼
               open.spotify.com   (intercept JSON responses)
```

The load balancer slot stays empty for the private deployment; `cracktunes`
calls the service directly over the private network.

## API

Versioned, entity-typed, synchronous. Cache hits return in milliseconds; misses
block for the browser load behind a bounded timeout.

```
GET /v1/track/:id      -> Track
GET /v1/album/:id      -> Album      (includes tracks)
GET /v1/playlist/:id   -> Playlist   (includes tracks)
GET /health            -> fixed origin-specific string
GET /metrics           -> Prometheus exposition
```

There is deliberately **no** `GET /v1/resolve?url=`. `cracktunes` already parses
Spotify URLs into type and id (`SPOTIFY_QUERY_REGEX`, plus the `spotify:track:`
form) and that code works; moving it server-side would be churn.

`/health` returns the exact string `sleevenote ok` with
`Content-Type: text/plain`, and returns it only when Redis is reachable and the
browser pool has at least one live context. A status-only check is worthless:
a service in this operator's own estate spent nine days serving its CDN's
error page, which any check asserting merely "a response arrived" would have
called healthy for all nine.

The string is origin-specific on purpose — a caller comparing against
`sleevenote ok` cannot be fooled by an intermediary's error page, however well
formed.

### Response model

Normalized, so Spotify's internal shapes remain an implementation detail.

```jsonc
// Track
{
  "id": "0c6xIDDpzE81m2q797ordA",
  "type": "track",
  "name": "Hideaway",
  "artists": [{ "name": "Kiesza", "id": "…" }],
  "album": { "name": "Sound of a Woman", "id": "…", "image": "https://…" },
  "durationMs": 265000,
  "url": "https://open.spotify.com/track/0c6xIDDpzE81m2q797ordA"
}

// Album and Playlist
{
  "id": "…", "type": "album" | "playlist",
  "name": "…", "url": "…", "image": "…",
  "owner": "…",          // playlist only
  "tracks": [ Track, … ]
}
```

`artists[].name` and `name` are load-bearing — `cracktunes` builds its search
query from them. Everything else is incidental and may be absent.

## Browser pool

A fixed-size pool of persistent Chromium contexts. Requests borrow a context,
navigate, and return it. Contexts are recycled after a configured number of uses
so leaked memory does not accumulate.

Explicitly **not** launch-per-request: the prior art calls `puppeteer.launch()`
inside its request path, which is its dominant cost.

Image, font and media requests are aborted via `page.route()`. They are a large
share of page-load time and this service has no use for any of them.

## Caching

Keys are `v1:<type>:<id>`. TTLs follow mutability:

| entity | TTL | rationale |
|---|---|---|
| track | 30d | a track's artist and title never change |
| album | 30d | track listing is fixed at release |
| playlist | 1–6h | contents genuinely change |
| negative (404) | 5–15m | stops invalid ids driving the browser repeatedly |

Two behaviours make this aggressive rather than merely cached:

**Single-flight.** A Redis `SET NX` lock per key, so concurrent misses for the
same id share one browser load. Without it the same playlist pasted in two
guilds simultaneously is two Chromium page loads for one result.

**Stale-on-error.** If a scrape fails and an expired entry exists, serve it with
`X-Cache: stale`. A slightly old playlist beats an error.

## Error handling

```
scrape fails, no cache      -> 502 + typed error body
scrape fails, stale cache   -> 200 + X-Cache: stale
unknown / invalid id        -> 404, negative-cached
timeout                     -> 504
```

Every non-2xx lands in `cracktunes`' existing graceful-degradation path, so a
dead scraper degrades to "search by name instead" rather than a stack trace.

## Observability

The prior art did not fail loudly — it failed silently, returning nothing. That
is the failure mode to design against.

**A scrape that yields zero tracks is a distinct, loud signal and never a valid
empty result.** `/metrics` exposes:

- cache hit rate, by entity type
- scrape duration histogram
- scrape failures by reason
- **extraction-yielded-nothing counter** — the canary for a Spotify redesign

These feed the existing Prometheus → Alertmanager → Discord pipeline.

## Testing

**Offline, deterministic, in CI.** Real intercepted responses are recorded as
fixtures; the normalizer is tested against those with no network. This is the
bulk of the suite and it must pass with no internet access.

**Live smoke test, scheduled, not per-PR.** Hits real Spotify to prove the
extraction still works. When it cannot run it **SKIPs with a stated reason and
the date of the last measured pass** — it never FAILs for want of network. A red
test must mean something is broken.

## Risks

**Spotify redesigns and extraction breaks.** This is the standing cost of the
approach, not a defect to be fixed once. Mitigated by reading the data layer
rather than the view layer, and by the yielded-nothing alert making breakage
loud and immediate.

**Playlist pagination is the largest unknown.** Spotify's internal API paginates
track lists, and interception may capture only the first page, requiring scroll
to trigger the rest. This has not been tested with a real browser. **Validating
it is the first task of implementation**, because a bad answer is the argument
for Approach C sooner rather than later.

**Terms of service.** Scraping is contrary to Spotify's developer terms. This is
an accepted, deliberate cost: the service is a separate project, unassociated
with its consumers, and the capability it restores was withdrawn rather than
offered on terms that could be met.

## Out of scope

- **Recommendations.** `/radio/track/<id>` returns 200 but serves the same
  generic SPA shell as any other page, and radio has historically been a
  logged-in surface; whether it renders for an anonymous visitor is untested.
  `cracktunes` autoplay will be re-sourced separately, most likely from YouTube,
  which it already plays from.
- Providers other than Spotify. The name and response model leave room; nothing
  else is built for them.
- Auth, rate limiting, quotas, multi-tenancy — the load balancer's job.
- Playback, audio, or anything requiring a Spotify account.

## Open items

- Redis deployment: new instance versus one shared with future estate services.
- Browser pool size and context recycle threshold — set from measurement, not
  guessed.
- Exact TTL for playlists within the 1–6h band.

# Design notes

Why the code in `src/` is shaped the way it is. The comments there are
deliberately short and point here for anything that needs a paragraph.

Most of what follows was learned by getting it wrong first. Where that is the
case it is said plainly, because "we tried the obvious thing and it failed
this way" is the part that stops someone re-trying it.

---

## The four extraction failures

`src/extract.ts` defines four error classes and `src/server.ts` maps them to
four different responses. Keeping them apart is the whole point of this
service — the prior art it replaces failed by returning nothing that looked
like an error, so nobody noticed for a long time.

| Error | Means | HTTP | Cached? |
|---|---|---|---|
| `NotFoundError` | The entity does not exist | 404 | Yes, negative-cached |
| `ExtractionEmptyError` | Navigated fine, zero tracks came back | 502 | **Never** |
| `ExtractionIncompleteError` | Some tracks came back, fewer than declared | 502 | **Never** |
| `ExtractionTimeoutError` | The whole call exceeded `produceBudgetMs` | 504 | **Never** |

The three that are never cached all mean the same underlying thing: *our
extraction stopped matching Spotify's page*. They are kept apart because they
are different diagnoses. "Recovered zero tracks" is a total discriminator
failure; "recovered 140 of 150" is a pagination failure. A dashboard that
cannot tell them apart cannot tell you which one broke.

`ExtractionTimeoutError` is a class rather than a distinguished message for a
concrete reason: the HTTP layer used to match a 504 by regex-testing the error
text, so editing the wording in `extract.ts` would have silently downgraded
every timeout to a generic 502.

## Completeness: `seen`, not `tracks.length`

A truncated playlist looks exactly like a complete one. The only defence is to
compare Spotify's own declared total against what we actually recovered — and
*which* number you compare is load-bearing.

Compare `albumTotalCount` / `playlistTotalCount` against `albumItemCount` /
`playlistItemCount`, which count **raw items seen**. Never compare against
`result.tracks.length`.

The difference: `normalize.ts` drops items with no name or no artists, because
a nameless track is useless to a consumer building a search query. That is
validation working correctly on one bad or region-locked track — not a missed
page. Comparing against `tracks.length` conflates the two, so a *complete*
extraction containing one malformed item raises `ExtractionIncompleteError`.
And because that error is never cached, it then fails on **every retry,
forever** — strictly worse than the truncation the check exists to catch.

Both the counts and the track lists are built from the same deduplicated
source, so the count and the list can never disagree about what was seen.

## Scrolling a virtualized list

`recordResponses` steps the scrollable container by ~80% of its own
`clientHeight` per iteration and stops when `scrollTop` stops advancing. Two
more obvious techniques were each measured and each failed:

1. **`page.mouse.wheel`** fires at the cursor's default position, `(0,0)`,
   which is outside Spotify's track-list container. It scrolls nothing at all.
2. **Jumping to `scrollTop = scrollHeight`** skips the middle. A virtualized
   list only fetches rows near the viewport, so you get the first page and the
   last page and nothing in between.

The working technique recovered every page of a 150-track playlist — offsets
0/25, 25/50, 75/50, 125/25 = 150, matching `totalCount` exactly.

There is no "don't scroll on a track page" branch. A track page has no element
large enough to match the container heuristic, so the loop finds nothing and
exits on its first iteration.

## Album batches

Albums and playlists paginate differently, and the album case has no clean
discriminator.

A playlist page carries `content.pagingInfo`, giving each item an absolute
position (`offset + i`). `playlistItemsByIndex` keys by that. A repeated or
overlapping page — the likeliest product of a misbehaving scroll — becomes a
harmless overwrite rather than a duplicate track.

An album has **no `pagingInfo`**, and batches past the first carry **no
`uri`**, so neither the playlist's filter nor the entity's uri-match can find
them. The only discriminator the shape offers is a `tracksV2.totalCount`
matching the entity's declared total. That is a real filter — it rejects a
differently-sized album's batch outright — but it is *not* a guarantee: two
albums declaring the same track count, captured in one recording, would be
indistinguishable. No stronger per-batch signal has been observed.

**The positional signal albums do have** was missed on a first pass, which
searched for something `pagingInfo`-like, found nothing, and concluded there
was no position at all — proposing concatenation in arrival order. That was
wrong. Every `tracksV2.items[].track` carries `discNumber` and `trackNumber`,
Spotify's own absolute position, serving exactly the role `pagingInfo.offset`
serves for a playlist.

`discNumber` must be **part of the key, not a tiebreaker**. On every album
tested for pagination it was `1` — flat compilations where `trackNumber` ran
continuously. A genuine 2-disc album (`78dSB74LrGEdjilKcR3bIW`, Shostakovich's
*The Golden Age*) shows why: `trackNumber` restarts at 1 on disc 2 (disc 1 ran
1–17, disc 2 ran 1–22). Keying on `trackNumber` alone would collapse disc 1
track 1 with disc 2 track 1 and silently drop one.

Observed batch shape across four albums (60/60/100/150 declared): batch one
caps at 50 items and the entire remainder arrives as one second batch — the
150-track album split 50 + 100, not 50 + 50 + 50. The code does not assume
this; it gathers however many qualifying batches appear. Albums beyond 150
tracks are unverified.

## Non-Track playlist items

Every fixture except `playlist-mixed` is Spotify editorial content, which is
all `Track`s. A real user's playlist is not. It can hold at least three kinds:

| `itemV2.__typename` | `data.__typename` | Has `artists`? | id in `uri`? | Duration field |
|---|---|---|---|---|
| `TrackResponseWrapper` | `Track` | yes | yes | `trackDuration` |
| `EpisodeOrChapterResponseWrapper` | `Episode` | **no** | **yes** | `episodeDuration` |
| `LocalTrackResponseWrapper` | `LocalTrack` | **no** | **no** | `localTrackDuration` |

`trackFromNode` requires a name, an id parsed from `uri`, and at least one
artist. Both non-Track kinds fail that, so a playlist of one song, one podcast
episode and one local file currently normalizes to **one track**.

### The two are dropped for different reasons

**A `LocalTrack` genuinely has no Spotify identity.** Its uri is
`spotify:local:::<name>:<seconds>` — the id position is empty, so
`idFromUri` correctly returns null. It is a file on the user's own machine.

**An `Episode` is dropped by choice, not by constraint.** It has a real uri
(`spotify:episode:6CQAC1k7sUVk8FQsXABlRU`), a real name, and its show name at
`podcastV2.data.name`. It is dropped only because it carries no `artists`
array. For a consumer resolving Spotify metadata into a search query,
"Darknet Diaries — 178: Ubiquiti" is every bit as resolvable as a song.

### Completeness is not affected

`playlistItemCount` counts raw items seen, not tracks that survived
validation — so this playlist reports 3 seen against 3 declared and passes.

This is exactly why that distinction exists. Were completeness measured on
`tracks.length`, any playlist containing a podcast or a local file would raise
`ExtractionIncompleteError` on every request and, because that error is never
cached, **fail forever**.

### The open question

The drop is currently *silent*: the response carries one track and nothing
indicates that two further items existed and were deliberately not
represented. A consumer cannot tell "a playlist with one song" from "a
playlist with three items, two unrepresentable".

That is the same shape of silence this service exists to remove, so it is
worth an explicit decision rather than an accident. Unresolved.

## The failure relay

`withCache` runs one `produce()` per key and makes concurrent callers wait on
it. The waiter loop originally polled only for a fresh **value** — and a
failed produce writes no value.

So waiters could not distinguish "the holder failed" from "the holder is
slow". They polled out the entire `produceBudgetMs` (150s in production) and
then **all** fell through to produce directly, without the lock. Five
concurrent requests for one permanently-broken entity became five concurrent
Chromium loads, 150 seconds later. Because the browser pool is small and
shared across every entity, that herd queues on the pool and starves requests
for unrelated entities behind it: one broken entity could stall the service.

The fix relays the failure. The holder publishes it under `<key>:fail` before
unlocking; waiters read it and stop. Three details are load-bearing:

- **The holder clears any leftover marker when it takes the lock**, so "marker
  present" means "the produce I am waiting on has already failed", with no
  qualifier about which cohort wrote it.
- **Stale-on-error can swallow the failure** and return an existing entry
  without throwing. Waiters demand a *fresh* entry, so that does not release
  them — the holder publishes on that path too, keyed off `staleError`.
- **The marker carries a tagged union** (`server.ts`'s `RelayedFailure`), not
  a flattened `Error`. A waiter that lost the type would get a generic 502 for
  an entity the holder answered 404.

### Why the TTL is seconds

`FAILURE_RELAY_TTL` defaults to 5. This is a **handoff to the cohort already
waiting, not a negative cache for errors**, and the distinction matters.

A `NotFoundError` is a statement about the world — this id does not exist — so
caching it is safe. The other failures are statements about *us*: the scraper
broke, or Spotify changed the page. Caching those means caching our own bugs:
ship a fix, redeploy, and every previously-requested entity keeps serving the
old failure until the marker expires. A mechanism whose job is to extend our
own outages.

Raising the TTL does buy throttling of a permanently-broken entity. That trade
belongs to the operator, which is why it is a knob and not a constant.

Steady state under constant load on a broken entity is now one extraction at a
time rather than N concurrent — bounded, so the pool cannot be starved, but
not free. If that ever proves too generous, a per-entity circuit breaker is the
next step up, and nothing here forecloses it.

## The browser pool

One browser, `poolSize` reused contexts. The prior art called
`puppeteer.launch()` in its request path, and that launch was its dominant
cost.

`acquire()` queues FIFO rather than rejecting when everything is busy: a third
concurrent caller against a pool of two should wait its turn, not become a
500.

Contexts are recycled at release time, at `contextMaxUses` **or** when the
page has closed. The use budget alone was not enough — a context whose
renderer crashed sat in the free list being handed out until it happened to
also reach its budget, which for a low-traffic deployment could be arbitrarily
far away.

`liveContexts()` re-checks `page.isClosed()` on every record at call time
rather than trusting a counter. A counter is how `/health` kept answering "ok"
while every request against a crashed context failed.

Contexts block `image`, `font` and `media`. The fixture corpus was recorded
with exactly those blocked, so a pool serving unblocked pages would show
production a different page than the normalizer was built against.

## Redis client tuning

ioredis's defaults leave a command queued through up to 20 retries — roughly
70 seconds — before rejecting when Redis is unreachable. `/health` exists to
answer promptly when Redis is down, and a health checker has given up long
before 70s.

The settings in `RedisStore` bound only how long an **individual command**
waits on a *sustained* outage. Two deliberate non-changes:

- `enableOfflineQueue` stays at its default `true`, so a command issued during
  a brief reconnect blip still queues and succeeds rather than failing
  instantly.
- `retryStrategy` always returns a delay and never `null`, so reconnection
  itself is unbounded and the client recovers on its own once Redis returns,
  with no need to recreate it.

## Testing note

Several bugs in this codebase were invisible to a green test suite, and at
least one test passed for the wrong reason until mutation testing caught it (a
`produce()` fast enough that the waiter read the value before ever consulting
the failure marker). When a test guards a timing-dependent path, check that it
actually fails with the fix removed.

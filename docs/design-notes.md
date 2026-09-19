# Design notes

Why the code in `src/` is shaped the way it is. The comments there are
deliberately short and point here for anything that needs a paragraph.

Most of what follows was learned by getting it wrong first. Where that is the
case it is said plainly, because "we tried the obvious thing and it failed
this way" is the part that stops someone re-trying it.

---

## The five extraction failures

`src/extract.ts` defines five error classes and `src/server.ts` maps them to
five different responses. Keeping them apart is the whole point of this
service — the prior art it replaces failed by returning nothing that looked
like an error, so nobody noticed for a long time.

| Error | Means | HTTP | Cached? |
|---|---|---|---|
| `NotFoundError` | Spotify answered the page non-2xx: the entity is gone | 404 | Yes, negative-cached |
| `ExtractionSilentError` | The page loaded, and nothing on it matched | 502 | **Never** |
| `ExtractionEmptyError` | Found the entity, zero tracks in it | 502 | **Never** |
| `ExtractionIncompleteError` | Some tracks came back, fewer than declared | 502 | **Never** |
| `ExtractionTimeoutError` | The whole call exceeded `produceBudgetMs` | 504 | **Never** |

The four that are never cached all mean the same underlying thing: *our
extraction stopped matching Spotify's page*. They are kept apart because they
are different diagnoses. "Recognised nothing at all" is a wholesale shape
change; "recovered zero tracks" is a broken list discriminator; "recovered 140
of 150" is a pagination failure. A dashboard that cannot tell them apart cannot
tell you which one broke.

## Absence has to be evidenced

`ExtractionSilentError` exists because the first four were not enough, and the
gap was load-bearing. `normalizeByKind` returning `null` used to become a
`NotFoundError` — 404, negative-cached for `TTL_NEGATIVE`. But `null` covers
two unrelated situations: Spotify says the entity is gone, and *we recognised
nothing on a page that loaded fine*. A live playlist was served as "not found"
because the second was reported as the first, and the negative cache then kept
serving it that way after extraction had recovered.

The natural discriminator — "did we capture any JSON?" — does not work.
Measured against the real site, a dead entity records **no JSON responses at
all**, which is byte-for-byte the evidence a silent capture leaves:

```
playlist/zzzzzzzzzzzzzzzzzzzzzz  →  {"recorded":0,"statuses":[],"paths":[]}
```

The navigation status does work, because it is *positive* evidence rather than
the absence of it. Spotify answers the document itself for a dead entity:

| request | navigation status | page title |
|---|---|---|
| dead track | 404 | "Page not found" |
| dead album | 404 | "Page not found" |
| dead playlist | **400** | "Page not available" |
| live entity | 200 | the real title |

Hence `navStatus >= 400`, never `=== 404`: a dead playlist answers **400**, and
a rule written against 404 alone would classify every dead playlist as a
scraper failure.

Two things fall out of this beyond correctness. A dead entity is now rejected
straight after navigation, skipping a scroll loop and its three-second settle
on a page with no list to page through — measured at 1040ms against 4146ms.
And the failure is finally *counted*: `recordFailureMetrics` returns early for
`NotFoundError`, so while a silent extraction was reported as absence, total
extraction failure recorded **zero** failures while answering 404 to
everything.

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

## Partial listings are a policy choice, not an extraction change

The completeness *check* above — declared total against items seen — is
untouched. What changed is what happens when it fails: a shortfall used to
throw `ExtractionIncompleteError` straight out of `runExtraction`; it now
comes back as an ordinary `Album` or `Playlist` with `complete: false`, and
`declaredItems` carrying Spotify's own total. `runExtraction` reports a fact;
`server.ts` decides what the fact means. `ExtractionEmptyError` keeps its
throw deliberately — zero tracks is not a partial listing, it is extraction
that stopped matching Spotify's page, the same failure the five-error table
exists to catch.

**Why partials are opt-in.** A truncated playlist looks exactly like a
complete one — that sentence opens the section above, and it is the whole
argument here too. Serving `complete: false` listings as plain 200s by
default would hand every consumer that doesn't know to check `complete` the
exact silent shortfall this service exists to rule out; that consumer is not
hypothetical, it's every caller written before this field existed. So the
default stays what it was: no flag, a short listing still 502s
`extraction_incomplete`. `?partial=allow` on `/v1/album/:id` and
`/v1/playlist/:id` opts a caller in per request, not per deployment — the
choice has to stay visible at the call site, because a server-wide setting is
exactly the kind of thing that gets turned on once and forgotten.

**Why a cached partial is refused for a strict caller, not 502'd from cache.**
`ExtractionIncompleteError` was never cached, for the reason given above under
"Why the TTL is seconds": caching a failure that's a statement about *us*
means caching our own bugs, and a fixed pagination bug would otherwise keep
serving the old shortfall until the entry expired. Now that a shortfall is a
value instead of a throw, it *is* cacheable — an opt-in caller benefits from
not re-scraping — but caching it for a strict caller too would quietly
reopen exactly that hole: a fixed bug's result sitting behind a cache hit,
never re-produced, for up to `TTL_PLAYLIST`. `withCache`'s `acceptsCached`
predicate is how a strict caller keeps the retry path the never-cache rule
protected: a cached partial reads as a miss to it, so it re-produces, 502s if
still short, and refreshes the cached partial on the way past — which the
next opt-in caller benefits from. No worse than before, where every strict
request re-scraped unconditionally; better, because now an opt-in caller
downstream of a strict retry is more likely to find a fresher or complete
entry waiting.

**The scroll loop's new status: fallback, not dead code.** In-page pagination
(next section) replaces scrolling as the normal path — a browser that hands
back a reusable pathfinder request template pages by offset instead of
hoping a scroll gesture provokes the next batch. Two distinct degraded paths
sit beneath that, and they are not the same failure, so they cannot share one
explanation:

- **No template to page with.** The page never issued a windowed pathfinder
  query worth repeating, and that is decided once, up front — before the
  pagination loop runs at all, not partway through it. *This* is what the
  scroll loop is still for: the fallback for a page that gave us nothing to
  harvest, and the reason it stayed rather than being deleted.
- **A window fails mid-loop.** Navigation drops, or a token expires between
  fetches. This does **not** fall back to scrolling — a session and a
  template already exist; what is missing is one window's data, which
  scrolling cannot recover. `recordResponses` instead breaks out of the
  pagination loop and lets whatever pages already arrived flow through as a
  short `recorded` list, which `normalize` reports as `complete: false`. This
  is the case pagination cannot rule out, and it is why partial handling and
  pagination shipped as independent changes, in that order: pagination
  narrows *how often* a listing comes back short, but a mid-loop failure is
  exactly the shortfall it cannot prevent, which is what keeps the
  partial-listing policy above load-bearing after pagination lands. A caller
  that only ever saw complete listings while testing against small playlists
  would conclude partials were now unreachable and be wrong the first time a
  window fails.

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
all `Track`s. A real user's playlist is not. It holds at least three kinds:

| `itemV2.__typename` | `data.__typename` | Has `artists`? | id in `uri`? | Duration field |
|---|---|---|---|---|
| `TrackResponseWrapper` | `Track` | yes | yes | `trackDuration` |
| `EpisodeOrChapterResponseWrapper` | `Episode` | **no** | **yes** | `episodeDuration` |
| `LocalTrackResponseWrapper` | `LocalTrack` | **no** | **no** | `localTrackDuration` |

### Episodes are admitted; local files cannot be

An `Episode` lacks only an `artists` array — it has a real id, a real name,
and its show at `podcastV2.data.name`. `trackFromEpisode` uses the show as
both artist and album, so "Darknet Diaries — 178: Ubiquiti" reaches a
consumer as a resolvable query. Its `url` points at `/episode/`, not
`/track/`: the id is an episode id, and a `/track/` URL built from it 404s.

A `LocalTrack` genuinely has no Spotify identity. Its uri is
`spotify:local:<artist>:<album>:<title>:<seconds>` and **the id position is
empty**, so `idFromUri` correctly returns null. There is nothing to resolve.

The uri's other segments are real, though. Measured on
`spotify:local:::Ezra+Pound+%283%29+Poems:141`: six colon-separated parts,
the title URL-encoded, and the trailing number the duration in seconds — it
matched `localTrackDuration.totalMilliseconds` exactly on both files tested.
Slots 2 and 3 are artist and album.

Both were empty on the account tested, and `artistName`/`albumName` came back
`""` to match — so Spotify had no artist or album for these particular files
when they were added. That is a property of the files, not of the transport:
a local track added *with* artist and album tags should carry them here.
Untested, and worth confirming before anything is built on it.

### `unresolvedItems`

`Playlist` and `Album` both carry `unresolvedItems`: how many items Spotify
listed that could not be represented as a `Track`.

Without it the drop is silent, and a consumer cannot tell a two-track playlist
from a four-item one it could only half resolve — the same shape of silence
this service exists to remove. `tracks.length + unresolvedItems` always equals
the item count seen.

`Album` carries it for symmetry and because the same thing can happen there:
`normalize.ts` drops any item with no name or no artists.

### Completeness is measured separately

`playlistItemCount` counts raw items seen, not tracks that survived — so this
playlist reports 4 seen against 4 declared and passes.

This is exactly why that distinction exists. Were completeness measured on
`tracks.length`, any playlist containing a podcast or a local file would raise
`ExtractionIncompleteError` on every request and, because that error is never
cached, **fail forever**.

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
500. It waits only until its deadline, though (below).

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

### The pool owns the deadline, not the holder

Until 0.4.1, `produceBudgetMs` only answered the caller. `withBudget` rejected
on time, and its comment said the work "runs to completion in the background,
including its own `lease.release()`, so the lease still returns to the pool."
That assumed every step of an extraction ends eventually. One did not.
`await Promise.all(bodies)` waited for every JSON body the page had started,
and a body whose headers arrive but whose stream stalls leaves Playwright's
`response.json()` pending for as long as the page lives.

**Production, 2026-09-19.** Each such hang lost one context for good. The
first was on 09-15; the service kept working on the other one. The second, at
11:59, emptied the pool of two. From then on every request of every kind, a
single track included, sat in `acquire()` until the budget ran out, and came
back 504 after exactly 150 seconds. The container idled at about 1% CPU, and
`/health` answered "ok" throughout, because a context held by a hung lease is
still live. A restart fixed it at once. Across the container's lifetime the
number of `ExtractionTimeoutError`s was exactly the number of contexts lost.

Off-the-shelf pools were checked first. generic-pool and tarn bound acquire
and destroy, but their evictors only touch *idle* resources, so neither can
take one back from a borrower that hangs. Crawlee's browser-pool bounds its
own operations; the per-request timeout lives in its crawler, not its pool.
puppeteer-cluster has the right idea, closing the job's context when its
timeout fires, but it is Puppeteer-only and makes a fresh context per job. So
the pattern was adopted here rather than the dependency.

**The pattern is cancellation by destroying what the work holds.** Playwright
cannot abort an in-flight call, but closing a context rejects every call
pending on it ("Target page, context or browser has been closed"). So
`extract()` makes one `AbortSignal` from the budget and passes it to
`acquire()`, and the pool uses it three ways:

- **A queued caller whose deadline passes leaves the queue.** Left in it, it
  would be handed the next free context after it had stopped listening, ahead
  of a caller still waiting.
- **A lease still held at the deadline is revoked.** The pool closes its
  context and a fresh one takes the slot, *without waiting for the holder*.
  The holder's pending calls reject, and its eventual `release()` is a no-op.
  Revocation does not rely on the holder unwinding, because a holder can also
  be waiting on a plain timer, which closing a page does not interrupt.
- **A close gets `CONTEXT_CLOSE_TIMEOUT_MS`.** Every close is on a release
  path, so a wedged renderer holding `close()` open would hold the slot the
  same way. Past the limit, the context is abandoned and replaced.

The budget remains a backstop. The steps that had no bound now have one: the
body wait and each pagination window's in-page `fetch` both take
`ENTITY_DATA_TIMEOUT_MS`. A stalled body now costs seconds and leaves the
listing it did get, rather than costing the whole budget and the lease.
`sleevenote_pool_contexts` and `sleevenote_pool_waiting` make a starved pool
visible from outside.

### Generations: surviving the browser itself

A **generation** is one Chromium process plus the contexts made from it,
moving through `starting → serving → draining → closed`. It is `starting`
only while it launches and fills to `POOL_SIZE` contexts; a browser that dies
during that fill is reported as a failed launch, not a crash, because nothing
outside the launch has seen it yet. Promotion makes it `serving`, and
**exactly one generation ever serves at a time** — every new lease comes from
it, and a caller already queued when the serving generation changes is served
by whichever one replaces it, without seeing the switch.

The browser is launched with `launchServer()` rather than `launch()`, because
only `launchServer()` hands back the child process — the pid the manager
measures, the `exit` event it watches, and the target of the `SIGKILL` a
browser that ignores `close()` eventually gets (`src/browser-process.ts:49-54`).
The manager drives it over a loopback WebSocket through `connect()`. A probe
against Playwright 1.62.1 measured a SIGKILLed process firing its own `exit`
event 5 ms later, and the browser's `disconnected` event 14 ms later — both
well inside the 1 s a failing extraction is given to find out whether its
lease was lost, before it is judged on its own error instead (`LOST_GRACE_MS`,
`src/extract.ts:191`). Full numbers and the rest of the design:
[the browser context manager spec](docs/superpowers/specs/2026-09-19-browser-context-manager-design.md).

**Recycling is blue/green, not stop-the-world.** A recycle launches the
replacement generation and fills it to `POOL_SIZE` before the serving pointer
moves; only then does the old generation start draining, closing its idle
contexts at once and each leased one as its lease ends. The cost is a few
seconds of roughly **2× browser memory** — a single browser has been measured
at 1.3 GB against a 7.7 GB production host — bought back by the fact that no
caller ever waits on a recycle.

**Memory is measured as PSS, not RSS.** Summing RSS across a Chromium process
tree counts every shared page once per process, which overstates the tree by
a large and varying amount — not something a threshold could trust.
`/proc/<pid>/smaps_rollup`'s `Pss` divides each shared page among the
processes that map it, so a tree's PSS actually adds up
(`src/procmem.ts:54-70`). A process missing `smaps_rollup` — a pre-4.14
kernel, or a permissions quirk — falls back to `VmRSS`.

**A crash triggers relaunch with exponential backoff:** 1 s, 2 s, 4 s, …
capped at 30 s (`src/browser.ts:145-146,186-188`). After
`BROWSER_MAX_RELAUNCH_FAILURES` (default 5, `src/config.ts:111`) failures in a
row, the manager calls `onFatal` once and stops trying (`src/browser.ts:461-467`);
`index.ts` exits the process so the container restart policy gives it a clean
start (`src/index.ts:35-46`). Exiting beats answering 503 forever, because
neither stack has a healthcheck on sleevenote — a process that stays up but
broken is an outage nobody is told about.

**Overload answers 503 under two distinct codes.** `overloaded` means every
context stayed busy for `POOL_WAIT_CAP_MS`; `browser_unavailable` means the
browser died mid-lookup or is being relaunched. They are kept apart because
they call for different operator responses — raise `POOL_SIZE`, or go read
the crash logs — the same reason this service keeps its four extraction
failures apart. Both carry `Retry-After: 5` (`src/server.ts:390-401`).

**The wait cap's default follows the budget, not a fixed number.** Left
unset, `POOL_WAIT_CAP_MS` is
`Math.max(1, Math.min(20000, Math.floor(PRODUCE_BUDGET_MS / 2)))`
(`src/config.ts:61-64`). Set explicitly at or above `PRODUCE_BUDGET_MS`,
`loadConfig` throws (`src/config.ts:65-69`) — a cap there could never fire,
and the misconfiguration would otherwise be silent. A fixed default with the
same check would instead break any deployment that shortened the budget
without ever hearing of this knob.

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

## What the logs say, and why there were none

The service shipped with `Fastify()` and no logger option, whose default is
`logger: false`. That makes `app.log` a no-op — so `index.ts`'s startup line,
its shutdown lines, and every error inside a request went nowhere. A deployed
instance produced an empty `docker logs`, and a lookup that failed left nothing
behind to read. Diagnosing one meant reproducing it.

Two lines now come out of a request.

**`request completed`** — one per request, from an `onResponse` hook, carrying
method, url, status, `durationMs` and the `X-Cache` disposition. Fastify's own
incoming/completed pair is suppressed (`LogController({ disableRequestLogging:
true })`) so this is the only one: a request is one line, and `cache` next to
`durationMs` makes a cache hit distinguishable from a resolve at a glance.

**`extraction failed`** — when an extraction throws, carrying `kind`, `id`, the
error class, and `evidence`.

`evidence` is the point. `normalizeByKind` returning `null` currently becomes a
`NotFoundError`, which the HTTP layer answers 404 and negative-caches for
`TTL_NEGATIVE`. But `null` covers two very different situations: Spotify said
the entity is gone, and *we captured nothing at all*. A live playlist was served
as "not found" because the second was reported as the first — and, being
negative-cached, stayed that way for ten minutes.

`ExtractionEvidence` records what the capture actually saw — how many JSON
responses, which distinct statuses, which distinct paths. `recorded: 0` is the
signature of a capture that saw nothing, which is our failure and not evidence
of absence. Every throw inside `runExtraction` carries it, so a line *without*
evidence means one of exactly two things: a failure relayed to a waiter (see
"The failure relay" — `reviveFailure` rebuilds from a wire form that does not
carry the capture; read the holder's own line instead), or a timeout, which is
rejected from outside the extraction and never had one.

Splitting those two cases onto different status codes is the next change. This
one exists so that split is written against observed evidence rather than a
guess about what Spotify's page emits for a deleted id.

## Wait for the data, not for the page to go quiet

`recordResponses` navigates, then scrolls, then settles for three seconds, and
returns whatever JSON it captured along the way. For a long time that treated
`networkidle` plus the settle as a stand-in for "the entity query has arrived".
It is not one, and a production log caught the difference:

```json
{"kind":"playlist","id":"6FPDTIEcrb6EXUuWX2kBJz","error":"ExtractionSilentError",
 "evidence":{"navStatus":200,"recorded":21,"statuses":[200],
   "paths":["/cdn/generated-locales/web-player/en.aab0b7e4.json","/api/token","/",
            "/api/114855/envelope/","/v1/clienttoken",
            "/remote-config-resolver/v3/unauth/configuration",
            "/gabo-receiver-service/public/v3/events","/consent/50da44be-.../....json"]}}
```

Twenty-one responses captured, and not one of them the pathfinder query. Every
path is first-run bootstrap: locale bundle, access token, client token, remote
config, telemetry, consent. That is a **cold browser context** completing its
handshake, and it consumed the entire window the extraction was watching.

### The failing request was FASTER, and that is not a paradox

The cold request took 5.3s and failed; the next one, on the warm context, took
11.4s and succeeded. That looks backwards until you notice that **the failing
path is systematically cheaper**, in two of the three phases:

| phase | failed | succeeded |
|---|---|---|
| `goto` → networkidle | shorter: the entity query, and everything it cascades, never happened | longer: real fetch, then render |
| scroll loop | **1 iteration, ~350ms** | **4 iterations, ~1420ms** |
| settle | 3000ms | 3000ms |
| total | **5286ms** | **11415ms** |

The scroll loop is the clean half. It hunts for a scrollable container and
gives up on the first pass if there is not one:

```js
if (!best) return true   // nothing scrollable -> exhausted -> loop exits
```

No data means nothing renders, nothing renders means nothing scrolls, and the
loop costs one 350ms iteration instead of four. Measured against the live site:
a rendered playlist gives 4 iterations / 1421ms, a dead page 1 / 353ms.

Warmth's own cost points the *other* way, which is worth knowing before
reaching for it as an explanation. On a host where the cold context does get
its data in time, cold is **slower**, and the whole difference sits in `goto`:

| | goto | scroll | total |
|---|---|---|---|
| cold, succeeded | 4152ms | 4 iters / 1417ms | 8569ms |
| warm, succeeded | 2736ms | 4 iters / 1417ms | 7153ms |

So there are two independent effects: warmth is worth about 1.4s of `goto`, and
success versus failure is worth the scroll loop plus the entire data cascade.
In production the second dominated and inverted the ordering.

**Duration is not a signal of success.** That is why the earlier failures at
5.7s and 6.3s sat below the successes at 8.5-13s and looked like a pattern, and
it is why any "call back in N seconds" estimate has to be computed over
successful extractions only -- including failures drags the number down exactly
when the service is degrading.

This is why `/spotify` "failed the first time and worked the second". It was
never random: `CONTEXT_MAX_USES` recycles contexts, so the first extraction
after every recycle, and after every restart, met a cold context.

The fix is to wait for the response the normalizers actually read —
`PATHFINDER_URL`, exported from `normalize.ts` for exactly this — before
entering the scroll loop. The promise is created *before* `goto`, so a response
that arrives mid-navigation still counts; waiting on it afterwards would
otherwise hang for the full timeout.

`ENTITY_DATA_TIMEOUT_MS` bounds that wait, and is deliberately its own knob at
15s rather than borrowing the 45s `NAV_TIMEOUT_MS`. The wait covers the gap
between "the page went quiet" and "the data arrived"; a page that will never
produce entity data must still be able to say so quickly, and reusing the nav
timeout made every genuinely silent extraction cost 45 seconds. Three existing
tests timed out the moment it did, which is how that got caught.

### Warming contexts was tried, measured, and removed

The obvious companion fix is to warm each context at creation — load
`open.spotify.com` once so the bootstrap happens off the request path. It was
implemented and then deleted, because the measurements did not support it:

| | pool creation | first extract | total |
|---|---|---|---|
| warmed | 817 / 719 ms | 7733 / 7617 ms | 8550 / 8336 ms |
| cold | 120 / 66 ms | 8147 / 8292 ms | 8267 / 8358 ms |

It saved ~600ms on the first extraction and cost ~750ms to perform — a wash.
Worse, the cost lands in the wrong place: `recycle()` runs inside
`releaseRecord`, which `runExtraction` awaits in its `finally`, so warming
would be paid by the *recycling request itself*, with the warm-up timeout as a
worst-case tail. It moves latency onto the request path rather than off it.

The wait above is sufficient on its own: with it, a cold context's first
extraction succeeds. If warming is ever revisited, it needs to happen somewhere
that is genuinely off the request path.

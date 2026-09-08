# Partial Listings, In-Page Pagination, and Track Fan-Out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a partly-recovered Spotify listing serveable to a caller that asks for it, replace the scroll heuristic that causes the shortfall with deterministic pagination, and cache the individual tracks a listing already contains.

**Architecture:** Extraction stops throwing on a shortfall and instead marks the listing `complete: false`; the route decides 200-or-502 from that plus a `?partial=allow` flag. Pagination is driven by pathfinder queries issued from inside the already-authenticated page, whose responses land in the same `Recorded[]` corpus the scroll path filled, so `normalize.ts` and every fixture test are untouched. Fan-out is a best-effort write after a successful produce.

**Tech Stack:** TypeScript (ESM, `"type": "module"`, node >= 22), Fastify 5, Playwright, ioredis, vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-partial-listings-and-in-page-pagination-design.md`

## Global Constraints

- Imports use the `.js` extension even for `.ts` sources (ESM + `tsc`). Follow the existing style exactly.
- Tests are vitest: `npm test` runs `vitest run`. A single file: `npx vitest run tests/<file> -t '<name>'`.
- `docs/design-notes.md` is the reasoning record. Any decision that reverses or qualifies something written there gets a note added in the same voice.
- Never compare a declared total against `result.tracks.length`. Compare against items *seen* — `tracks.length + unresolvedItems`. This rule is load-bearing and explained in design-notes' "Completeness" section.
- `unresolvedItems` means "seen but not representable as a Track". It never means "not seen".
- Existing fixtures in `tests/fixtures/` and `docs/examples/` are a recorded wire contract. Add to them; do not edit one to make a test pass.
- Every commit ends with:
  `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types.ts` | Wire shapes | Add `declaredItems`, `complete` to `Album` and `Playlist` |
| `src/normalize.ts` | Recorded JSON → wire shapes | Populate the two new fields |
| `src/extract.ts` | Drive the page, decide failures | Stop throwing on shortfall; harvest a request template; paginate |
| `src/cache.ts` | Cache policy | Add `acceptsCached` predicate |
| `src/fanout.ts` | **new** — derive cacheable track records from a listing | — |
| `src/server.ts` | HTTP surface | `?partial=allow`; call fan-out after a produce |
| `src/metrics.ts` | Counters | Add `partialListings` |

---

## Phase 1 — Opt-in partial listings

### Task 1: `declaredItems` and `complete` on the wire

**Files:**
- Modify: `src/types.ts`
- Modify: `src/normalize.ts` (inside `normalizeAlbum`, `normalizePlaylist`)
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Consumes: `albumTotalCount(recorded, id)`, `playlistTotalCount(recorded, id)` — both already exported from `src/normalize.ts`, both return `number | null`.
- Produces: `Album.declaredItems: number | null`, `Album.complete: boolean`, and the same two on `Playlist`.

- [ ] **Step 1: Write the failing test**

Add to `tests/normalize.test.ts`, using the builders already at the top of that
file: `albumTrackItem(trackId, name, trackNumber, discNumber?)`,
`albumEntityResponse(id, totalCount, items)` and `fixture(name)`. Do not add a
new harness.

```ts
describe('completeness fields', () => {
  const id = 'complete-test'

  it('reports a complete album as complete, with the declared total', async () => {
    // The recorded album fixture is id 6ymZBbRSmzAvoSGmwAFoxm; the rest of
    // this file uses that pairing.
    const album = normalizeAlbum(await fixture('album'), '6ymZBbRSmzAvoSGmwAFoxm')!
    expect(album.declaredItems).toBe(album.tracks.length + album.unresolvedItems)
    expect(album.complete).toBe(true)
  })

  it('marks a short capture incomplete', () => {
    // Declares three, records one. This is what a truncated capture is.
    const recorded = [albumEntityResponse(id, 3, [albumTrackItem('t1', 'One', 1)])]
    const album = normalizeAlbum(recorded, id)!
    expect(album.declaredItems).toBe(3)
    expect(album.tracks).toHaveLength(1)
    expect(album.complete).toBe(false)
  })

  it('counts a validation-dropped item as seen, not as a shortfall', () => {
    // The rule design-notes calls load-bearing: an item normalize refuses
    // still COUNTS as seen. Comparing declaredItems against tracks.length
    // would call this *complete* extraction incomplete -- and because that
    // used to throw an error that was never cached, it failed forever.
    const nameless = albumTrackItem('t2', '', 2)
    const recorded = [albumEntityResponse(id, 2, [albumTrackItem('t1', 'One', 1), nameless])]
    const album = normalizeAlbum(recorded, id)!
    expect(album.tracks).toHaveLength(1)
    expect(album.unresolvedItems).toBe(1)
    expect(album.complete).toBe(true)
  })

  it('is complete when Spotify declared no total, because we cannot tell', () => {
    const recorded = [albumEntityResponse(id, 1, [albumTrackItem('t1', 'One', 1)])]
    // Strip the declared total the way a page that never reported one leaves it.
    delete ((recorded[0].body as any).data.albumUnion.tracksV2).totalCount
    const album = normalizeAlbum(recorded, id)!
    expect(album.declaredItems).toBeNull()
    expect(album.complete).toBe(true)
  })
})
```

If `albumEntityResponse` nests `totalCount` somewhere other than
`albumUnion.tracksV2`, follow the builder rather than this snippet — read it
first. The assertion that matters is `declaredItems === null`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/normalize.test.ts -t 'completeness fields'`
Expected: FAIL — `declaredItems` is `undefined`.

- [ ] **Step 3: Implement**

In `src/types.ts`, add to **both** `Album` and `Playlist`:

```ts
  // Spotify's own declared total, or null when the page declared none.
  // Evidence for `complete`; kept so a consumer can say "25 of 50" rather
  // than only "incomplete".
  declaredItems: number | null
  // Whether every declared item was seen. Derivable from the fields above,
  // and sent anyway so the rule -- including "declared nothing, so we cannot
  // claim a shortfall" -- lives in one place rather than in each consumer.
  complete: boolean
```

In `src/normalize.ts`, inside `normalizeAlbum`, where the `Album` object is returned (near line 265), compute before the return:

```ts
  const declaredItems = albumTotalCount(recorded, id)
  // Seen, not well-formed: an item validation dropped was still seen.
  const seen = tracks.length + unresolvedItems
  const complete = declaredItems === null || seen === declaredItems
```

and add `declaredItems,` and `complete,` to the returned object. Do the same in
`normalizePlaylist` (near line 440) using `playlistTotalCount`.

The tests above build their captures with the file's own builders. Do not add
files under `tests/fixtures/` — those five are recordings of the live service,
and a hand-written one is not a recording.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/normalize.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/normalize.ts tests/normalize.test.ts
git commit -m "feat: report declared totals and completeness on a listing

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 2: Extraction stops throwing on a shortfall

**Files:**
- Modify: `src/extract.ts` (the two `ExtractionIncompleteError` throws in `runExtraction`, ~line 275-300)
- Test: `tests/extract.test.ts`

**Interfaces:**
- Consumes: `Album.complete` / `Playlist.complete` from Task 1.
- Produces: `runExtraction` returns a short listing rather than throwing. `ExtractionIncompleteError` remains exported and unchanged.

- [ ] **Step 1: Write the failing test**

`tests/extract.test.ts` builds captures with `playlistItem(trackId, name)` and
`playlistPageResponse(...)` — read both before writing, and use them.

The shortfall is now decided in `normalize`, not in `extract`, so the
behavioural assertion at this layer is that a short capture **no longer
throws**:

```ts
it('returns a short listing instead of throwing, marked incomplete', () => {
  const id = '37i9dQZF1DXcBWIGoYBM5M'
  // Declares four, records two: the shape a truncated scroll produces.
  const recorded = [playlistPageResponse(id, 4, 0, [playlistItem('t1', 'One'), playlistItem('t2', 'Two')])]
  const pl = normalizePlaylist(recorded, id)!
  expect(pl.tracks).toHaveLength(2)
  expect(pl.declaredItems).toBe(4)
  expect(pl.complete).toBe(false)
})
```

Then find every existing test in the suite that asserts
`ExtractionIncompleteError` is thrown and rewrite it to assert
`complete === false` on the returned listing. Those are the same behavioural
claim relocated, so they should be edited rather than deleted — if one cannot
be restated that way, stop and report it.

`ExtractionEmptyError` keeps its throw and its tests unchanged: a listing with
zero tracks is not a partial listing, it is extraction that stopped matching.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract.test.ts -t 'short listing'`
Expected: FAIL — throws `ExtractionIncompleteError`.

- [ ] **Step 3: Implement**

Delete both `if (result.type === 'album') { ... }` and `if (result.type === 'playlist') { ... }` shortfall blocks from `runExtraction`. Replace them with a single comment:

```ts
    // A shortfall is no longer a failure here. `normalize` records it on the
    // result as `complete: false` and the route decides what it means: a
    // caller that asked for partials gets the listing, one that did not gets
    // the 502 this used to throw. Extraction reports; policy is the caller's.
    //
    // ExtractionEmptyError above keeps its throw deliberately -- zero tracks
    // is not a partial listing, it is extraction that stopped matching.
```

Leave `ExtractionIncompleteError` and its `failureCodec` mapping in place: a
rolling deploy can still relay one from an older holder through the cache's
failure channel, and the route must keep understanding it.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS except any pre-existing test asserting the old throw. Update those to assert the new return — they are the same behaviour statement, moved.

- [ ] **Step 5: Commit**

```bash
git add src/extract.ts tests/extract.test.ts
git commit -m "feat: a shortfall marks the listing, it does not fail the extraction

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 3: `acceptsCached` predicate

**Files:**
- Modify: `src/cache.ts` (`withCache` opts; the freshness check, the waiter poll, the stale-on-error fallback)
- Test: `tests/cache.test.ts`

**Interfaces:**
- Produces: `withCache` accepts `acceptsCached?: (value: T) => boolean`. Omitted means every entry is acceptable — existing callers are unaffected.

- [ ] **Step 1: Write the failing test**

```ts
describe('acceptsCached', () => {
  it('treats an unacceptable cached entry as a miss and re-produces', async () => {
    const store = new MemoryStore()
    let produced = 0
    const produce = async () => ({ complete: ++produced > 1 })
    // Seed a partial.
    await withCache({ store, key: 'k', ttlSeconds: 60, now: 0, produce })
    expect(produced).toBe(1)
    // A strict caller must not be served it.
    const strict = await withCache({
      store, key: 'k', ttlSeconds: 60, now: 1, produce,
      acceptsCached: (v: any) => v.complete !== false,
    })
    expect(produced).toBe(2)
    expect(strict.value.complete).toBe(true)
  })

  it('serves the same entry to a caller that accepts it', async () => {
    const store = new MemoryStore()
    let produced = 0
    const produce = async () => ({ complete: false, n: ++produced })
    await withCache({ store, key: 'k', ttlSeconds: 60, now: 0, produce })
    const relaxed = await withCache({ store, key: 'k', ttlSeconds: 60, now: 1, produce })
    expect(produced).toBe(1)
    expect(relaxed.hit).toBe('fresh')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/cache.test.ts -t 'acceptsCached'`
Expected: FAIL — first test sees `produced === 1`, the partial was served.

- [ ] **Step 3: Implement**

In `src/cache.ts`, add to the `withCache` opts type:

```ts
  /**
   * Whether a cached value answers *this* caller's question. A cached entry
   * that fails it is treated as a miss, so the caller produces rather than
   * being handed something it did not ask for. Omitted means anything cached
   * will do, which is what every caller wanted before partial listings
   * existed.
   */
  acceptsCached?: (value: T) => boolean
```

Destructure with a default of `() => true`, then gate all three read paths.
Applying it in only one place is the bug this design invites, so all three are
named here:

1. the initial `if (existing && isFresh(...))`,
2. the waiter loop's `if (candidate && isFresh(...))`,
3. `produceAndCache`'s stale-on-error `if (found)` — pass the predicate in as a
   parameter; an entry the caller has already refused is not a fallback for it,
   so when it fails the predicate, rethrow the produce error instead.

Also gate the waiter's post-failure `readEntry` fallback, which is the fourth
read and the easiest to miss.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS. Every existing `withCache` caller omits the predicate and is unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts tests/cache.test.ts
git commit -m "feat: let a caller refuse a cached value it did not ask for

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 4: `?partial=allow` on the route

**Files:**
- Modify: `src/server.ts` (`handleEntity`, and the route registration that calls it)
- Modify: `src/metrics.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `acceptsCached` (Task 3), `complete` (Task 1).
- Produces: the documented request/response contract.

- [ ] **Step 1: Write the failing test**

```ts
it('502s a short listing by default', async () => {
  const app = server(async () => shortPlaylist())      // complete: false
  const res = await app.inject({ url: '/v1/playlist/abc' })
  expect(res.statusCode).toBe(502)
  expect(res.json().error).toBe('extraction_incomplete')
})

it('serves a short listing to a caller that asked for one', async () => {
  const app = server(async () => shortPlaylist())
  const res = await app.inject({ url: '/v1/playlist/abc?partial=allow' })
  expect(res.statusCode).toBe(200)
  expect(res.json().complete).toBe(false)
  expect(res.json().declaredItems).toBe(50)
  expect(res.json().tracks).toHaveLength(25)
})

it('re-produces rather than serving a cached partial to a strict caller', async () => {
  const store = new MemoryStore()
  let calls = 0
  const extract = async () => { calls++; return calls === 1 ? shortPlaylist() : fullPlaylist() }
  const app = server(extract, store)
  await app.inject({ url: '/v1/playlist/abc?partial=allow' })   // caches the partial
  const res = await app.inject({ url: '/v1/playlist/abc' })     // strict
  expect(calls).toBe(2)
  expect(res.statusCode).toBe(200)
  expect(res.json().complete).toBe(true)
})

it('ignores the flag on a track, which has no listing', async () => {
  const app = server(async () => aTrack())
  const res = await app.inject({ url: '/v1/track/abc?partial=allow' })
  expect(res.statusCode).toBe(200)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/server.test.ts -t 'partial'`
Expected: FAIL — the query string is ignored and a short listing 200s.

- [ ] **Step 3: Implement**

Give `handleEntity` a `partialAllowed: boolean`. In the route registration read it from the query:

```ts
  fastify.get<{ Params: { id: string }; Querystring: { partial?: string } }>(
    `/v1/${kind}/:id`,
    async (req, reply) =>
      handleEntity(kind, req.params.id, req.query.partial === 'allow', req, reply),
  )
```

Pass the predicate to `withCache` — only for listing kinds, and only when the
caller did **not** opt in:

```ts
      // A track has no listing, so `complete` never appears on one and a
      // predicate would refuse every cached track forever.
      const strictListing = kind !== 'track' && !partialAllowed
      const result = await withCache({
        // ...existing options unchanged...
        acceptsCached: strictListing
          ? (v: unknown) => (v as { complete?: boolean }).complete !== false
          : undefined,
      })
```

Then, after the `staleError` handling and before returning `result.value`:

```ts
      const value = result.value as { complete?: boolean; declaredItems?: number | null; tracks?: unknown[] }
      if (value.complete === false) {
        partialListings.inc({ type: kind, served: partialAllowed ? 'yes' : 'no' })
        if (!partialAllowed) {
          // The listing is cached either way: an opt-in caller behind us gets
          // it without paying for the scrape again.
          reply.code(502)
          const seen = (value.tracks?.length ?? 0)
          return {
            error: 'extraction_incomplete',
            id,
            message:
              `${kind} ${id} saw ${seen} of ${value.declaredItems} declared tracks ` +
              `-- retry with ?partial=allow to take what was recovered`,
          }
        }
      }
```

In `src/metrics.ts`, add alongside the existing counters, following their style:

```ts
export const partialListings = new Counter({
  name: 'sleevenote_partial_listings_total',
  help: 'Listings that came back short, by whether the caller accepted one.',
  labelNames: ['type', 'served'] as const,
  registers: [registry],
})
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/metrics.ts tests/server.test.ts
git commit -m "feat: serve a partial listing to a caller that opts in

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

## Phase 2 — Pagination instead of scrolling

### Task 5: Harvest the pathfinder request template

**Files:**
- Modify: `src/extract.ts` (new exported helper + a request listener in `recordResponses`)
- Test: `tests/extract.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type QueryTemplate = {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>   // the full JSON post body, variables included
  }
  export function withOffset(template: QueryTemplate, offset: number, limit: number): QueryTemplate
  ```

- [ ] **Step 1: Write the failing test**

```ts
describe('withOffset', () => {
  const template = {
    url: PATHFINDER_URL,
    headers: { authorization: 'Bearer t' },
    body: {
      operationName: 'fetchPlaylist',
      variables: { uri: 'spotify:playlist:abc', offset: 0, limit: 25 },
      extensions: { persistedQuery: { sha256Hash: 'deadbeef' } },
    },
  }

  it('moves the window without disturbing anything else', () => {
    const next = withOffset(template, 25, 100)
    expect(next.body.variables).toMatchObject({ uri: 'spotify:playlist:abc', offset: 25, limit: 100 })
    expect(next.body.operationName).toBe('fetchPlaylist')
    expect(next.body.extensions).toEqual(template.body.extensions)
    expect(next.headers).toEqual(template.headers)
  })

  it('does not mutate the template it was given', () => {
    withOffset(template, 25, 100)
    expect(template.body.variables).toMatchObject({ offset: 0, limit: 25 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract.test.ts -t 'withOffset'`
Expected: FAIL — `withOffset` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * The first pathfinder request the page issues, kept so we can repeat it with
 * a different window. Everything that authenticates the call -- bearer token,
 * client token, persisted-query hash -- is already in it, which is why this is
 * harvested rather than constructed.
 */
export type QueryTemplate = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** The same query over a different window. Returns a copy; never mutates. */
export function withOffset(t: QueryTemplate, offset: number, limit: number): QueryTemplate {
  const variables = { ...(t.body.variables as Record<string, unknown>), offset, limit }
  return { url: t.url, headers: { ...t.headers }, body: { ...t.body, variables } }
}
```

In `recordResponses`, add a request listener beside the existing response one,
capturing the first pathfinder POST that carries an `offset` variable:

```ts
  let template: QueryTemplate | null = null
  const onRequest = (request: Request): void => {
    if (template !== null) return
    if (!request.url().startsWith(PATHFINDER_URL)) return
    let body: Record<string, unknown> | null = null
    try {
      body = request.postDataJSON() as Record<string, unknown>
    } catch {
      return   // Not JSON we can repeat.
    }
    const variables = body?.variables as Record<string, unknown> | undefined
    // Only a windowed query is worth repeating; an entity-header query has no
    // offset and paginating it would be meaningless.
    if (variables === undefined || variables.offset === undefined) return
    template = { url: request.url(), headers: request.headers(), body }
  }
  page.on('request', onRequest)
```

Detach it in the same `finally` that detaches `onResponse` — a listener left on
a pooled page is a per-lease leak, which is what that `finally` already exists
to prevent. Return `template` on the `Capture`.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract.ts tests/extract.test.ts
git commit -m "feat: harvest the page's own pathfinder query as a template

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 6: Paginate in-page; keep the scroll as fallback

**Files:**
- Modify: `src/extract.ts` (`recordResponses` — replace the scroll loop's role)
- Test: `tests/extract.test.ts`

**Interfaces:**
- Consumes: `QueryTemplate`, `withOffset` (Task 5).
- Produces: no signature change. `Capture.responses` is filled by pagination when a template was harvested, by scrolling when one was not.

- [ ] **Step 1: Write the failing test**

Pagination arithmetic is the part worth testing without a browser. Extract it
so it can be:

```ts
describe('pageOffsets', () => {
  it('walks the window to the declared total and stops', () => {
    expect(pageOffsets(50, 25, 0)).toEqual([25])          // 25 already seen
    expect(pageOffsets(150, 50, 0)).toEqual([50, 100])
    expect(pageOffsets(25, 100, 0)).toEqual([])           // one page covered it
  })

  it('is bounded even against an absurd declared total', () => {
    expect(pageOffsets(1_000_000, 1, 0).length).toBeLessThanOrEqual(MAX_PAGES)
  })

  it('asks for nothing when the total is unknown', () => {
    expect(pageOffsets(null, 25, 0)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/extract.test.ts -t 'pageOffsets'`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
// A ceiling on pages, not on tracks: a 10 000-track playlist is not something
// this service promises, and an unbounded loop against a number Spotify
// supplies is a denial of service it hands us.
export const MAX_PAGES = 40

/** The offsets still to fetch, given what the first response already covered. */
export function pageOffsets(total: number | null, limit: number, firstOffset: number): number[] {
  if (total === null || limit <= 0) return []
  const offsets: number[] = []
  for (let o = firstOffset + limit; o < total && offsets.length < MAX_PAGES; o += limit) {
    offsets.push(o)
  }
  return offsets
}
```

Then in `recordResponses`, after the `entityData` race resolves, branch:

```ts
    if (template !== null) {
      // Pagination: ask for the rest directly. Issued from inside the page so
      // the session, cookies and tokens are the page's own -- we repeat its
      // request, we do not construct one. Responses arrive through the same
      // `onResponse` listener, so nothing downstream can tell the difference.
      const vars = template.body.variables as Record<string, unknown>
      const limit = typeof vars.limit === 'number' && vars.limit > 0 ? vars.limit : 100
      const first = typeof vars.offset === 'number' ? vars.offset : 0
      const total = declaredTotalFrom(kind, recorded, id)   // null when not yet declared
      for (const offset of pageOffsets(total, limit, first)) {
        const next = withOffset(template, offset, limit)
        await page.evaluate(async (req) => {
          await fetch(req.url, {
            method: 'POST',
            headers: req.headers as Record<string, string>,
            body: JSON.stringify(req.body),
          })
        }, next as unknown as Record<string, unknown>)
      }
    } else {
      // No template to repeat: fall back to provoking the page into fetching
      // more by scrolling. This is the degraded path, and it is why partial
      // listings ship first -- it is the one that comes up short.
      ...existing scroll loop, unchanged...
    }
```

`recordResponses` does not currently know which kind it is fetching, so thread
`kind` and `id` in as parameters from `runExtraction`, which does, and add this
helper beside `pageOffsets`:

```ts
/**
 * Spotify's declared total for whichever entity is being fetched, or null
 * when nothing declared one yet. Reuses the same counters the completeness
 * check uses, so pagination and the verdict can never disagree about how many
 * items there are supposed to be.
 */
export function declaredTotalFrom(
  kind: 'track' | 'album' | 'playlist',
  recorded: Recorded[],
  id: string,
): number | null {
  if (kind === 'album') return albumTotalCount(recorded, id)
  if (kind === 'playlist') return playlistTotalCount(recorded, id)
  return null   // A track is one item; there is nothing to page through.
}
```

`albumTotalCount` and `playlistTotalCount` are already exported from
`src/normalize.ts`; `extract.ts` already imports from it.

- [ ] **Step 4: Run the suite, then verify against the live service**

Run: `npm test` → PASS.

Then the case this exists for. Build and run locally, and fetch the playlist
that fails today:

```bash
npm run build && node dist/src/index.js &
curl -s 'http://127.0.0.1:3000/v1/playlist/37i9dQZF1DXcBWIGoYBM5M' | head -c 400
```

Expected: a 200 with `"complete": true` and 50 tracks. If it is still short,
**stop and report** — the pagination is not doing what this task claims, and
the partial path from Phase 1 is masking it.

- [ ] **Step 5: Commit**

```bash
git add src/extract.ts tests/extract.test.ts
git commit -m "feat: page through a listing instead of scrolling for it

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

## Phase 3 — Fan-out caching

### Task 7: Derive cacheable track records from a listing

**Files:**
- Create: `src/fanout.ts`
- Test: `tests/fanout.test.ts` (new)

**Interfaces:**
- Produces: `export function tracksToCache(entity: Album | Playlist): Track[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { tracksToCache } from '../src/fanout.js'

describe('tracksToCache', () => {
  it('gives an album track the parent album it was listed without', () => {
    // `Track.album` is null on every track inside an Album, deliberately --
    // repeating the parent across 60 entries is noise. Cached verbatim that
    // is a track record that has lost its album, so it is filled in here.
    const album = {
      type: 'album', id: 'al1', name: '60 Original Hits', image: 'http://art',
      artists: [{ name: 'Elvis', id: 'a1' }], url: 'u', unresolvedItems: 0,
      declaredItems: 1, complete: true,
      tracks: [{ id: 't1', type: 'track', name: 'King Creole', artists: [{ name: 'Elvis', id: 'a1' }],
                 album: null, durationMs: 1, url: 'https://open.spotify.com/track/t1' }],
    } as any
    const [track] = tracksToCache(album)
    expect(track.album).toEqual({ name: '60 Original Hits', id: 'al1', image: 'http://art' })
  })

  it('leaves a playlist track alone, because it already carries its album', () => {
    const [track] = tracksToCache(playlistWithOneTrack())
    expect(track.album?.name).toBe('Oh Shit I\'m Feeling It')
  })

  it('skips podcast episodes, which are not tracks', () => {
    // A playlist can hold them. Their url is /episode/<id>, they are not a
    // valid /v1/track/:id response, and caching one under a track key would
    // answer a future track lookup with something that is not a track.
    expect(tracksToCache(playlistWithSongAndEpisode())).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/fanout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Album, Playlist, Track } from './types.js'

/**
 * The tracks from a listing that are worth caching under their own id.
 *
 * Enrichment is not optional. An album lists its tracks with `album: null`,
 * so storing them verbatim would put album-less records under keys that a
 * later `/v1/track/:id` reads. Because every writer produces an equivalent
 * record after enrichment, fan-out can overwrite freely and no
 * read-before-write is needed.
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/fanout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fanout.ts tests/fanout.test.ts
git commit -m "feat: derive cacheable track records from a listing

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 8: Write the fan-out after a produce

**Files:**
- Modify: `src/server.ts` (`handleEntity`, after `withCache` returns)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `tracksToCache` (Task 7), `cacheKey` and the `Entry<T>` shape from `src/cache.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it('caches each listed track under its own id', async () => {
  const store = new MemoryStore()
  const app = server(async () => albumWithTwoTracks(), store)
  await app.inject({ url: '/v1/album/al1' })
  const raw = await store.get(cacheKey('track', 't1'))
  expect(raw).not.toBeNull()
  expect(JSON.parse(raw!).value.name).toBe('King Creole')
})

it('does not fail the request when a fan-out write fails', async () => {
  // The listing is the answer. A cache write that did not happen is a missed
  // optimisation, not a failed lookup.
  const store = new MemoryStore()
  store.set = async () => { throw new StoreError('down') }
  const app = server(async () => albumWithTwoTracks(), store)
  const res = await app.inject({ url: '/v1/album/al1' })
  expect(res.statusCode).toBe(200)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/server.test.ts -t 'fan-out'`
Expected: FAIL — nothing is written under the track key.

- [ ] **Step 3: Implement**

In `handleEntity`, after the completeness handling and before returning the value:

```ts
      // Best effort, and deliberately not awaited into the response path's
      // error handling: a listing that arrived is the answer whether or not
      // its tracks got cached. Partial listings fan out too -- the tracks
      // that did arrive are real.
      if (kind !== 'track') {
        void fanOutTracks(value as unknown as Album | Playlist)
      }
```

and, in the same file:

```ts
  async function fanOutTracks(entity: Album | Playlist): Promise<void> {
    const storedAt = now()
    for (const track of tracksToCache(entity)) {
      try {
        await store.set(
          cacheKey('track', track.id),
          JSON.stringify({ value: track, storedAt }),
          cfg.ttl.track,
        )
      } catch (err) {
        // One failed write must not abandon the rest, and none of them must
        // reach the caller.
        fastify.log.debug({ id: track.id, err }, 'fan-out write failed')
      }
    }
  }
```

The `{ value, storedAt }` wrapper must match `cache.ts`'s `Entry<T>` exactly, or
`withCache` will read these back as corrupt and silently treat every one as a
miss — which looks like fan-out simply not working.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: cache a listing's tracks under their own ids

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 9: Documentation and the wire-contract examples

**Files:**
- Modify: `docs/design-notes.md`, `docs/captured-shapes.md`, `README.md`
- Modify: `docs/examples/album.json`, `docs/examples/playlist.json`

- [ ] **Step 1: Regenerate the published examples**

`docs/examples/*.json` is the contract a client builds against, so it must
show the new fields. Re-record them against the running service rather than
hand-editing:

```bash
npm run build && node dist/src/index.js &
curl -s http://127.0.0.1:3000/v1/album/5s5svl5DzlSmEvkjuL8Upw > docs/examples/album.json
```

Follow whatever `docs/examples/README.md` says about how these were produced.

- [ ] **Step 2: Add the reasoning notes**

In `docs/design-notes.md`, add a section after "Completeness: `seen`, not
`tracks.length`". It must say, in that document's voice:

- The completeness *check* is unchanged; what changed is that a shortfall is
  now reported rather than thrown, and the caller chooses.
- Why partials are opt-in: a truncated playlist looks exactly like a complete
  one, so serving them as plain 200s would have re-created the failure the
  check exists to catch for every consumer that does not know to look.
- Why a cached partial is refused for a strict caller rather than 502'd from
  cache: it keeps the retry path that the never-cache rule protected.
- The scroll loop's new status: fallback, not dead code, and the reason
  pagination does not remove the need for partials.

- [ ] **Step 3: Update the README**

Document `?partial=allow`, `declaredItems` and `complete` wherever the README
describes the endpoints.

- [ ] **Step 4: Verify the whole thing once more**

Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add docs README.md
git commit -m "docs: record the partial-listing contract and why it is opt-in

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

## Done means

- `/v1/playlist/37i9dQZF1DXcBWIGoYBM5M` returns 200 with 50 tracks and `complete: true`.
- Without `?partial=allow`, a genuinely short listing still 502s.
- `npm test` passes.
- A `/v1/track/:id` for a track that was in a fetched album is a cache hit carrying its album.

## Follow-ups (do not do here)

- `crack-sleevenote`: model `declaredItems` / `complete`, add a `partial` request flag.
- `cracktunes`: opt in, and word the "queued 25 of 50" message.

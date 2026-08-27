# sleevenote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless HTTP service that resolves a Spotify track, album or playlist id to normalized metadata by driving headless Chromium and reading the JSON the page itself fetches, cached aggressively in Redis.

**Architecture:** Playwright drives a pool of persistent Chromium contexts. Each request navigates to the entity page and intercepts the JSON responses the page's own JavaScript fetches from Spotify's internal API; a pure normalizer converts those into our published model. Redis holds the cache, the single-flight locks, and nothing else — the service itself is stateless and horizontally scalable. Auth and rate limiting are deliberately absent; they belong to a load balancer in front.

**Tech Stack:** TypeScript (ESM, strict), Node 22 LTS, Playwright, Fastify, ioredis, prom-client, Vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-08-27-sleevenote-design.md`

## Global Constraints

- **No provider API key, ever.** If a task finds itself wanting Spotify credentials, it has gone wrong.
- **The service is stateless.** All shared state lives in Redis. No module-level mutable caches, no on-disk state.
- **No auth, rate limiting, quotas or multi-tenancy inside the service.** Those belong to a load balancer.
- **Never parse HTML, and never select on CSS classes.** Extraction reads intercepted JSON only. Spotify's class names are hashed and churn between deploys; this rule is the whole reason the prior art died.
- **`/health` returns exactly `sleevenote ok`** with `Content-Type: text/plain`, and only when Redis is reachable AND the browser pool has at least one live context.
- **A scrape yielding zero tracks is an error, never a valid empty result.** It increments a distinct counter and never populates the cache.
- **The offline test suite must pass with no network access.** Tests requiring network SKIP with a stated reason and the date of the last measured pass — they never FAIL for want of network.
- **Cache TTLs:** track 30d, album 30d, playlist 1–6h (use 4h), negative 5–15m (use 10m).
- Node 22 LTS. TypeScript `strict: true`. ESM (`"type": "module"`).
- Commit trailer on every commit, and no other `Co-Authored-By` line:
  `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | The published response model — `Track`, `Album`, `Playlist`. No logic. |
| `src/config.ts` | Env-driven configuration with defaults. Pure, no I/O. |
| `src/normalize.ts` | Raw captured payload → published model. **Pure functions only.** The heart of the offline suite. |
| `src/browser.ts` | Playwright context pool: acquire, release, recycle, resource blocking. |
| `src/extract.ts` | Navigate + intercept, hand raw payloads to `normalize`. |
| `src/cache.ts` | Cache policy: TTL selection, single-flight, stale-on-error. Storage-agnostic. |
| `src/store.ts` | `CacheStore` interface + `RedisStore` + `MemoryStore` (tests). |
| `src/metrics.ts` | prom-client registry, counters, histograms. |
| `src/server.ts` | Fastify routes, error→status mapping, `/health`, `/metrics`. |
| `src/index.ts` | Entrypoint: build config, wire everything, listen, shut down cleanly. |
| `tools/capture.ts` | Probe. Drives a real browser and records raw responses as fixtures. Not shipped. |
| `tests/fixtures/` | Recorded real responses. Committed. |

`cache.ts` is split from `store.ts` on purpose: the *policy* (which TTL, when to serve stale, how to coalesce) is the interesting logic and must be testable without Redis, while the *storage* is a thin adapter.

---

### Task 1: Scaffold, capture probe, and the fixture corpus

This task answers the spec's largest open risk — **whether interception returns a whole playlist or only its first page** — and produces the recorded responses every later test depends on.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `tools/capture.ts`
- Create: `docs/captured-shapes.md`
- Create: `tests/fixtures/` (populated by running the probe)

**Interfaces:**
- Consumes: nothing.
- Produces: `tests/fixtures/{track,album,playlist-small,playlist-large}.json` — each an array of `{ url: string, status: number, body: unknown }` recording every JSON response the page fetched. And `docs/captured-shapes.md`, describing where in those payloads the entity fields actually live. **Every later task reads that document; it is the contract for `normalize.ts`.**

- [ ] **Step 1: Initialise the project**

```bash
cd /home/lothrop/projects/sleevenote
npm init -y
npm pkg set type=module
npm pkg set engines.node=">=22"
npm install --save-dev typescript @types/node tsx vitest
npm install playwright
npx playwright install chromium --with-deps
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tools/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 5: Write the capture probe `tools/capture.ts`**

The probe records every JSON response a page fetches. It blocks images, fonts and media, exactly as the real extractor will, so what it records matches what production will see.

```ts
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'

type Recorded = { url: string; status: number; body: unknown }

const TARGETS: Record<string, string> = {
  // A well-known stable track.
  track: 'https://open.spotify.com/track/0c6xIDDpzE81m2q797ordA',
  album: 'https://open.spotify.com/album/6ymZBbRSmzAvoSGmwAFoxm',
  // Small: crosses one page boundary (measured totalCount 50).
  'playlist-small': 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  // Large: crosses several (measured totalCount 150). This is the pagination probe.
  'playlist-large': 'https://open.spotify.com/playlist/37i9dQZF1DX4o1oenSJRJd',
}

async function capture(name: string, url: string): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  const recorded: Recorded[] = []

  await page.route('**/*', (route) => {
    const type = route.request().resourceType()
    if (type === 'image' || type === 'font' || type === 'media') return route.abort()
    return route.continue()
  })

  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] ?? ''
    if (!ct.includes('json')) return
    try {
      recorded.push({ url: response.url(), status: response.status(), body: await response.json() })
    } catch {
      // A JSON content-type that does not parse is not interesting here.
    }
  })

  console.log(`[${name}] navigating to ${url}`)
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })

  // Drive the VIRTUALIZED CONTAINER, incrementally.
  //
  // Two things here are load-bearing and were each measured wrong first:
  //
  //   1. `page.mouse.wheel` fires at the cursor's position, which defaults to
  //      (0,0) -- outside the track list. It scrolls nothing at all.
  //   2. Jumping to the bottom (`scrollTop = scrollHeight`) skips the middle: a
  //      virtualized list only fetches what is near the viewport, so you get
  //      page 1 and the last page and nothing between them.
  //
  // Stepping by ~80% of the container's height requests every page in order.
  // Measured on a 150-track playlist: offset 0/25, 25/50, 75/50, 125/25 = 150.
  let exhausted = false
  for (let i = 0; i < 200 && !exhausted; i++) {
    exhausted = await page.evaluate(() => {
      let best: HTMLElement | null = null
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const e = el as HTMLElement
        if (e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 200) {
          if (!best || e.scrollHeight > best.scrollHeight) best = e
        }
      }
      if (!best) return true
      const before = best.scrollTop
      best.scrollTop = Math.min(best.scrollTop + best.clientHeight * 0.8, best.scrollHeight)
      return best.scrollTop <= before
    })
    await page.waitForTimeout(350)
  }
  await page.waitForTimeout(3_000)

  await mkdir('tests/fixtures', { recursive: true })
  await writeFile(`tests/fixtures/${name}.json`, JSON.stringify(recorded, null, 2))
  console.log(`[${name}] recorded ${recorded.length} JSON responses`)

  await browser.close()
}

for (const [name, url] of Object.entries(TARGETS)) {
  await capture(name, url)
}
```

- [ ] **Step 6: Run the probe**

Run: `npx tsx tools/capture.ts`

Expected: four files under `tests/fixtures/`, each a non-empty array. If any file is an empty array, extraction by interception does not work as designed and this is an **escalation, not a bug to work around** — report it and stop.

For `playlist-large`, the recorded responses must contain `data.playlistV2.content` entries whose `pagingInfo.offset` values advance and whose summed `items` lengths equal `totalCount` (measured: 150). Anything less means the scroll is not driving the container — re-read the comment in Step 5 before changing anything else.

- [ ] **Step 7: Answer the pagination question and write `docs/captured-shapes.md`**

Inspect the recorded payloads and determine, for each entity type: which recorded response carries the entity, the JSON path to its name, to its artists, to its image, and to its track list.

For `playlist-large`, count the total distinct tracks recoverable across all recorded responses and compare with the playlist's real length.

Write `docs/captured-shapes.md` containing, with no hedging:
- For each of track / album / playlist: the URL pattern of the response that carries it, and the exact JSON paths to every field in the published model.
- **A "Pagination" section** stating the observed track count for `playlist-large`, the real length, and whether scrolling produced additional pages.

**ESCALATE to the human before continuing if** the large playlist yields only its first page and scrolling does not produce more. That is the spec's stated trigger for reconsidering Approach C, and it is the human's call, not the implementer's.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore tools/capture.ts tests/fixtures docs/captured-shapes.md
git commit -m "$(cat <<'MSG'
feat: project scaffold and the capture probe that grounds everything else

The probe records every JSON response an entity page fetches, with images,
fonts and media blocked exactly as production will block them, so the corpus it
records is what the real extractor will see.

Its second job is to answer the spec's largest open question: whether
interception returns a whole playlist or only its first page. docs/captured-shapes.md
records the answer along with the JSON paths every later task depends on.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
MSG
)"
```

---

### Task 2: The published model and the normalizer

**Files:**
- Create: `src/types.ts`, `src/normalize.ts`
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Consumes: `tests/fixtures/*.json` and `docs/captured-shapes.md` from Task 1. **Read that document first — it holds the real JSON paths. Do not guess field names.**
- Produces:
  - `export type Artist = { name: string; id: string | null }`
  - `export type Track = { id: string; type: 'track'; name: string; artists: Artist[]; album: { name: string; id: string | null; image: string | null } | null; durationMs: number | null; url: string }`
  - `export type Album = { id: string; type: 'album'; name: string; artists: Artist[]; image: string | null; url: string; tracks: Track[] }`
  - `export type Playlist = { id: string; type: 'playlist'; name: string; owner: string | null; image: string | null; url: string; tracks: Track[] }`
  - `export type Recorded = { url: string; status: number; body: unknown }`
  - `export function normalizeTrack(recorded: Recorded[], id: string): Track | null`
  - `export function normalizeAlbum(recorded: Recorded[], id: string): Album | null`
  - `export function normalizePlaylist(recorded: Recorded[], id: string): Playlist | null`
  - Each returns `null` when the entity cannot be found in the recording. **Never throw, never return a partially-built object.**

- [ ] **Step 1: Write `src/types.ts`**

Exactly the types listed under Produces above, and nothing else. No functions.

- [ ] **Step 2: Write the failing test `tests/normalize.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { normalizeTrack, normalizePlaylist } from '../src/normalize.js'
import type { Recorded } from '../src/types.js'

async function fixture(name: string): Promise<Recorded[]> {
  return JSON.parse(await readFile(`tests/fixtures/${name}.json`, 'utf8')) as Recorded[]
}

describe('normalizeTrack', () => {
  it('extracts a track with a name and at least one artist', async () => {
    const track = normalizeTrack(await fixture('track'), '0c6xIDDpzE81m2q797ordA')
    expect(track).not.toBeNull()
    expect(track!.name.length).toBeGreaterThan(0)
    expect(track!.artists.length).toBeGreaterThan(0)
    expect(track!.artists[0]!.name.length).toBeGreaterThan(0)
    expect(track!.type).toBe('track')
    expect(track!.url).toContain('0c6xIDDpzE81m2q797ordA')
  })

  it('returns null rather than throwing when the entity is absent', async () => {
    expect(normalizeTrack([], 'nope')).toBeNull()
    expect(normalizeTrack(await fixture('track'), 'a-different-id')).toBeNull()
  })
})

describe('normalizePlaylist', () => {
  it('extracts every track, each with a usable name and artist', async () => {
    const pl = normalizePlaylist(await fixture('playlist-small'), '37i9dQZF1DXcBWIGoYBM5M')
    expect(pl).not.toBeNull()
    expect(pl!.tracks.length).toBeGreaterThan(0)
    for (const t of pl!.tracks) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.artists.length).toBeGreaterThan(0)
    }
  })

  // The two fields cracktunes actually consumes. If these regress, every
  // downstream search query silently gets worse, so assert them explicitly.
  it('never yields a track with an empty name or no artists', async () => {
    const pl = normalizePlaylist(await fixture('playlist-large'), '37i9dQZF1DX4o1oenSJRJd')
    expect(pl).not.toBeNull()
    const bad = pl!.tracks.filter((t) => !t.name || t.artists.length === 0)
    expect(bad).toEqual([])
  })

  // Guards the defect that blocked Task 1: a scroll that fails to drive the
  // virtualized container yields page one only, which still looks like a
  // perfectly valid playlist. Assert the whole thing came back.
  it('recovers every page, not just the first', async () => {
    const pl = normalizePlaylist(await fixture('playlist-large'), '37i9dQZF1DX4o1oenSJRJd')
    expect(pl!.tracks.length).toBeGreaterThan(100)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/normalize.test.ts`
Expected: FAIL — cannot resolve `../src/normalize.js`.

- [ ] **Step 4: Implement `src/normalize.ts`**

Implement the three functions against the JSON paths recorded in `docs/captured-shapes.md`.

Rules that are not negotiable:
- Pure. No I/O, no network, no clock, no randomness.
- Find the entity by locating the recorded response whose URL and body match the requested `id`. Do not assume ordering or array index.
- Missing optional fields become `null`, never `undefined`, never `""`.
- A track with no name or no artists is **dropped from the list and counted**, not emitted with empty strings — export `export function normalizePlaylist(...)` such that malformed entries never reach the caller.
- If the entity itself cannot be located, return `null`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/normalize.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/normalize.ts tests/normalize.test.ts
git commit -m "$(cat <<'MSG'
feat: published model and a pure normalizer over recorded responses

normalize.ts is deliberately pure and takes the recorded responses as an
argument rather than fetching anything. That is what lets the bulk of the suite
run offline and deterministically against the Task 1 corpus, which matters
because the browser layer is the part most likely to break and the part hardest
to test.

Malformed tracks are dropped rather than emitted with empty strings: a track
with no name or no artist is useless to the consumer, which builds a search
query from exactly those two fields.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
MSG
)"
```

---

### Task 3: Config, cache store, and cache policy

**Files:**
- Create: `src/config.ts`, `src/store.ts`, `src/cache.ts`
- Test: `tests/cache.test.ts`

**Interfaces:**
- Consumes: `Track`, `Album`, `Playlist` from `src/types.ts`.
- Produces:
  - `export type Config = { port: number; redisUrl: string; poolSize: number; contextMaxUses: number; navTimeoutMs: number; ttl: { track: number; album: number; playlist: number; negative: number } }` (all TTLs in seconds)
  - `export function loadConfig(env: NodeJS.ProcessEnv): Config`
  - `export interface CacheStore { get(key: string): Promise<string | null>; set(key: string, value: string, ttlSeconds: number): Promise<void>; lock(key: string, ttlSeconds: number): Promise<boolean>; unlock(key: string): Promise<void>; ping(): Promise<boolean>; close(): Promise<void> }`
  - `export class RedisStore implements CacheStore` — constructor `(url: string)`
  - `export class MemoryStore implements CacheStore` — for tests
  - `export type Entry<T> = { value: T; storedAt: number }`
  - `export function cacheKey(type: 'track' | 'album' | 'playlist', id: string): string` → `` `v1:${type}:${id}` ``
  - `export async function withCache<T>(opts: { store: CacheStore; key: string; ttlSeconds: number; now: number; produce: () => Promise<T> }): Promise<{ value: T; hit: 'fresh' | 'stale' | 'miss' }>`

- [ ] **Step 1: Write `src/config.ts`**

```ts
export type Config = {
  port: number
  redisUrl: string
  poolSize: number
  contextMaxUses: number
  navTimeoutMs: number
  ttl: { track: number; album: number; playlist: number; negative: number }
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`expected a positive number, got ${JSON.stringify(raw)}`)
  }
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: num(env.PORT, 3000),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    poolSize: num(env.POOL_SIZE, 2),
    contextMaxUses: num(env.CONTEXT_MAX_USES, 50),
    navTimeoutMs: num(env.NAV_TIMEOUT_MS, 45_000),
    ttl: {
      // A track's artist and title never change; an album's listing is fixed at
      // release. Playlists genuinely change, so they get hours, not days.
      track: num(env.TTL_TRACK, 30 * 24 * 3600),
      album: num(env.TTL_ALBUM, 30 * 24 * 3600),
      playlist: num(env.TTL_PLAYLIST, 4 * 3600),
      negative: num(env.TTL_NEGATIVE, 600),
    },
  }
}
```

- [ ] **Step 2: Write the failing test `tests/cache.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { MemoryStore, cacheKey, withCache } from '../src/cache.js'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('defaults playlist TTL to four hours and track TTL to thirty days', () => {
    const c = loadConfig({})
    expect(c.ttl.playlist).toBe(4 * 3600)
    expect(c.ttl.track).toBe(30 * 24 * 3600)
  })

  it('rejects a nonsense value loudly instead of silently defaulting', () => {
    expect(() => loadConfig({ PORT: 'banana' })).toThrow()
    expect(() => loadConfig({ POOL_SIZE: '0' })).toThrow()
  })
})

describe('cacheKey', () => {
  it('is versioned and type-scoped', () => {
    expect(cacheKey('track', 'abc')).toBe('v1:track:abc')
  })
})

describe('withCache', () => {
  it('calls produce on a miss and serves the value from cache next time', async () => {
    const store = new MemoryStore()
    let calls = 0
    const produce = async () => { calls++; return { n: 1 } }

    const a = await withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce })
    expect(a.hit).toBe('miss')
    const b = await withCache({ store, key: 'k', ttlSeconds: 60, now: 1001, produce })
    expect(b.hit).toBe('fresh')
    expect(calls).toBe(1)
    expect(b.value).toEqual({ n: 1 })
  })

  // The aggressive bit. A slightly old playlist beats an error.
  it('serves an expired entry when produce throws', async () => {
    const store = new MemoryStore()
    await withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce: async () => ({ n: 1 }) })

    const later = await withCache({
      store, key: 'k', ttlSeconds: 60, now: 1_000_000,
      produce: async () => { throw new Error('scrape failed') },
    })
    expect(later.hit).toBe('stale')
    expect(later.value).toEqual({ n: 1 })
  })

  it('propagates the error when produce throws and nothing is cached', async () => {
    const store = new MemoryStore()
    await expect(withCache({
      store, key: 'k', ttlSeconds: 60, now: 1000,
      produce: async () => { throw new Error('scrape failed') },
    })).rejects.toThrow('scrape failed')
  })

  // Without this, one playlist pasted in two guilds is two Chromium page loads.
  it('coalesces concurrent misses for the same key into one produce call', async () => {
    const store = new MemoryStore()
    let calls = 0
    const produce = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 50))
      return { n: 1 }
    }
    const results = await Promise.all([
      withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce }),
      withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce }),
      withCache({ store, key: 'k', ttlSeconds: 60, now: 1000, produce }),
    ])
    expect(calls).toBe(1)
    for (const r of results) expect(r.value).toEqual({ n: 1 })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/cache.test.ts`
Expected: FAIL — cannot resolve `../src/cache.js`.

- [ ] **Step 4: Write `src/store.ts` and `src/cache.ts`**

`src/store.ts` holds `CacheStore`, `RedisStore` (ioredis; `lock` uses `SET key 1 NX EX ttl`) and `MemoryStore`. `src/cache.ts` must `export * from './store.js'` — the tests import `MemoryStore` from `cache.js`, so that re-export is required, not optional.

`src/cache.ts` re-exports the store types and implements `cacheKey` and `withCache`:

- Read the key. If present and `now - storedAt < ttlSeconds`, return `{ value, hit: 'fresh' }`.
- Otherwise attempt `store.lock(key + ':lock', 30)`.
  - Lock acquired → call `produce()`. On success, `set` and return `{ value, hit: 'miss' }`. On throw, if an expired entry exists return `{ value, hit: 'stale' }`; otherwise rethrow. Always `unlock` in a `finally`.
  - Lock not acquired → poll the key every 50ms up to 30s for a fresh entry; return it as `'fresh'`. If the wait elapses, fall through and produce directly rather than failing — a slow peer must not turn into an error.

```bash
npm install ioredis
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/cache.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config.ts src/store.ts src/cache.ts tests/cache.test.ts
git commit -m "$(cat <<'MSG'
feat: config, cache store and cache policy

Policy is split from storage so the interesting logic -- TTL selection,
stale-on-error, single-flight coalescing -- is testable against MemoryStore with
no Redis running, while RedisStore stays a thin adapter.

Two behaviours make this aggressive rather than merely cached. Single-flight
means concurrent misses for one key share a single produce call, so the same
playlist pasted in two guilds is one browser load rather than two. Stale-on-error
serves an expired entry when a scrape fails, because a slightly old playlist
beats an error.

loadConfig throws on a nonsense value rather than silently falling back: a
typo'd POOL_SIZE that quietly becomes the default is a configuration bug you
find in production.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
MSG
)"
```

---

### Task 4: Browser pool

**Files:**
- Create: `src/browser.ts`
- Test: `tests/browser.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.ts`.
- Produces:
  - `export type Lease = { page: import('playwright').Page; release: () => Promise<void> }`
  - `export interface Pool { acquire(): Promise<Lease>; liveContexts(): number; close(): Promise<void> }`
  - `export async function createPool(cfg: Config): Promise<Pool>`

`acquire()` waits for a free context rather than failing when all are busy. Every page returned already has image, font and media requests aborted.

- [ ] **Step 1: Write the failing test `tests/browser.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'

const cfg = loadConfig({ POOL_SIZE: '2', CONTEXT_MAX_USES: '3' })
const pool = await createPool(cfg)
afterAll(async () => { await pool.close() })

describe('createPool', () => {
  it('reports live contexts once created', () => {
    expect(pool.liveContexts()).toBe(2)
  })

  it('serves a usable page and takes it back', async () => {
    const lease = await pool.acquire()
    await lease.page.setContent('<h1>hello</h1>')
    expect(await lease.page.textContent('h1')).toBe('hello')
    await lease.release()
  })

  // If acquire() rejected when busy, a third concurrent request would 500
  // rather than simply waiting its turn.
  it('makes a third caller wait rather than fail when the pool is exhausted', async () => {
    const a = await pool.acquire()
    const b = await pool.acquire()
    let served = false
    const pending = pool.acquire().then(async (c) => { served = true; await c.release() })
    await new Promise((r) => setTimeout(r, 100))
    expect(served).toBe(false)
    await a.release()
    await pending
    expect(served).toBe(true)
    await b.release()
  })

  it('blocks images so they never reach the network', async () => {
    const lease = await pool.acquire()
    const attempted: string[] = []
    lease.page.on('requestfailed', (r) => { if (r.resourceType() === 'image') attempted.push(r.url()) })
    await lease.page.setContent('<img src="https://example.invalid/x.png">')
    await lease.page.waitForTimeout(300)
    expect(attempted.length).toBeGreaterThan(0)
    await lease.release()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/browser.test.ts`
Expected: FAIL — cannot resolve `../src/browser.js`.

- [ ] **Step 3: Implement `src/browser.ts`**

- Launch one `chromium` browser at `createPool`.
- Create `cfg.poolSize` contexts, each with one page, each with the abort route installed.
- Maintain a free list and a FIFO waiter queue. `acquire()` takes a free lease or queues.
- Count uses per context; at `cfg.contextMaxUses`, close and replace the context on release so leaked memory does not accumulate.
- `liveContexts()` returns the number of contexts currently open.
- `close()` drains and closes the browser.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/browser.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts tests/browser.test.ts
git commit -m "$(cat <<'MSG'
feat: a browser pool that reuses contexts instead of launching per request

The prior art called puppeteer.launch() inside its request path, which was its
dominant cost. Contexts are created once and reused, recycled after a configured
number of uses so leaked memory does not accumulate.

acquire() queues when the pool is exhausted rather than rejecting: a third
concurrent request should wait its turn, not 500.

Image, font and media requests are aborted on every page. They are a large share
of page-load time and this service has no use for any of them.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
MSG
)"
```

---

### Task 5: The extractor

**Files:**
- Create: `src/extract.ts`
- Test: `tests/extract.test.ts`

**Interfaces:**
- Consumes: `Pool` and `Lease` from `src/browser.ts`; `normalizeTrack`/`normalizeAlbum`/`normalizePlaylist` and `Recorded` from Task 2; `Config`.
- Produces:
  - `export class NotFoundError extends Error {}`
  - `export class ExtractionEmptyError extends Error {}` — thrown when navigation succeeded but nothing was extracted. **Distinct on purpose: this is the canary for a Spotify redesign and must never be confused with a 404.**
  - `export async function recordResponses(page: import('playwright').Page, url: string, navTimeoutMs: number): Promise<Recorded[]>`
  - `export async function extract(kind: 'track' | 'album' | 'playlist', id: string, pool: Pool, cfg: Config): Promise<Track | Album | Playlist>`

- [ ] **Step 1: Write the failing test `tests/extract.test.ts`**

`recordResponses` is tested against a **local** page, so the suite stays offline. Playwright's routing serves fixture bytes for a fake API URL.

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'
import { recordResponses } from '../src/extract.js'

const cfg = loadConfig({ POOL_SIZE: '1' })
const pool = await createPool(cfg)
afterAll(async () => { await pool.close() })

describe('recordResponses', () => {
  it('records JSON responses the page fetches and ignores non-JSON', async () => {
    const lease = await pool.acquire()

    await lease.page.route('https://fake.test/**', async (route) => {
      const u = route.request().url()
      if (u.endsWith('/data.json')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hello: 'world' }) })
      }
      if (u.endsWith('/page')) {
        return route.fulfill({
          status: 200, contentType: 'text/html',
          body: `<html><body><script>fetch('https://fake.test/data.json');fetch('https://fake.test/plain.txt')</script></body></html>`,
        })
      }
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'not json' })
    })

    const recorded = await recordResponses(lease.page, 'https://fake.test/page', 10_000)
    await lease.release()

    const bodies = recorded.map((r) => r.body)
    expect(bodies).toContainEqual({ hello: 'world' })
    expect(recorded.every((r) => r.url.endsWith('.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/extract.test.ts`
Expected: FAIL — cannot resolve `../src/extract.js`.

- [ ] **Step 3: Implement `src/extract.ts`**

- `recordResponses` attaches a `response` listener collecting JSON-content-type bodies, navigates with `waitUntil: 'networkidle'` and the configured timeout, then scrolls to the bottom repeatedly **only for playlists and albums** (a track page has no list to page in), and returns everything recorded. Use the scroll loop that Task 1's probe proved sufficient — match its iteration count and delays to `docs/captured-shapes.md`.
- `extract` acquires a lease, builds the entity URL, calls `recordResponses`, dispatches to the matching normalizer, and releases the lease in a `finally`.
- If the normalizer returns `null`, throw `NotFoundError`.
- If the normalizer returns an album or playlist whose `tracks` array is empty, throw `ExtractionEmptyError` — **never** return it and never let it be cached.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract.ts tests/extract.test.ts
git commit -m "$(cat <<'MSG'
feat: extraction by interception, with an empty result treated as a failure

recordResponses collects the JSON a page fetches and hands it to the pure
normalizer. It is tested against a locally routed fake page rather than real
Spotify, so this stays in the offline suite.

ExtractionEmptyError is deliberately distinct from NotFoundError. An album or
playlist that navigates successfully and yields zero tracks does not mean the
entity is missing -- it means our extraction stopped matching, which is exactly
how the prior art died: silently, returning nothing. It must be loud, and it
must never populate the cache.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
MSG
)"
```

---

### Task 6: Metrics, HTTP server, and the entrypoint

**Files:**
- Create: `src/metrics.ts`, `src/server.ts`, `src/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces:
  - `export const registry: import('prom-client').Registry`
  - `export const cacheHits: Counter`, `scrapeDuration: Histogram`, `scrapeFailures: Counter` (label `reason`), `extractionEmpty: Counter`
  - `export function buildServer(deps: { cfg: Config; store: CacheStore; pool: Pool; extract: ExtractFn; now?: () => number }): FastifyInstance`
  - `export type ExtractFn = (kind: 'track'|'album'|'playlist', id: string, pool: Pool, cfg: Config) => Promise<Track|Album|Playlist>`

`buildServer` takes its dependencies as arguments so tests can inject fakes. `src/index.ts` is the only place that constructs real ones.

- [ ] **Step 1: Write the failing test `tests/server.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server.js'
import { MemoryStore } from '../src/cache.js'
import { loadConfig } from '../src/config.js'
import { NotFoundError, ExtractionEmptyError } from '../src/extract.js'

const cfg = loadConfig({})
const fakePool = { acquire: async () => { throw new Error('unused') }, liveContexts: () => 1, close: async () => {} }

function server(extract: any, store = new MemoryStore()) {
  return buildServer({ cfg, store, pool: fakePool as any, extract })
}

const TRACK = { id: 'abc', type: 'track', name: 'Hideaway', artists: [{ name: 'Kiesza', id: null }], album: null, durationMs: null, url: 'https://open.spotify.com/track/abc' }

describe('GET /health', () => {
  it('returns the exact origin string when Redis and the pool are up', async () => {
    const app = server(async () => TRACK)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('sleevenote ok')
  })

  // A status-only check is worthless: an intermediary error page is also a 200.
  it('fails when the store is unreachable', async () => {
    const broken = new MemoryStore()
    broken.ping = async () => false
    const app = server(async () => TRACK, broken)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toBe('sleevenote ok')
  })
})

describe('GET /v1/track/:id', () => {
  it('returns the normalized track', async () => {
    const app = server(async () => TRACK)
    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: 'Hideaway', type: 'track' })
  })

  it('maps NotFoundError to 404', async () => {
    const app = server(async () => { throw new NotFoundError('nope') })
    expect((await app.inject({ method: 'GET', url: '/v1/track/abc' })).statusCode).toBe(404)
  })

  it('maps ExtractionEmptyError to 502, not 404', async () => {
    const app = server(async () => { throw new ExtractionEmptyError('nothing') })
    expect((await app.inject({ method: 'GET', url: '/v1/playlist/abc' })).statusCode).toBe(502)
  })

  it('serves stale with a header when a later scrape fails', async () => {
    const store = new MemoryStore()
    let fail = false
    const app = server(async () => { if (fail) throw new Error('boom'); return TRACK }, store)

    await app.inject({ method: 'GET', url: '/v1/track/abc' })
    fail = true
    // Age the entry past its TTL by rewriting storedAt.
    const raw = JSON.parse((await store.get('v1:track:abc'))!)
    raw.storedAt = 0
    await store.set('v1:track:abc', JSON.stringify(raw), 9999)

    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('stale')
  })
})

describe('GET /metrics', () => {
  it('exposes the extraction-empty canary', async () => {
    const app = server(async () => TRACK)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('sleevenote_extraction_empty_total')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Install and implement**

```bash
npm install fastify prom-client
```

`src/metrics.ts`: a `Registry` with `sleevenote_cache_hits_total{type,result}`, `sleevenote_scrape_duration_seconds`, `sleevenote_scrape_failures_total{reason}`, `sleevenote_extraction_empty_total`.

`src/server.ts`: three entity routes sharing one handler that calls `withCache`, sets `X-Cache` to `fresh`/`stale`/`miss`, and maps errors — `NotFoundError`→404 (and negative-cache the id for `cfg.ttl.negative`), `ExtractionEmptyError`→502 plus `extractionEmpty.inc()`, timeout→504, anything else→502. Plus `/health` and `/metrics`.

`src/index.ts`: `loadConfig(process.env)`, construct `RedisStore` and the pool, `buildServer`, listen, and close both on `SIGTERM`/`SIGINT`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, every file.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/metrics.ts src/server.ts src/index.ts tests/server.test.ts
git commit -m "$(cat <<'MSG'
feat: HTTP surface, metrics and entrypoint

buildServer takes its dependencies as arguments so the whole HTTP surface is
testable with fakes and no Redis, no browser and no network.

/health returns the exact string `sleevenote ok`, and only when the store
answers and the pool has a live context. A status-only check is worthless: the
bot-ingress contract records bot-template-rs answering Cloudflare's own 530 page
for nine days, which any check asserting merely that a response arrived would
have called healthy throughout.

ExtractionEmptyError maps to 502 rather than 404 and increments its own counter.
Zero tracks does not mean the entity is missing; it means extraction stopped
matching, and that has to be loud.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
MSG
)"
```

---

### Task 7: Packaging and the live smoke test

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`
- Create: `tests/live.smoke.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: a runnable image and a scheduled-only network test.

- [ ] **Step 1: Write the live smoke test `tests/live.smoke.test.ts`**

It SKIPs with a stated reason rather than failing when it cannot run. A red test must mean something is broken.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createPool } from '../src/browser.js'
import { loadConfig } from '../src/config.js'
import { extract } from '../src/extract.js'

// Opt-in: this is the only test that touches the real internet. CI runs the
// offline suite; a schedule runs this. Last measured PASS: see git log for this file.
const LIVE = process.env.SLEEVENOTE_LIVE === '1'

const cfg = loadConfig({ POOL_SIZE: '1' })

describe.skipIf(!LIVE)('live extraction against real Spotify', () => {
  // A describe callback is synchronous, so the pool is built in beforeAll
  // rather than awaited inline.
  let pool: Awaited<ReturnType<typeof createPool>>
  beforeAll(async () => { pool = await createPool(cfg) }, 60_000)
  afterAll(async () => { await pool?.close() })

  it('resolves a known track', async () => {
    const t: any = await extract('track', '0c6xIDDpzE81m2q797ordA', pool, cfg)
    expect(t.name.length).toBeGreaterThan(0)
    expect(t.artists.length).toBeGreaterThan(0)
  }, 120_000)

  it('resolves a playlist with every track usable', async () => {
    const p: any = await extract('playlist', '37i9dQZF1DX4o1oenSJRJd', pool, cfg)
    expect(p.tracks.length).toBeGreaterThan(0)
    expect(p.tracks.filter((t: any) => !t.name || t.artists.length === 0)).toEqual([])
  }, 180_000)
})

if (!LIVE) {
  console.log('SKIP live extraction -- needs real network access to open.spotify.com; set SLEEVENOTE_LIVE=1 to run')
}
```

- [ ] **Step 2: Confirm the offline suite still passes with no network**

Run: `npx vitest run`
Expected: PASS, and the live block reports SKIP with its reason.

- [ ] **Step 3: Write `Dockerfile`**

```dockerfile
# Playwright's own image pins a Chromium that matches the library version. Do
# not substitute a bare node image and apt-get a browser: that mismatch is what
# rotted the prior art.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

USER pwuser
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
```

Pin the image tag to the Playwright version in `package-lock.json`; if they disagree, the browser and the library disagree.

- [ ] **Step 4: Write `docker-compose.yml` and `.env.example`**

```yaml
services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    restart: unless-stopped

  sleevenote:
    build: .
    environment:
      REDIS_URL: redis://redis:6379
      PORT: "3000"
    ports:
      # VLAN 30 only. The bot-ingress contract requires publishing on the
      # VLAN 30 address rather than 0.0.0.0; the firewall closes the LAN
      # surface, but do not widen this without reading that document.
      - "192.168.30.0:3000:3000"
    depends_on: [redis]
    restart: unless-stopped
```

`.env.example` documents every key `loadConfig` reads, with its default.

- [ ] **Step 5: Build and smoke the image**

```bash
docker compose build
docker compose up -d
sleep 5
curl -fsS http://127.0.0.1:3000/health
```

Expected: `sleevenote ok`. Then `docker compose down`.

- [ ] **Step 6: Update `README.md`**

Replace "Status: design only" with real usage: how to run via compose, the env vars, and how to run the live smoke test. Keep the Why section.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore .env.example README.md tests/live.smoke.test.ts
git commit -m "$(cat <<'MSG'
feat: packaging, and a live smoke test that skips instead of failing

The image is built FROM Playwright's own tag rather than a bare node image with
an apt-get'd browser. A browser that does not match its driver is exactly the
mismatch that rotted the prior art, and the published image is the only way to
keep them pinned together.

The live test is opt-in behind SLEEVENOTE_LIVE=1 and prints a stated reason when
it skips. CI runs the offline suite with no network; a schedule runs this one.
A red test must mean something is broken -- a test that fails because there is
no internet teaches people to ignore red.

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)
MSG
)"
```

---

## Deferred, with reasons

- **The cracktunes client.** Replacing `Spotify::extract` and friends with a `sleevenote` HTTP client is work in the *cracktunes* repo against a *running* service. It gets its own cycle once this one is proven.
- **Approach C (token harvest).** Documented in the spec. Revisit only if Task 1 shows pagination is unworkable, or measured playlist latency proves painful.
- **Providers other than Spotify.** The model leaves room. Nothing is built for them.
- **Recommendations.** Out of scope per the spec; cracktunes autoplay will be re-sourced separately.

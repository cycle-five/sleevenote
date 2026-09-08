import type { Page, Request, Response } from 'playwright'
import type { Pool } from './browser.js'
import type { Config } from './config.js'
import {
  PATHFINDER_URL,
  albumTotalCount,
  normalizeAlbum,
  normalizePlaylist,
  normalizeTrack,
  playlistTotalCount,
} from './normalize.js'
import type { Album, Playlist, Recorded, Track } from './types.js'

// Five distinct failures, never collapsed into one. A 404 means Spotify
// answered the page non-2xx and the entity is genuinely gone; the others mean
// our extraction stopped matching Spotify's page. Confusing them is how the
// prior art died -- silently. None of the latter four may ever populate the
// cache. See docs/design-notes.md ("The five extraction failures") and
// ("Absence has to be evidenced").
/**
 * What the page actually gave us, carried on the error so the HTTP layer can
 * log it without reproducing the extraction.
 *
 * `recorded: 0` is the signal that matters: it means the capture saw no JSON
 * at all, which is our failure and not evidence that the entity is absent.
 */
export type ExtractionEvidence = {
  /** Status of the navigation itself; `null` when the browser reported none. */
  navStatus: number | null
  /** JSON responses captured during the page load. */
  recorded: number
  /** Distinct HTTP statuses among them, ascending. */
  statuses: number[]
  /** Distinct response paths, bounded; full URLs are long and repetitive. */
  paths: string[]
}

const MAX_EVIDENCE_PATHS = 8

/** What one page load produced. */
export type Capture = {
  /** Status of the navigation itself; `null` when the browser reported none. */
  navStatus: number | null
  responses: Recorded[]
  /** The first windowed pathfinder request the page issued, if any. See [`QueryTemplate`]. */
  template: QueryTemplate | null
}

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

/**
 * Whether a pathfinder request is the windowed query worth repeating. Only a
 * query whose `variables.offset` is present is windowed; an entity-header
 * query has no offset and paginating it would be meaningless.
 *
 * Pulled out of `onRequest` so the decision itself -- not Playwright's event
 * plumbing -- is directly unit-testable. A body that fails to parse as JSON
 * at all (`request.postDataJSON()` throwing) is handled by the caller, not
 * here: this function only judges a body it was already handed.
 */
export function isWindowedQuery(url: string, body: unknown): boolean {
  if (!url.startsWith(PATHFINDER_URL)) return false
  if (body === null || typeof body !== 'object') return false
  const variables = (body as Record<string, unknown>).variables
  if (variables === null || typeof variables !== 'object') return false
  return (variables as Record<string, unknown>).offset !== undefined
}

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
  return null // A track is one item; there is nothing to page through.
}

/** Summarise a capture for logging. Pure, so the summary is testable alone. */
export function evidenceFrom(capture: Capture): ExtractionEvidence {
  const { navStatus, responses: recorded } = capture
  const statuses = [...new Set(recorded.map((r) => r.status))].sort((a, b) => a - b)
  const paths = [
    ...new Set(
      recorded.map((r) => {
        try {
          return new URL(r.url).pathname
        } catch {
          // An unparseable URL is itself worth seeing, so keep it rather than
          // dropping the response from the count's explanation.
          return r.url
        }
      }),
    ),
  ].slice(0, MAX_EVIDENCE_PATHS)
  return { navStatus, recorded: recorded.length, statuses, paths }
}

/** Carries [`ExtractionEvidence`] where the thrower had it to hand. */
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly evidence?: ExtractionEvidence,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends ExtractionError {}

/**
 * The page loaded, and we recognised nothing on it.
 *
 * Distinct from [`ExtractionEmptyError`], which found the entity and saw zero
 * items in it: this one found no entity at all, which points at a wholesale
 * shape change rather than one broken list. It used to be reported as
 * [`NotFoundError`] -- a 404, negative-cached -- so a scraper that stopped
 * working looked exactly like a Spotify catalogue full of deleted entities,
 * and recorded no failures at all while doing it.
 */
export class ExtractionSilentError extends ExtractionError {}

export class ExtractionEmptyError extends ExtractionError {}

// A partial recovery that still returns *some* tracks, which a bare
// `tracks.length === 0` check cannot see.
export class ExtractionIncompleteError extends ExtractionError {}

// A class, not a message: the HTTP layer maps 504 by `instanceof`, so editing
// the wording below cannot silently downgrade every timeout to a generic 502.
// Carries no evidence -- the budget rejects from outside the extraction, with
// no `recorded` in hand -- but shares the base so every extraction failure
// produces exactly one diagnostic line.
export class ExtractionTimeoutError extends ExtractionError {}

/** The first line of a message, for a log line that has to stay one line. */
function firstLine(message: string): string {
  return message.split('\n')[0] ?? message
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd so a pending wait cannot hold the process open at shutdown.
    const t = setTimeout(resolve, ms)
    if (typeof t === 'object' && 'unref' in t) t.unref()
  })
}

// Only reached when the harvested query carried no usable `limit` of its own,
// which no observed query has done -- `isWindowedQuery` already demands an
// `offset`, and every windowed query measured so far carried both. It stays a
// guess rather than a certainty, so note the risk it uniquely carries: offsets
// step by whatever `limit` we ask for, so if Spotify caps a page below that,
// we skip the difference. The normal path cannot hit that, because it reuses
// the page's own `limit` -- a window Spotify has already honoured once.
const DEFAULT_PAGE_LIMIT = 100

const SCROLL_MAX_ITERATIONS = 200
const SCROLL_STEP_DELAY_MS = 350
const SCROLL_SETTLE_MS = 3_000

/**
 * Navigate to `url`, collect every JSON response the page fetches, and recover
 * the whole of a virtualized list rather than the first window of it.
 *
 * Two strategies, and they are not equals. Preferred: repeat the page's own
 * windowed pathfinder query at each remaining offset (see [`QueryTemplate`]).
 * That asks for exactly the items that are missing and knows when it is done.
 * Fallback, taken only when the page issued no such query for us to harvest:
 * scroll the list and hope it fetches more.
 *
 * The scroll technique is load-bearing and was measured wrong twice before
 * this shape worked -- do not "simplify" it without reading
 * docs/design-notes.md ("Scrolling a virtualized list") and
 * docs/captured-shapes.md ("Pagination"). It is emphatically not dead code:
 * a navigation that lands without provoking a windowed query still arrives
 * here, and comes up short. Serving a short listing to a caller who opted into
 * one is exactly why that path shipped before this one.
 *
 * A track page needs no special case on either branch: it declares no total,
 * so pagination asks for nothing, and nothing matches the container heuristic,
 * so the scroll loop exits on its first iteration.
 */
export async function recordResponses(
  page: Page,
  url: string,
  kind: 'track' | 'album' | 'playlist',
  id: string,
  navTimeoutMs: number,
  entityDataTimeoutMs: number,
): Promise<Capture> {
  const recorded: Recorded[] = []
  let navStatus: number | null = null

  // Resolved by the first pathfinder response. Created BEFORE `goto` on
  // purpose: a response that arrives while we are still navigating has to
  // count, or waiting on it afterwards would hang for the full timeout.
  let sawEntityData = (): void => {}
  const entityData = new Promise<void>((resolve) => {
    sawEntityData = resolve
  })

  // Reading a body is a round trip of its own, and `page.on` discards whatever
  // its handler returns -- so a read can still be in flight after we have
  // stopped looking. Scrolling never had to care: `sawEntityData()` fires
  // before the body is read, but the 3s settle that followed always covered
  // the gap. Pagination has no settle, and it has to read `totalCount` off a
  // response the instant that race resolves. Keeping the promises lets it wait
  // for the reads it actually provoked instead of guessing at a duration.
  const bodies: Promise<void>[] = []
  const readResponse = async (response: Response): Promise<void> => {
    const contentType = response.headers()['content-type'] ?? ''
    if (!contentType.includes('json')) return
    if (response.url().startsWith(PATHFINDER_URL)) sawEntityData()
    try {
      recorded.push({ url: response.url(), status: response.status(), body: await response.json() })
    } catch {
      // A JSON content-type that isn't JSON is not a reason to fail.
    }
  }
  const onResponse = (response: Response): void => {
    bodies.push(readResponse(response))
  }
  page.on('response', onResponse)

  // An array holding at most one, rather than a `let`, because TypeScript's
  // flow analysis does not follow an assignment made inside an event handler:
  // it would narrow a `let` initialised to `null` to `never` for the whole
  // rest of this function, and the pagination branch below would not compile.
  const templates: QueryTemplate[] = []
  const onRequest = (request: Request): void => {
    if (templates.length > 0) return
    if (!request.url().startsWith(PATHFINDER_URL)) return
    let body: unknown
    try {
      body = request.postDataJSON()
    } catch {
      return // Not JSON we can repeat.
    }
    if (!isWindowedQuery(request.url(), body)) return
    templates.push({ url: request.url(), headers: request.headers(), body: body as Record<string, unknown> })
  }
  page.on('request', onRequest)

  try {
    const navigation = await page.goto(url, { waitUntil: 'networkidle', timeout: navTimeoutMs })
    navStatus = navigation?.status() ?? null

    // Spotify answers a dead entity on the document itself -- 404 for a track
    // or album, 400 for a playlist (measured, hence `>= 400` and never
    // `=== 404`) -- and serves a "Page not found" shell. There is no
    // virtualized list to recover, so whichever branch below we took would be
    // spent either paging a shell or scrolling a placeholder.
    if (navStatus !== null && navStatus >= 400) {
      return { navStatus, responses: recorded, template: templates[0] ?? null }
    }

    // Wait for the data itself, not for a proxy for it.
    //
    // `networkidle` above plus the scroll and settle below is a GUESS that the
    // entity query has already landed. On a cold context that guess is wrong:
    // the whole window goes on bootstrap and the query fires after we have
    // stopped looking, so normalize sees nothing and the extraction is
    // reported as silent. Waiting for the response every normalizer reads is
    // the difference between "probably arrived" and "arrived".
    //
    // Bounded and non-fatal: if it never comes, carry on and let the
    // normalizers report what they actually found.
    await Promise.race([entityData, sleep(entityDataTimeoutMs)])

    const template = templates[0]
    if (template !== undefined) {
      // Pagination: ask for the rest directly. Issued from inside the page so
      // the session, cookies and tokens are the page's own -- we repeat its
      // request, we do not construct one. The responses arrive through the
      // same `onResponse` listener as the ones the page fetched for itself, so
      // nothing downstream can tell which is which. That is the point: it is
      // what keeps `normalize` and every fixture in the corpus untouched.
      const vars = template.body['variables'] as Record<string, unknown>
      const rawLimit = vars['limit']
      const rawOffset = vars['offset']
      const limit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_LIMIT
      const first = typeof rawOffset === 'number' ? rawOffset : 0

      // The entity race resolves on the response *event*, which fires before
      // its body has been pulled across -- so `recorded` can still be empty
      // right here. Reading the declared total off it without this wait finds
      // null, pages nothing, and produces the short listing this task exists
      // to eliminate, wearing pagination's clothes.
      await Promise.all(bodies)
      const total = declaredTotalFrom(kind, recorded, id)

      // Nothing declared a total, so `pageOffsets` asks for nothing and the
      // loop below fetches no windows at all. For a listing that is the same
      // outcome as a failed pagination -- whatever the first response carried
      // is all the caller gets -- and it is otherwise completely silent: with
      // no declared total the verdict is `complete: true` by definition (see
      // the spec's "Spotify declared nothing, so we cannot tell"), so not
      // even `complete: false` marks it. Same register as the mid-loop warn
      // below, and for the same reason: a short listing that reads as a whole
      // one is what this service exists to prevent.
      if (total === null && kind !== 'track') {
        console.warn(
          `[extract] ${kind} ${id}: no declared total in ${recorded.length} recorded response(s) ` +
            `-- no windows will be fetched; listing is whatever the first page carried`,
        )
      }

      const offsets = pageOffsets(total, limit, first)
      for (const [i, offset] of offsets.entries()) {
        const next = withOffset(template, offset, limit)
        try {
          await page.evaluate(async (req) => {
            const res = await fetch(req.url, {
              method: 'POST',
              headers: req.headers,
              body: JSON.stringify(req.body),
            })
            // Drain it in the page: Playwright can only hand us a body the
            // browser actually finished receiving.
            await res.text()
          }, next)
        } catch (err) {
          // A window we could not fetch is a short listing, not a failed
          // extraction -- holding that distinction is the whole of Phase 1.
          // Stop asking rather than hammer a page that has stopped answering;
          // `complete: false` on the result reports the shortfall honestly.
          //
          // But it must not be SILENT, and this line is the only place the
          // distinction exists. `complete: false` alone cannot tell an
          // operator "Spotify declared 50 and every window came back fine"
          // apart from "window 2 of 4 threw" -- and since partial listings
          // shipped, the second is handed to an opt-in caller looking exactly
          // like the first. A truncated listing that reads as a whole one is
          // the failure this service exists to prevent; it should not be
          // reintroduced one rung down.
          //
          // `console.warn` and not a request logger because extraction has no
          // logger handle -- errors carry [`ExtractionEvidence`] to the HTTP
          // layer instead, and that route is closed here precisely because
          // this path does not throw. It is how store.ts reports a connection
          // error for the same reason. `id` is the correlation key.
          console.warn(
            `[extract] ${kind} ${id}: window ${i + 1} of ${offsets.length} failed at offset ${offset} ` +
              `(limit ${limit}, declared total ${total ?? 'unknown'}) -- listing will be short: ` +
              // First line only: Playwright folds a page-side stack into
              // `message`, and those frames point into Spotify's bundle, not
              // ours. A warn that spans six lines in among pino's JSON costs
              // more legibility than the frames buy back.
              firstLine(err instanceof Error ? err.message : String(err)),
          )
          break
        }
      }
      // The final window's body is still crossing the wire when its
      // `page.evaluate` resolves. Dropping it would silently lose the last
      // page of every listing.
      await Promise.all(bodies)
    } else {
      // No query to repeat: fall back to provoking the page into fetching more
      // by scrolling. This is the degraded path -- undirected, and with no way
      // to know it has finished except running out of iterations.
      //
      // Which is why it is announced. An operator looking at a short listing
      // has three candidate causes and only one of them used to leave a
      // trace: a window failed mid-loop (the warn in the branch above), no
      // template was ever harvested (here), or nothing declared a total (the
      // warn above that). Without this line, "Spotify changed how the web
      // player issues pathfinder queries" -- the named risk this fallback
      // exists to absorb -- degrades to today's behaviour completely
      // silently, which is how the fallback stops being a fallback and starts
      // being the only path.
      if (kind !== 'track') {
        console.warn(
          `[extract] ${kind} ${id}: no windowed pathfinder query to repeat ` +
            `-- falling back to the scroll heuristic; listing may be short`,
        )
      }
      let exhausted = false
      for (let i = 0; i < SCROLL_MAX_ITERATIONS && !exhausted; i++) {
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
        await page.waitForTimeout(SCROLL_STEP_DELAY_MS)
      }
      await page.waitForTimeout(SCROLL_SETTLE_MS)
    }
  } finally {
    // The page is pooled and reused. A listener left attached would keep
    // pushing into this call's abandoned array for the rest of the page's
    // life -- a per-lease leak.
    page.off('response', onResponse)
    page.off('request', onRequest)
  }

  return { navStatus, responses: recorded, template: templates[0] ?? null }
}

function entityUrl(kind: 'track' | 'album' | 'playlist', id: string): string {
  return `https://open.spotify.com/${kind}/${id}`
}

function normalizeByKind(
  kind: 'track' | 'album' | 'playlist',
  recorded: Recorded[],
  id: string,
): Track | Album | Playlist | null {
  switch (kind) {
    case 'track':
      return normalizeTrack(recorded, id)
    case 'album':
      return normalizeAlbum(recorded, id)
    case 'playlist':
      return normalizePlaylist(recorded, id)
  }
}

async function runExtraction(
  kind: 'track' | 'album' | 'playlist',
  id: string,
  pool: Pool,
  cfg: Config,
): Promise<Track | Album | Playlist> {
  const lease = await pool.acquire()
  try {
    const capture = await recordResponses(
      lease.page,
      entityUrl(kind, id),
      kind,
      id,
      cfg.navTimeoutMs,
      cfg.entityDataTimeoutMs,
    )
    const { navStatus, responses: recorded } = capture

    // Absence has to be POSITIVELY evidenced, and the navigation status is the
    // only thing that carries it: a dead entity records no JSON at all, which
    // is indistinguishable from a capture that simply saw nothing. Getting
    // this backwards answered 404 for a live playlist and negative-cached it.
    if (navStatus !== null && navStatus >= 400) {
      throw new NotFoundError(
        `no ${kind} found for id ${id} -- Spotify answered the page with ${navStatus}`,
        evidenceFrom(capture),
      )
    }

    const result = normalizeByKind(kind, recorded, id)

    if (result === null) {
      throw new ExtractionSilentError(
        `${kind} ${id} loaded with ${navStatus ?? 'an unreported status'} but nothing on the page matched ` +
          `-- extraction has stopped recognising Spotify's shape`,
        evidenceFrom(capture),
      )
    }
    // Navigated fine but zero tracks is not a 404 -- normalizeByKind returns
    // null for that. It means extraction stopped matching Spotify's page.
    if ((result.type === 'album' || result.type === 'playlist') && result.tracks.length === 0) {
      throw new ExtractionEmptyError(
        `${kind} ${id} navigated successfully but yielded zero tracks -- extraction likely stopped matching Spotify's page`,
        evidenceFrom(capture),
      )
    }
    // A shortfall is no longer a failure here. `normalize` records it on the
    // result as `complete: false` and the route decides what it means: a
    // caller that asked for partials gets the listing, one that did not gets
    // the 502 this used to throw. Extraction reports; policy is the caller's.
    //
    // ExtractionEmptyError above keeps its throw deliberately -- zero tracks
    // is not a partial listing, it is extraction that stopped matching.
    return result
  } finally {
    // The pool cannot enforce this, so every path out -- including a throw
    // above -- must release. A second release() is a documented no-op.
    await lease.release()
  }
}

/**
 * Race `work` against `budgetMs`. On timeout the caller sees a rejection but
 * `work` is NOT cancelled -- Playwright offers no way to abort an in-flight
 * evaluate. It runs to completion in the background, including its own
 * `lease.release()`, so the lease still returns to the pool.
 *
 * A backstop against anomalies, not an everyday path: the constituent steps
 * are already bounded and sum to well under the default budget.
 */
function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ExtractionTimeoutError(`extraction exceeded produceBudgetMs (${budgetMs}ms)`))
    }, budgetMs)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * Resolve one Spotify entity to normalized metadata.
 *
 * `cfg.produceBudgetMs` bounds the whole call -- navigate, scroll and settle
 * together, not just navigation (`navTimeoutMs` is the narrower bound for
 * that). The cache's single-flight lock derives its TTL from the same number,
 * so this enforces it as a real ceiling rather than trusting the steps to add
 * up.
 */
export async function extract(
  kind: 'track' | 'album' | 'playlist',
  id: string,
  pool: Pool,
  cfg: Config,
): Promise<Track | Album | Playlist> {
  return withBudget(runExtraction(kind, id, pool, cfg), cfg.produceBudgetMs)
}

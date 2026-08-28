import type { Page, Response } from 'playwright'
import type { Pool } from './browser.js'
import type { Config } from './config.js'
import {
  albumItemCount,
  albumTotalCount,
  normalizeAlbum,
  normalizePlaylist,
  normalizeTrack,
  playlistItemCount,
  playlistTotalCount,
} from './normalize.js'
import type { Album, Playlist, Recorded, Track } from './types.js'

// Distinct on purpose: a 404 means the entity doesn't exist. This means
// navigation succeeded and nothing recognizable came back -- our extraction
// stopped matching Spotify's page. Confusing the two is exactly how the
// prior art this project replaces died: silently, returning nothing that
// looked like an error. This one must be loud, and a caller must never let
// it populate the cache.
export class NotFoundError extends Error {}
export class ExtractionEmptyError extends Error {}

// Zero tracks is the extreme, unambiguous case of the same underlying
// failure: extraction stopped matching Spotify's page. This one covers the
// case a bare "tracks.length === 0" check can't see -- a partial recovery
// (a scroll that stopped early, a dropped page) that still returns *some*
// tracks and so still looks plausible to a caller that never checks the
// declared total against what actually came back. Fix round 1 found that
// nothing did. Kept distinct from ExtractionEmptyError, for the same reason
// that one is distinct from NotFoundError: "recovered fewer tracks than
// declared" and "recovered zero tracks" are different diagnoses even though
// both are the same class of bug.
//
// Fix round 3: the check below compares the number of raw items *seen*
// against Spotify's declared total, not the number of tracks that survived
// normalize.ts's own validation (no name, no artists -> dropped). Those are
// different failures: a dropped item is Task 2's validation rule doing its
// job on one bad/region-locked track, not a missed page. Conflating them
// made this error fire on a perfectly complete extraction that happened to
// contain one malformed item -- and because this error is never cached,
// that failed every retry, forever. See normalize.ts's `albumItemCount` /
// `playlistItemCount` for where "seen" comes from.
export class ExtractionIncompleteError extends Error {}

// Task 6 fix round 1: `withBudget` used to reject with a bare `Error` whose
// message merely *named* produceBudgetMs, and Task 6's HTTP layer matched a
// 504 by regex-testing that message. That coupled the HTTP layer to this
// file's exact wording with no compiler check -- a message edit here would
// silently downgrade every timeout to a generic 502, exactly the kind of
// silent failure this whole project exists to eliminate. A fourth error
// class, alongside the three above, makes the 504 mapping an `instanceof`
// check instead, and makes the path trivially testable via the injected
// `extract` function `buildServer` already takes -- no fake clock needed.
export class ExtractionTimeoutError extends Error {}

const SCROLL_MAX_ITERATIONS = 200
const SCROLL_STEP_DELAY_MS = 350
const SCROLL_SETTLE_MS = 3_000

/**
 * Navigate to `url` and collect every JSON response the page fetches while
 * loading, then page through a virtualized list (if there is one) so a
 * playlist or album's full track list is recovered, not just its first page.
 *
 * The scroll loop below is copied from `tools/capture.ts`'s probe, not
 * reinvented -- see `docs/captured-shapes.md` ("Pagination") for why it must
 * be exactly this technique. Two things were each measured wrong once:
 *
 *   1. `page.mouse.wheel` fires at the cursor's default position, (0,0),
 *      which is outside Spotify's virtualized track-list container. It
 *      scrolls nothing.
 *   2. Jumping straight to `scrollTop = scrollHeight` skips the middle of a
 *      virtualized list -- it only fetches rows near the viewport, so you get
 *      the first page and the last page and nothing in between.
 *
 * Stepping the actual scrollable container by ~80% of its own `clientHeight`
 * per iteration, and stopping once `scrollTop` stops advancing, recovered
 * every page of a 150-track playlist (offsets 0/25, 25/50, 75/50, 125/25 =
 * 150, matching `totalCount` exactly).
 *
 * There is no separate branch for "don't scroll on a track page": a track
 * page has no element large enough to match the container heuristic, so the
 * loop finds nothing to scroll and exits on its first iteration. The 80/20
 * split the brief describes (scroll only for albums/playlists) falls out of
 * that naturally rather than needing this function to know which kind of
 * page it's looking at.
 */
export async function recordResponses(page: Page, url: string, navTimeoutMs: number): Promise<Recorded[]> {
  const recorded: Recorded[] = []

  const onResponse = async (response: Response): Promise<void> => {
    const contentType = response.headers()['content-type'] ?? ''
    if (!contentType.includes('json')) return
    try {
      recorded.push({ url: response.url(), status: response.status(), body: await response.json() })
    } catch {
      // A JSON content-type that doesn't actually parse as JSON isn't
      // interesting here -- and isn't a reason to fail the whole extraction.
    }
  }
  page.on('response', onResponse)

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: navTimeoutMs })

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
  } finally {
    // This page is a pooled, reused resource (Task 4's `Pool` hands the same
    // `Page` back out across many leases up to `contextMaxUses`). A listener
    // left attached here would keep pushing into this call's now-abandoned
    // `recorded` array on every future response on this page, for the rest
    // of the page's life -- a permanent per-lease listener leak. Remove it
    // regardless of how the block above exits.
    page.off('response', onResponse)
  }

  return recorded
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
    const recorded = await recordResponses(lease.page, entityUrl(kind, id), cfg.navTimeoutMs)
    const result = normalizeByKind(kind, recorded, id)

    if (result === null) {
      throw new NotFoundError(`no ${kind} found for id ${id}`)
    }
    // A Track has no track list to be empty. An Album/Playlist that
    // navigated fine but came back with zero tracks did NOT fail to be
    // found -- normalizeByKind would have returned null for that. It means
    // our extraction stopped matching Spotify's page (a redesign, a renamed
    // field, a discriminator that no longer holds), which is a materially
    // different failure and must never be mistaken for a 404, nor cached as
    // if it were a real, empty result.
    if ((result.type === 'album' || result.type === 'playlist') && result.tracks.length === 0) {
      throw new ExtractionEmptyError(
        `${kind} ${id} navigated successfully but yielded zero tracks -- extraction likely stopped matching Spotify's page`,
      )
    }
    // The zero-tracks check above can't see a *partial* recovery -- some
    // tracks came back, just not all of them (a scroll that stopped early,
    // a page that didn't fire). Spotify reports its own declared total
    // alongside the entity (`content.totalCount` for a playlist,
    // `tracksV2.totalCount` for an album; see normalize.ts). A partial
    // playlist is exactly what silently truncated during Task 1 -- it looks
    // like a perfectly valid, cacheable result to anyone who doesn't check.
    //
    // Compare the declared total against `seen` (raw items present across
    // recorded responses, via albumItemCount/playlistItemCount) -- NOT
    // against `result.tracks.length`. Fix round 3: comparing against
    // tracks.length made this fire on a fully complete extraction that
    // simply contained one malformed item (no name, no artists), which
    // normalize.ts correctly drops per Task 2's rule. That's validation
    // doing its job, not a missed page, and since this error is never
    // cached, treating it as incomplete failed every retry forever -- worse
    // than the truncation this check exists to catch. `seen` counts every
    // item regardless of whether it survived validation, so a dropped item
    // no longer trips this check; a genuinely unfetched page still does.
    if (result.type === 'album') {
      const declared = albumTotalCount(recorded, id)
      const seen = albumItemCount(recorded, id)
      if (declared !== null && seen !== null && seen !== declared) {
        throw new ExtractionIncompleteError(
          `album ${id} saw ${seen} of ${declared} declared tracks across recorded responses ` +
          `(${result.tracks.length} well-formed) -- extraction was incomplete`,
        )
      }
    }
    if (result.type === 'playlist') {
      const declared = playlistTotalCount(recorded, id)
      const seen = playlistItemCount(recorded, id)
      if (declared !== null && seen !== null && seen !== declared) {
        throw new ExtractionIncompleteError(
          `playlist ${id} saw ${seen} of ${declared} declared tracks across recorded responses ` +
          `(${result.tracks.length} well-formed) -- extraction was incomplete`,
        )
      }
    }
    return result
  } finally {
    // The pool cannot enforce this for us -- see Task 4's report -- so every
    // path out of this function, including a throw above, must release the
    // lease. release() is a documented no-op on a second call, so there's no
    // risk in this being the only call site.
    await lease.release()
  }
}

/**
 * Race `work` against `budgetMs`. On timeout the caller sees a rejection,
 * but `work` itself is not cancelled -- Playwright gives us no way to abort a
 * `page.evaluate`/`waitForTimeout` already in flight, and the `Pool`/`Lease`
 * interfaces (Task 4) expose no "discard this lease" operation, only
 * `release()`. In practice this almost never fires: `recordResponses`'s own
 * constituent steps are already bounded (navigation by `navTimeoutMs`, the
 * scroll loop by its fixed iteration count and per-step delay), summing to
 * comfortably less than the default budget -- see `DEFAULT_PRODUCE_BUDGET_MS`
 * in config.ts. This is a backstop against genuine anomalies (a saturated
 * pool queue, a wedged renderer), not the everyday code path. `runExtraction`
 * keeps running to completion in the background when it loses this race,
 * including its own `finally { lease.release() }`, so the lease it holds is
 * still returned to the pool once whatever was slow finally settles.
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
 * Resolve one Spotify entity to normalized metadata: acquire a page from the
 * pool, navigate and intercept (`recordResponses`), hand the result to the
 * matching pure normalizer, and release the lease.
 *
 * `cfg.produceBudgetMs` bounds this whole call -- navigation, scroll, and
 * settle together, not just navigation (`cfg.navTimeoutMs` is the separate,
 * narrower bound for that). The cache layer's single-flight lock (Task 3)
 * derives its own TTL from this same number, on the assumption that
 * `produce()` never legitimately runs longer than it -- so this function
 * enforces it as a real ceiling rather than trusting the constituent steps'
 * bounds to add up correctly on their own.
 */
export async function extract(
  kind: 'track' | 'album' | 'playlist',
  id: string,
  pool: Pool,
  cfg: Config,
): Promise<Track | Album | Playlist> {
  return withBudget(runExtraction(kind, id, pool, cfg), cfg.produceBudgetMs)
}

import type { Page, Response } from 'playwright'
import type { Pool } from './browser.js'
import type { Config } from './config.js'
import { normalizeAlbum, normalizePlaylist, normalizeTrack } from './normalize.js'
import type { Album, Playlist, Recorded, Track } from './types.js'

// Distinct on purpose: a 404 means the entity doesn't exist. This means
// navigation succeeded and nothing recognizable came back -- our extraction
// stopped matching Spotify's page. Confusing the two is exactly how the
// prior art this project replaces died: silently, returning nothing that
// looked like an error. This one must be loud, and a caller must never let
// it populate the cache.
export class NotFoundError extends Error {}
export class ExtractionEmptyError extends Error {}

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
      reject(new Error(`extraction exceeded produceBudgetMs (${budgetMs}ms)`))
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

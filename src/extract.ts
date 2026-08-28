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

// Four distinct failures, never collapsed into one. A 404 means the entity
// does not exist; the others mean our extraction stopped matching Spotify's
// page. Confusing them is how the prior art died -- silently. None of the
// latter three may ever populate the cache.
// See docs/design-notes.md ("The four extraction failures").
export class NotFoundError extends Error {}
export class ExtractionEmptyError extends Error {}

// A partial recovery that still returns *some* tracks, which a bare
// `tracks.length === 0` check cannot see.
export class ExtractionIncompleteError extends Error {}

// A class, not a message: the HTTP layer maps 504 by `instanceof`, so editing
// the wording below cannot silently downgrade every timeout to a generic 502.
export class ExtractionTimeoutError extends Error {}

const SCROLL_MAX_ITERATIONS = 200
const SCROLL_STEP_DELAY_MS = 350
const SCROLL_SETTLE_MS = 3_000

/**
 * Navigate to `url`, collect every JSON response the page fetches, and page
 * through a virtualized list so the full track list is recovered.
 *
 * The scroll technique is load-bearing and was measured wrong twice before
 * this shape worked -- do not "simplify" it without reading
 * docs/design-notes.md ("Scrolling a virtualized list") and
 * docs/captured-shapes.md ("Pagination").
 *
 * A track page needs no special case: nothing matches the container
 * heuristic, so the loop exits on its first iteration.
 */
export async function recordResponses(page: Page, url: string, navTimeoutMs: number): Promise<Recorded[]> {
  const recorded: Recorded[] = []

  const onResponse = async (response: Response): Promise<void> => {
    const contentType = response.headers()['content-type'] ?? ''
    if (!contentType.includes('json')) return
    try {
      recorded.push({ url: response.url(), status: response.status(), body: await response.json() })
    } catch {
      // A JSON content-type that isn't JSON is not a reason to fail.
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
    // The page is pooled and reused. A listener left attached would keep
    // pushing into this call's abandoned array for the rest of the page's
    // life -- a per-lease leak.
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
    // Navigated fine but zero tracks is not a 404 -- normalizeByKind returns
    // null for that. It means extraction stopped matching Spotify's page.
    if ((result.type === 'album' || result.type === 'playlist') && result.tracks.length === 0) {
      throw new ExtractionEmptyError(
        `${kind} ${id} navigated successfully but yielded zero tracks -- extraction likely stopped matching Spotify's page`,
      )
    }
    // Compare Spotify's declared total against `seen` -- raw items present
    // across responses -- and NOT against `result.tracks.length`. A track
    // dropped by normalize.ts's validation is that rule working, not a missed
    // page; conflating them fires on complete extractions and, since this
    // error is never cached, fails every retry forever.
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

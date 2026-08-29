import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'

type Recorded = { url: string; status: number; body: unknown }

const TARGETS: Record<string, string> = {
  // A well-known stable track.
  track: 'https://open.spotify.com/track/0c6xIDDpzE81m2q797ordA',
  // Original target (6ymZBbRSmzAvoSGmwAFoxm) was pulled from Spotify after
  // the corpus was recorded and now 404s. Replaced with a verified-working id.
  album: 'https://open.spotify.com/album/5s5svl5DzlSmEvkjuL8Upw',
  // Small: crosses one page boundary (measured totalCount 50).
  'playlist-small': 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  // Large: crosses several (measured totalCount 150). This is the pagination probe.
  'playlist-large': 'https://open.spotify.com/playlist/37i9dQZF1DX4o1oenSJRJd',
  // Three items, one of each kind Spotify puts in a playlist: a Track, a
  // podcast Episode, and a LocalTrack. Every other fixture is editorial
  // content and therefore all Tracks -- this is the only one that exercises
  // what a real user's playlist contains. See docs/design-notes.md
  // ("Non-Track playlist items").
  'playlist-mixed': 'https://open.spotify.com/playlist/3tlExkExp1aaYcU91Qhp79',
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

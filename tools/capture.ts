import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'

type Recorded = { url: string; status: number; body: unknown }

const TARGETS: Record<string, string> = {
  // A well-known stable track.
  track: 'https://open.spotify.com/track/0c6xIDDpzE81m2q797ordA',
  album: 'https://open.spotify.com/album/6ymZBbRSmzAvoSGmwAFoxm',
  // Small: well under one page of tracks.
  'playlist-small': 'https://open.spotify.com/playlist/37i9dQZF1DX4o1oenSJRJd',
  // Large: MUST be >100 tracks. This is the pagination probe.
  'playlist-large': 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
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

  // Scroll to the bottom repeatedly. If the track list is virtualized and
  // paginated, this is what triggers the later pages -- and whether it does is
  // precisely what this probe exists to find out.
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 20_000)
    await page.waitForTimeout(400)
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

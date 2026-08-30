import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server.js'
import { MemoryStore } from '../src/cache.js'
import { loadConfig } from '../src/config.js'
import { NotFoundError, ExtractionEmptyError, evidenceFrom } from '../src/extract.js'
import type { Recorded } from '../src/types.js'

type Line = { level: string; obj: Record<string, unknown> | undefined; msg: string | undefined }

/**
 * Fastify accepts any object carrying the pino method set, so this collects
 * lines without pulling pino into the test or writing to a real stream.
 */
function recordingLogger(): { lines: Line[] } & Record<string, unknown> {
  const lines: Line[] = []
  const push =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      if (typeof obj === 'string') lines.push({ level, obj: undefined, msg: obj })
      else lines.push({ level, obj: obj as Record<string, unknown>, msg })
    }
  const logger = {
    lines,
    level: 'info',
    info: push('info'),
    error: push('error'),
    warn: push('warn'),
    debug: push('debug'),
    trace: push('trace'),
    fatal: push('fatal'),
    silent: (): void => {},
    child: (): unknown => logger,
  }
  return logger as { lines: Line[] } & Record<string, unknown>
}

const cfg = loadConfig({ LOG_LEVEL: 'silent' })
const fakePool = { acquire: async () => { throw new Error('unused') }, liveContexts: () => 1, close: async () => {} }

const TRACK = { id: 'abc', type: 'track', name: 'Hideaway', artists: [{ name: 'Kiesza', id: null }], album: null, durationMs: null, url: 'https://open.spotify.com/track/abc' }

function server(extract: unknown, logger: unknown, store = new MemoryStore()) {
  return buildServer({ cfg, store, pool: fakePool as never, extract: extract as never, logger: logger as never })
}

describe('request logging', () => {
  it('emits one completion line per request carrying status, duration and cache disposition', async () => {
    const log = recordingLogger()
    const app = server(async () => TRACK, log)

    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(200)

    const completions = log.lines.filter((l) => l.msg === 'request completed')
    expect(completions).toHaveLength(1)
    expect(completions[0]!.obj).toMatchObject({
      method: 'GET',
      url: '/v1/track/abc',
      status: 200,
      cache: 'miss',
    })
    expect(typeof completions[0]!.obj!.durationMs).toBe('number')
  })

  // The whole point of step 1: when nothing matched we must be able to tell a
  // real absence from a capture that saw nothing, WITHOUT reproducing it.
  it('logs the extraction evidence when nothing matched', async () => {
    const log = recordingLogger()
    const evidence = { navStatus: 200, recorded: 0, statuses: [], paths: [] }
    const app = server(async () => {
      throw new NotFoundError('no track found for id abc', evidence)
    }, log)

    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(404)

    const diag = log.lines.find((l) => l.msg === 'extraction failed')
    expect(diag).toBeDefined()
    expect(diag!.obj).toMatchObject({ kind: 'track', id: 'abc', error: 'NotFoundError', evidence })
  })

  it('logs evidence for extraction failures other than not-found too', async () => {
    const log = recordingLogger()
    const evidence = { navStatus: 200, recorded: 3, statuses: [200], paths: ['/pathfinder/v2/query'] }
    const app = server(async () => {
      throw new ExtractionEmptyError('zero tracks', evidence)
    }, log)

    const res = await app.inject({ method: 'GET', url: '/v1/playlist/xyz' })
    expect(res.statusCode).toBe(502)

    const diag = log.lines.find((l) => l.msg === 'extraction failed')
    expect(diag!.obj).toMatchObject({ kind: 'playlist', id: 'xyz', error: 'ExtractionEmptyError', evidence })
  })

  it('logs completions for /health too, so a silent service is distinguishable from an idle one', async () => {
    const log = recordingLogger()
    const app = server(async () => TRACK, log)
    await app.inject({ method: 'GET', url: '/health' })
    expect(log.lines.filter((l) => l.msg === 'request completed')).toHaveLength(1)
  })
})

describe('evidenceFrom', () => {
  const rec = (url: string, status: number): Recorded => ({ url, status, body: {} })

  it('counts responses and reports distinct statuses in ascending order', () => {
    const e = evidenceFrom({
      navStatus: 200,
      responses: [
        rec('https://api-partner.spotify.com/pathfinder/v2/query', 200),
        rec('https://api-partner.spotify.com/pathfinder/v2/query', 404),
        rec('https://open.spotify.com/x.json', 200),
      ],
    })
    expect(e.recorded).toBe(3)
    expect(e.statuses).toEqual([200, 404])
  })

  // Zero recorded responses is the signature of a capture that saw nothing --
  // the case being misreported as "this entity does not exist".
  it('reports an empty capture distinctly from one that recorded responses', () => {
    expect(evidenceFrom({ navStatus: 200, responses: [] })).toEqual({
      navStatus: 200,
      recorded: 0,
      statuses: [],
      paths: [],
    })
  })

  it('reports distinct paths, not full URLs, and bounds how many', () => {
    const many = Array.from({ length: 20 }, (_, i) => rec(`https://x.test/p${i}?q=1`, 200))
    const e = evidenceFrom({ navStatus: 200, responses: many })
    expect(e.paths.length).toBeLessThanOrEqual(8)
    expect(e.paths[0]).toBe('/p0')
  })

  it('does not discard a response whose URL will not parse', () => {
    const e = evidenceFrom({ navStatus: 404, responses: [rec('not a url', 200)] })
    expect(e.recorded).toBe(1)
    expect(e.paths).toEqual(['not a url'])
  })
})

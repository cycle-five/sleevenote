import { chromium, type Browser } from 'playwright'
import { processTreeBytes, procReader, type ProcReader } from './procmem.js'

/** How a browser went away without being asked to. */
export type DeathCause = 'exited' | 'disconnected'

/**
 * One Chromium as an operating-system process. It knows nothing about
 * contexts or policy: the pool decides what a death or a large tree means.
 */
export type BrowserProcess = {
  readonly browser: Browser
  readonly pid: number
  /** True once the process has exited or the connection to it has dropped. */
  readonly dead: boolean
  /**
   * Called once, on the first of process exit or disconnect -- never for a
   * death close() caused. A callback registered after the death is called
   * straight away.
   */
  onDeath(cb: (cause: DeathCause) => void): void
  /**
   * Close gracefully, and SIGKILL the process if that has not finished within
   * `ms`. Resolves once the process is gone, or after a further `ms` if even
   * the kill cannot be confirmed. Never rejects.
   */
  close(ms: number): Promise<void>
  /** PSS of the whole process tree in bytes, or null where unmeasurable. */
  memoryBytes(): number | null
}

export type LaunchOptions = {
  proc?: ProcReader
  /** Test-only: the graceful close never finishes, so close() has to kill. */
  hangGracefulClose?: boolean
}

// Chromium starts in well under a second on every host measured. This bounds
// a launch that has wedged, so a relaunch attempt fails instead of hanging.
const LAUNCH_TIMEOUT_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd so a pending wait cannot hold the process open at shutdown.
    setTimeout(resolve, ms).unref()
  })
}

/**
 * `launchServer()` rather than `launch()`: it hands back the child process,
 * which is what gives the pool a pid to measure, an exit to watch, and a
 * SIGKILL for a browser that ignores close(). The pool drives it through
 * `connect()` over a loopback WebSocket.
 */
export async function launchBrowserProcess(opts: LaunchOptions = {}): Promise<BrowserProcess> {
  // Shutdown is index.ts's to order: close HTTP, then the pool. Playwright's
  // own SIGTERM/SIGINT/SIGHUP handlers ran first and closed Chromium under
  // in-flight lookups, and the pool read that as a crash -- every deploy
  // counted one and relaunched mid-drain. Its `exit` handler is installed
  // regardless, so a Node that exits without close() still kills the browser.
  const server = await chromium.launchServer({
    timeout: LAUNCH_TIMEOUT_MS,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  })
  const child = server.process()
  const pid = child.pid
  if (pid === undefined) {
    await server.kill().catch(() => {})
    throw new Error('Chromium launched without a pid')
  }
  let browser: Browser
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: LAUNCH_TIMEOUT_MS })
  } catch (err) {
    await server.kill().catch(() => {})
    throw err
  }

  const proc = opts.proc ?? procReader()
  let exited = child.exitCode !== null || child.signalCode !== null
  let dead = exited
  let deathCause: DeathCause | null = exited ? 'exited' : null
  let closing = false
  let deathCallback: ((cause: DeathCause) => void) | null = null
  const exitSeen = new Promise<void>((resolve) => {
    if (exited) resolve()
    else child.once('exit', () => resolve())
  })

  const die = (cause: DeathCause): void => {
    if (dead) return
    dead = true
    deathCause = cause
    if (!closing) deathCallback?.(cause)
  }
  child.once('exit', () => {
    exited = true
    die('exited')
  })
  browser.once('disconnected', () => die('disconnected'))

  return {
    browser,
    pid,
    get dead() {
      return dead
    },
    onDeath(cb) {
      deathCallback = cb
      if (dead && !closing && deathCause !== null) {
        const cause = deathCause
        queueMicrotask(() => cb(cause))
      }
    },
    async close(ms) {
      closing = true
      if (exited) return
      const graceful = opts.hangGracefulClose ? new Promise<void>(() => {}) : server.close().catch(() => {})
      const outcome = await Promise.race([
        graceful.then(() => 'closed' as const),
        sleep(ms).then(() => 'timed out' as const),
      ])
      if (outcome === 'timed out') {
        console.warn(`[browser] pid ${pid} did not close within ${ms}ms -- killing it`)
        await server.kill().catch(() => {})
      }
      await Promise.race([exitSeen, sleep(ms)])
    },
    memoryBytes() {
      return dead ? null : processTreeBytes(pid, proc)
    },
  }
}

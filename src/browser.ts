import type { BrowserContext, Page } from 'playwright'
import type { Config } from './config.js'
import { launchBrowserProcess, type BrowserProcess, type DeathCause } from './browser-process.js'

export type Lease = {
  page: Page
  release: () => Promise<void>
  /**
   * Aborted if this lease's browser dies while the lease is held, with the
   * reason as its `reason`. A deadline revocation does not abort it: the
   * caller has already been answered by then.
   */
  lost: AbortSignal
}

export type PoolStats = {
  free: number
  leased: number
  waiting: number
  generations: { serving: number; draining: number }
  /** Age of the serving browser; null while none is serving. */
  browserAgeSeconds: number | null
  /** PSS of the serving browser's process tree at the last sample; null if unmeasurable. */
  browserMemoryBytes: number | null
}

/** Why a browser generation was launched: the label on sleevenote_browser_launches_total. */
export type LaunchReason = 'startup' | 'recycle_age' | 'recycle_leases' | 'recycle_memory' | 'crash'

export type LaunchEvent = { reason: LaunchReason; generation: number; pid: number }

/** Told about launches, so this module never imports the metrics registry. */
export type PoolObserver = {
  launched(event: LaunchEvent): void
  launchFailed(): void
}

export interface Pool {
  /**
   * A free context, or a place in the queue for one.
   *
   * With `deadline`, the pool -- not the holder -- owns when the lease ends. A
   * caller still queued when it fires is rejected and leaves the queue. A
   * lease still held when it fires is revoked: its context is closed, which
   * fails every Playwright call still pending on it, and a fresh context
   * takes its slot. The holder's own `release()` is then a no-op.
   */
  acquire(deadline?: AbortSignal): Promise<Lease>
  liveContexts(): number
  stats(): PoolStats
  close(): Promise<void>
}

// The corpus in tests/fixtures was recorded with exactly these blocked. A pool
// that served unblocked pages would show production a different page than the
// normalizer was built against.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media'])

/**
 * One browser process and the contexts made from it. Exactly one generation
 * serves at a time; see
 * docs/superpowers/specs/2026-09-19-browser-context-manager-design.md.
 */
type Generation = {
  id: number
  process: BrowserProcess
  state: 'starting' | 'serving' | 'draining' | 'closed'
  startedAt: number
  /** Leases ever handed out from this generation. */
  leases: number
  /** Every context of this generation not yet closed, free or leased. */
  records: Set<ContextRecord>
  free: ContextRecord[]
  /** The last sample of the process tree's memory; null if unmeasurable. */
  memoryBytes: number | null
}

type ContextRecord = {
  context: BrowserContext
  page: Page
  uses: number
  gen: Generation
  /** The current lease's `lost` controller; null while the record is free. */
  lost: AbortController | null
}

type Waiter = { resolve: (record: ContextRecord) => void; reject: (err: Error) => void }

export class PoolClosedError extends Error {
  constructor() {
    super('browser pool closed while waiting for a free context')
  }
}

/** No browser could serve: the lease's browser died, or none was serving while the caller waited. */
export class BrowserUnavailableError extends Error {}

/** A caller waited POOL_WAIT_CAP_MS for a context while a browser was serving. */
export class PoolOverloadedError extends Error {}

// Test-only fault injection, not part of the Pool contract: `createPool(cfg)`
// alone is the real signature. The hooks ride in the same options object as
// the real ones, so every existing call site keeps working.
type TestFaultHooks = {
  failNextContextCreations?: number
  hangNextContextCloses?: number
  /** Replaces the `/proc` reading of a generation's memory. */
  memoryOf?: (pid: number) => number | null
  /** Launches after startup that fail before starting Chromium. */
  failNextLaunches?: number
  /** Replaces the 1s base of the relaunch and recycle backoff. */
  backoffBaseMs?: number
  /** Replaces the clock the age trigger reads. */
  now?: () => number
  /**
   * Called with each launched browser's pid once it is connected and before
   * its contexts are made -- where a test can SIGSTOP it into the wedged but
   * alive browser the fill bound exists for. Awaited, so a test can also hold
   * the launch there while something else happens.
   */
  afterConnect?: (pid: number) => void | Promise<void>
  /** Replaces FILL_TIMEOUT_MS. */
  fillTimeoutMs?: number
  /** Replaces STABLE_AFTER_MS. */
  stableAfterMs?: number
}

export type PoolOptions = {
  observer?: PoolObserver
  /**
   * Called once when the browser has failed `browserMaxRelaunchFailures`
   * times in a row -- a launch that failed, or a serving browser that died
   * inside STABLE_AFTER_MS. index.ts exits the process, so the container
   * restart policy gives it a clean start; the pool never exits by itself.
   */
  onFatal?: (err: Error) => void
} & TestFaultHooks

/**
 * Close `context`, but stop waiting after `ms`. A context whose renderer has
 * wedged can hold `close()` open indefinitely, and the caller here is always a
 * release: waiting on it would hold the slot exactly as a stuck holder did.
 * The context is abandoned rather than awaited, and the pool replaces it.
 */
async function closeWithin(close: () => Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const gaveUp = new Promise<'gave up'>((resolve) => {
    timer = setTimeout(() => resolve('gave up'), ms)
  })
  const outcome = await Promise.race([close().then(() => 'closed' as const, () => 'closed' as const), gaveUp])
  clearTimeout(timer)
  if (outcome === 'gave up') {
    console.warn(`[pool] a context did not close within ${ms}ms -- abandoning it and creating a replacement`)
  }
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000
// A fill of POOL_SIZE contexts takes well under a second. This bounds one
// that has wedged; see fill().
const FILL_TIMEOUT_MS = 30_000
// A serving browser that dies younger than this counts toward
// BROWSER_MAX_RELAUNCH_FAILURES, as a failed launch does; see onDeath().
const STABLE_AFTER_MS = 60_000

/** Resolves after `ms`, or as soon as `wake` aborts. */
function sleep(ms: number, wake?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (wake?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      wake?.removeEventListener('abort', done)
      resolve()
    }
    // Unref'd so a pending backoff cannot hold the process open at shutdown.
    const timer = setTimeout(done, ms)
    timer.unref()
    wake?.addEventListener('abort', done, { once: true })
  })
}

/** First line only: Playwright folds a stack into `message`. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n')[0] ?? message
}

/**
 * Generations of browsers backing `cfg.poolSize` reused contexts each.
 * `acquire()` hands out a free context from the serving generation, or queues
 * FIFO until one is released.
 *
 * See docs/design-notes.md for why the pool is shaped this way.
 */
export async function createPool(cfg: Config, opts: PoolOptions = {}): Promise<Pool> {
  // Armed only after the startup generation is filled, so an injected fault
  // exercises the path under test rather than being consumed by warm-up.
  let failuresRemaining = 0
  let closeHangsRemaining = 0
  let nextGenerationId = 1
  let serving: Generation | null = null
  const draining = new Set<Generation>()
  const waiters: Waiter[] = []
  // Set once by close(); read by every inner function below via closure.
  let closed = false
  let launchFailuresRemaining = 0
  let relaunching = false
  // Kept so close() can wait for it: a relaunch mid-launch at close() would
  // otherwise leave its Chromium running after close() had resolved.
  let relaunchInFlight: Promise<void> | null = null
  let relaunchFailures = 0
  // Aborted by close(), so a relaunch sleeping out its backoff wakes and
  // stops rather than holding close() for up to BACKOFF_CAP_MS.
  const shutdown = new AbortController()
  const onFatal =
    opts.onFatal ?? ((err: Error) => console.error(`[pool] giving up on the browser: ${firstLine(err)}`))
  const backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS
  const fillTimeoutMs = opts.fillTimeoutMs ?? FILL_TIMEOUT_MS
  const stableAfterMs = opts.stableAfterMs ?? STABLE_AFTER_MS

  function backoff(attempt: number): number {
    return Math.min(backoffBaseMs * 2 ** (attempt - 1), BACKOFF_CAP_MS)
  }

  const now = opts.now ?? Date.now
  // At most one launch in flight: a recycle, or a relaunch's wait on it.
  let launchInFlight: Promise<void> | null = null
  let recycleFailures = 0
  let nextRecycleAt = 0

  async function createContext(gen: Generation): Promise<ContextRecord> {
    if (failuresRemaining > 0) {
      failuresRemaining--
      throw new Error('injected context-creation failure (test)')
    }
    const context = await gen.process.browser.newContext()
    const page = await context.newPage()
    await page.route('**/*', (route) => {
      const type = route.request().resourceType()
      if (BLOCKED_RESOURCE_TYPES.has(type)) return route.abort()
      return route.continue()
    })
    const record: ContextRecord = { context, page, uses: 0, gen, lost: null }
    gen.records.add(record)
    return record
  }

  function sampleMemory(gen: Generation): number | null {
    return opts.memoryOf ? opts.memoryOf(gen.process.pid) : gen.process.memoryBytes()
  }

  // Launched and filled, but not yet serving: nothing hands out from a
  // generation until promote() makes it the serving one.
  async function launchGeneration(reason: LaunchReason): Promise<Generation> {
    if (launchFailuresRemaining > 0) {
      launchFailuresRemaining--
      throw new Error('injected launch failure (test)')
    }
    const process = await launchBrowserProcess()
    const gen: Generation = {
      id: nextGenerationId++,
      process,
      state: 'starting',
      startedAt: now(),
      leases: 0,
      records: new Set(),
      free: [],
      memoryBytes: null,
    }
    process.onDeath((cause) => onDeath(gen, cause))
    try {
      await opts.afterConnect?.(process.pid)
      await fill(gen)
      // A browser that died during the fill must not be promoted: nothing
      // would ever notice, since its death arrived while it was 'starting'.
      if (process.dead) throw new Error(`browser generation ${gen.id} died before it could serve`)
      gen.memoryBytes = sampleMemory(gen)
      // Inside the try: an observer that throws fails this launch, and its
      // browser is closed here, rather than leaking a filled Chromium that
      // nothing would ever serve from or close.
      opts.observer?.launched({ reason, generation: gen.id, pid: process.pid })
    } catch (err) {
      gen.state = 'closed'
      await process.close(cfg.browserCloseTimeoutMs)
      throw err
    }
    console.warn(`[pool] browser generation ${gen.id} launched (pid ${process.pid}, ${reason})`)
    return gen
  }

  // launchServer() and connect() carry LAUNCH_TIMEOUT_MS, but newContext,
  // newPage and route carry no timeout at all, and a Chromium that is alive
  // but not answering holds them forever. Unbounded, that wedged every launch
  // path at once: a relaunch never failed, so it never escalated; a recycle
  // never finished, so close() never did; at startup createPool() never
  // resolved. Past the bound the launch fails, and launchGeneration's close()
  // SIGKILLs the browser, which rejects the calls still pending on it.
  async function fill(gen: Generation): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`browser generation ${gen.id} did not fill ${cfg.poolSize} context(s) within ${fillTimeoutMs}ms`))
      }, fillTimeoutMs)
      timer.unref()
    })
    const filling = (async () => {
      for (let i = 0; i < cfg.poolSize; i++) gen.free.push(await createContext(gen))
    })()
    try {
      await Promise.race([filling, timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  function promote(gen: Generation): void {
    const old = serving
    gen.state = 'serving'
    serving = gen
    while (waiters.length > 0 && gen.free.length > 0) waiters.shift()!.resolve(gen.free.shift()!)
    if (old !== null && old !== gen) startDraining(old)
  }

  // A draining browser never hands a context out again: its idle contexts
  // close now, and each leased one closes when its lease ends. It closes when
  // the last one does -- at most PRODUCE_BUDGET_MS away, since that is when a
  // lease is revoked.
  function startDraining(gen: Generation): void {
    gen.state = 'draining'
    draining.add(gen)
    for (const record of gen.free) {
      gen.records.delete(record)
      void closeContext(record)
    }
    gen.free = []
    console.warn(`[pool] browser generation ${gen.id} draining, ${gen.records.size} lease(s) outstanding`)
    closeIfDrained(gen)
  }

  function closeIfDrained(gen: Generation): void {
    if (gen.state !== 'draining' || gen.records.size > 0) return
    gen.state = 'closed'
    draining.delete(gen)
    console.warn(`[pool] browser generation ${gen.id} drained -- closing it`)
    void gen.process.close(cfg.browserCloseTimeoutMs)
  }

  async function closeContext(record: ContextRecord): Promise<void> {
    let close = (): Promise<void> => record.context.close()
    if (closeHangsRemaining > 0) {
      closeHangsRemaining--
      close = () => new Promise<void>(() => {}) // injected: a close that never finishes
    }
    await closeWithin(close, cfg.contextCloseTimeoutMs)
  }

  // Replacing at release time bounds what a long-lived page accumulates.
  // `record` leaves its generation up front because the old context is closed
  // regardless; a successful `createContext()` puts its replacement back, so a
  // clean replacement nets to zero. One retry absorbs a transient failure
  // without costing the pool a permanent slot.
  async function replaceContext(record: ContextRecord): Promise<ContextRecord> {
    const gen = record.gen
    gen.records.delete(record)
    await closeContext(record)
    try {
      return await createContext(gen)
    } catch (err) {
      try {
        return await createContext(gen)
      } catch (retryErr) {
        throw new Error(
          `failed to create a replacement browser context after one retry: ${String(retryErr)}`,
          { cause: err },
        )
      }
    }
  }

  async function releaseRecord(record: ContextRecord, revoked = false): Promise<void> {
    record.lost = null
    // True on entry means the pool shut down *before* this release: close()
    // has already torn the browser down, so there is nothing to hand back.
    if (closed) return
    const gen = record.gen

    if (gen.state !== 'serving') {
      // A draining or dead browser never hands a context out again.
      gen.records.delete(record)
      await closeContext(record)
      closeIfDrained(gen)
      return
    }

    let returned: ContextRecord
    try {
      // Replace on a crashed page as well as at the use budget: a dead
      // renderer would otherwise sit in `free` being handed out until it
      // happened to also reach `contextMaxUses`.
      //
      // And always on a revoked lease: its holder may still be running against
      // this page, so the page must not go back out.
      returned =
        revoked || record.uses >= cfg.contextMaxUses || record.page.isClosed()
          ? await replaceContext(record)
          : record
    } catch (err) {
      // close() won a race with the replacement, or the browser went away
      // under it. Either way a waiter will be served, or rejected, by what
      // happens next -- there is nothing to strand here.
      if (closed || gen.state !== 'serving') return
      // The old context is gone and its replacement could not be created. A
      // waiter queued for this slot would wait forever, so fail it with the
      // real cause rather than stranding it.
      const error = err instanceof Error ? err : new Error(String(err))
      const waiter = waiters.shift()
      if (waiter) waiter.reject(error)
      throw error
    }

    if (closed) {
      // close() ran during the replacement and knows nothing about the context
      // it just produced. Nothing will ever read `free` again, so close it.
      await returned.context.close().catch(() => {})
      return
    }
    if (gen.state !== 'serving') {
      // The generation stopped serving while the replacement was being made.
      gen.records.delete(returned)
      await closeContext(returned)
      closeIfDrained(gen)
      return
    }

    const waiter = waiters.shift()
    if (waiter) waiter.resolve(returned)
    else gen.free.push(returned)
    checkRecycle()
  }

  function makeLease(record: ContextRecord, deadline?: AbortSignal): Lease {
    record.uses++
    record.gen.leases++
    const lost = new AbortController()
    record.lost = lost
    // Whichever comes first, the holder's release() or the deadline, ends the
    // lease; the other is a no-op. A double release must not free the record
    // twice or resolve two waiters.
    let ended = false
    const revoke = (): void => {
      if (ended) return
      ended = true
      // The holder is stuck or slow, and cannot be trusted to hand this back:
      // on 2026-09-19 two holders never did, and a pool of two stayed empty
      // until a restart. Take it. Closing the context is also what stops the
      // holder -- every Playwright call it has pending rejects.
      console.warn('[pool] a lease outlived its deadline -- closing its context')
      releaseRecord(record, true).catch((err: unknown) => {
        console.warn(`[pool] replacing a revoked context failed: ${String(err)}`)
      })
    }
    deadline?.addEventListener('abort', revoke, { once: true })
    return {
      page: record.page,
      lost: lost.signal,
      release: async () => {
        deadline?.removeEventListener('abort', revoke)
        if (ended) return
        ended = true
        await releaseRecord(record)
      },
    }
  }

  // A browser that dies is never trusted again: every lease on it is lost, and
  // if it was serving, a relaunch starts -- at once if it had served for
  // STABLE_AFTER_MS, after a backoff if it had not.
  function onDeath(gen: Generation, cause: DeathCause): void {
    // A 'starting' generation is launchGeneration's to handle: its fill fails,
    // or its `dead` check catches it, and the launch is reported as failed.
    if (closed || gen.state === 'closed' || gen.state === 'starting') return
    const wasServing = gen.state === 'serving'
    gen.state = 'closed'
    draining.delete(gen)
    console.warn(
      `[pool] browser generation ${gen.id} (pid ${gen.process.pid}) died (${cause}) while ${wasServing ? 'serving' : 'draining'}`,
    )
    // Out of reach before anyone hears of the death: a `lost` listener runs
    // synchronously inside the loop below, and one that acquires at once has
    // to queue for the relaunch, not be handed a context on this browser.
    gen.free = []
    if (wasServing) serving = null
    const reason = new BrowserUnavailableError(`the browser died (${cause}) while this lookup was using it`)
    for (const record of gen.records) record.lost?.abort(reason)
    gen.records.clear()
    // A dropped connection can leave the process itself running.
    void gen.process.close(cfg.browserCloseTimeoutMs)
    if (!wasServing) return

    // "Consecutive failures" counts a browser that died young as well as a
    // launch that failed. One that fills and then dies soon after -- an OOM,
    // a crash on its first navigation, pid pressure from zombies -- would
    // otherwise reset the count at every promote and be relaunched at once,
    // forever, when a container restart is exactly what clears that state.
    // Not a launchFailed(): the launch worked, and the death already shows
    // as the next launches_total{reason="crash"}.
    const age = now() - gen.startedAt
    if (age >= stableAfterMs) {
      relaunchFailures = 0
    } else {
      relaunchFailures++
      console.warn(
        `[pool] browser generation ${gen.id} died ${age}ms after launch, inside the ${stableAfterMs}ms ` +
          `stability window -- failure ${relaunchFailures} of ${cfg.browserMaxRelaunchFailures}`,
      )
      if (relaunchFailures >= cfg.browserMaxRelaunchFailures) {
        giveUp(new Error(`browser generation ${gen.id} died (${cause}) ${age}ms after launch`))
        return
      }
    }
    startRelaunch()
  }

  // Past the limit the pool stops: everyone waiting is failed now rather than
  // at their wait cap, and onFatal decides what happens to the process.
  function giveUp(error: Error): void {
    console.error(`[pool] ${relaunchFailures} browser failures in a row -- giving up on the browser`)
    while (waiters.length > 0) {
      waiters.shift()!.reject(new BrowserUnavailableError('the pool gave up on the browser'))
    }
    onFatal(error)
  }

  function startRelaunch(): void {
    if (relaunching) return
    // relaunch() answers every launch failure itself. What reaches here is an
    // observer or onFatal that threw: give up on it explicitly rather than
    // leaving nothing serving behind an unhandled rejection.
    relaunchInFlight = relaunch().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[pool] relaunching stopped on an unexpected error: ${firstLine(error)}`)
      onFatal(error)
    })
  }

  // Keeps trying until something serves, backing off between failures. A
  // queued caller is served by whichever launch succeeds. Past the limit, the
  // pool stops, rejects everyone waiting, and hands the decision to onFatal.
  async function relaunch(): Promise<void> {
    if (relaunching) return
    relaunching = true
    try {
      // A recycle launching when the browser died will adopt the empty slot
      // itself; wait for it rather than launching a second browser.
      if (launchInFlight !== null) await launchInFlight
      // Non-zero here only when the browser that died was young (onDeath
      // resets it otherwise), and that death waits out its backoff as a
      // failed launch would.
      if (relaunchFailures > 0 && !closed && serving === null) {
        await sleep(backoff(relaunchFailures), shutdown.signal)
      }
      while (!closed && serving === null) {
        try {
          const gen = await launchGeneration('crash')
          if (closed) {
            await gen.process.close(cfg.browserCloseTimeoutMs)
            return
          }
          // The count is NOT reset here: a browser that fills fine and then
          // dies young is the crash loop this has to catch. It resets once
          // this generation has served for STABLE_AFTER_MS (on the tick, or
          // at its death).
          promote(gen)
        } catch (err) {
          // close() ran during this launch. It is no failure of the browser,
          // and onFatal must not exit a process that is shutting down cleanly.
          if (closed) return
          const error = err instanceof Error ? err : new Error(String(err))
          relaunchFailures++
          opts.observer?.launchFailed()
          console.warn(
            `[pool] relaunch ${relaunchFailures} of ${cfg.browserMaxRelaunchFailures} failed: ${firstLine(error)}`,
          )
          if (relaunchFailures >= cfg.browserMaxRelaunchFailures) {
            giveUp(error)
            return
          }
          await sleep(backoff(relaunchFailures), shutdown.signal)
        }
      }
    } finally {
      relaunching = false
    }
  }

  function recycleReason(gen: Generation): LaunchReason | null {
    if (now() - gen.startedAt >= cfg.browserMaxAgeMs) return 'recycle_age'
    if (gen.leases >= cfg.browserMaxLeases) return 'recycle_leases'
    const limit = cfg.browserMaxMemoryMb * 1024 * 1024
    if (limit > 0 && gen.memoryBytes !== null && gen.memoryBytes >= limit) return 'recycle_memory'
    return null
  }

  // Checked at every release and on every tick. One recycle at a time, none
  // while a relaunch is under way, and none inside a failed recycle's backoff.
  function checkRecycle(): void {
    if (closed || serving === null || relaunching || launchInFlight !== null) return
    if (now() < nextRecycleAt) return
    const reason = recycleReason(serving)
    if (reason === null) return
    const op = recycle(serving, reason)
    launchInFlight = op
    void op.finally(() => {
      if (launchInFlight === op) launchInFlight = null
    })
  }

  // Blue/green: the replacement is launched and filled before anything moves,
  // so no caller ever waits on a recycle. A failed launch leaves the old
  // browser serving -- it still works, which is the point -- and never
  // escalates. Never rejects.
  async function recycle(old: Generation, reason: LaunchReason): Promise<void> {
    console.warn(`[pool] recycling browser generation ${old.id}: ${reason}`)
    let gen: Generation
    try {
      gen = await launchGeneration(reason)
    } catch (err) {
      recycleFailures++
      nextRecycleAt = now() + backoff(recycleFailures)
      opts.observer?.launchFailed()
      // The old browser may have died while this one launched; then nothing
      // is serving, and the relaunch waiting on this launch takes over.
      console.warn(
        serving === old
          ? `[pool] recycle launch failed; generation ${old.id} keeps serving: ${firstLine(err)}`
          : `[pool] recycle launch failed, and generation ${old.id} is no longer serving: ${firstLine(err)}`,
      )
      return
    }
    recycleFailures = 0
    nextRecycleAt = 0
    // The old browser may have died while this one launched. If nothing serves
    // now, this one does; if something else took over, this one is surplus.
    if (closed || (serving !== old && serving !== null)) {
      gen.state = 'closed'
      await gen.process.close(cfg.browserCloseTimeoutMs)
      return
    }
    promote(gen)
  }

  // Read below as `startupGen`, not `serving`: TypeScript narrows `serving`
  // here to its `null` initializer, because it does not see promote()
  // reassign it (microsoft/TypeScript#9998).
  const startupGen = await launchGeneration('startup')
  promote(startupGen)
  failuresRemaining = opts.failNextContextCreations ?? 0
  closeHangsRemaining = opts.hangNextContextCloses ?? 0
  launchFailuresRemaining = opts.failNextLaunches ?? 0

  const tick = setInterval(() => {
    if (serving !== null) {
      serving.memoryBytes = sampleMemory(serving)
      // Stable: the failures that led up to this browser are behind it. Reset
      // here and not only at its death, because a recycle's replacement dies
      // with its own age, and would otherwise inherit a count this browser
      // had long since outlived.
      if (now() - serving.startedAt >= stableAfterMs) relaunchFailures = 0
    }
    checkRecycle()
  }, cfg.browserCheckIntervalMs)
  tick.unref()
  if (startupGen.memoryBytes === null) {
    console.warn('[pool] browser memory is not measurable here -- the memory recycle trigger is off')
  }

  return {
    async acquire(deadline?: AbortSignal): Promise<Lease> {
      if (closed) throw new Error('browser pool is closed')
      deadline?.throwIfAborted()
      const ready = serving?.free.shift()
      if (ready !== undefined) return makeLease(ready, deadline)
      const queued = await new Promise<ContextRecord>((resolve, reject) => {
        let capTimer: NodeJS.Timeout | undefined
        const settle = (): void => {
          deadline?.removeEventListener('abort', onDeadline)
          clearTimeout(capTimer)
        }
        // A caller leaves the queue when its deadline passes or its wait cap
        // does. Left in it, it would be handed the next free context after it
        // had stopped listening, ahead of a caller that is still waiting.
        const leave = (err: unknown): void => {
          const i = waiters.indexOf(waiter)
          if (i !== -1) waiters.splice(i, 1)
          settle()
          reject(err)
        }
        const onDeadline = (): void => leave(deadline?.reason)
        const waiter: Waiter = {
          resolve: (r) => {
            settle()
            resolve(r)
          },
          reject: (err) => {
            settle()
            reject(err)
          },
        }
        // Which answer depends on why nothing came free: every context busy,
        // or no browser at all while a relaunch is pending.
        capTimer = setTimeout(() => {
          leave(
            serving !== null
              ? new PoolOverloadedError(`no browser context came free within ${cfg.poolWaitCapMs}ms`)
              : new BrowserUnavailableError(`no browser was serving for the ${cfg.poolWaitCapMs}ms this lookup waited`),
          )
        }, cfg.poolWaitCapMs)
        capTimer.unref()
        deadline?.addEventListener('abort', onDeadline, { once: true })
        waiters.push(waiter)
      })
      if (deadline?.aborted) {
        // Handed a context in the same tick the deadline fired. Nothing has
        // touched it, so pass it on rather than revoking a good context.
        await releaseRecord(queued)
        throw deadline.reason
      }
      return makeLease(queued, deadline)
    },

    // The serving generation only, filtered by the same predicate
    // `releaseRecord` replaces on. An unfiltered count is how `/health` kept
    // answering "ok" while every request against a crashed context failed.
    liveContexts(): number {
      if (serving === null) return 0
      let live = 0
      for (const record of serving.records) {
        if (!record.page.isClosed()) live++
      }
      return live
    },

    // Read at scrape time by /metrics. Counted across every generation, so a
    // lease still held by a draining browser shows up; `leased` includes a
    // record in transit to a waiter.
    stats(): PoolStats {
      const gens = [...(serving === null ? [] : [serving]), ...draining]
      let leased = 0
      for (const gen of gens) leased += gen.records.size - gen.free.length
      return {
        free: serving?.free.length ?? 0,
        leased,
        waiting: waiters.length,
        generations: { serving: serving === null ? 0 : 1, draining: draining.size },
        browserAgeSeconds: serving === null ? null : (now() - serving.startedAt) / 1000,
        browserMemoryBytes: serving?.memoryBytes ?? null,
      }
    },

    async close(): Promise<void> {
      closed = true
      shutdown.abort()
      clearInterval(tick)
      // Nothing will ever release into a closing pool.
      while (waiters.length > 0) waiters.shift()!.reject(new PoolClosedError())
      const gens = [...(serving === null ? [] : [serving]), ...draining]
      serving = null
      draining.clear()
      for (const gen of gens) gen.state = 'closed'
      // Tears down contexts still out on unreleased leases too, so a leaked
      // lease cannot leak a Chromium process past shutdown.
      await Promise.all(gens.map((gen) => gen.process.close(cfg.browserCloseTimeoutMs)))
      // A recycle or relaunch mid-launch sees `closed` and closes what it
      // launched; wait for it, or its Chromium outlives close(). The fill
      // bound is what makes this wait finite.
      if (launchInFlight !== null) await launchInFlight
      if (relaunchInFlight !== null) await relaunchInFlight
    },
  }
}

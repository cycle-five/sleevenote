# Browser Context Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn sleevenote's browser pool into a manager that survives a Chromium crash, recycles the browser before it ages, and sheds load quickly instead of queueing for the whole budget.

**Architecture:**
- **Generations:** the pool (`src/browser.ts`) manages *generations*, one Chromium process plus its contexts each. Exactly one generation serves at a time.
- **The process:** a new `BrowserProcess` (`src/browser-process.ts`) launches Chromium with `launchServer()`, so the pool holds the real OS process. That gives it a pid, an exit event, and SIGKILL.
- **Memory:** a new `procmem` module (`src/procmem.ts`) sums the PSS of that process tree.
- **Recycling** is blue/green, on age, leases served or memory.
- **After a crash** the pool relaunches with backoff, and escalates to an injected `onFatal`.
- **Load shedding:** a queue wait cap answers 503.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), Node >= 22, Playwright 1.62.1, vitest 4 (real Chromium in tests), fastify 5, `@prometheus-io/client`.

**Spec:** `docs/superpowers/specs/2026-09-19-browser-context-manager-design.md`. It is the authority; this plan argues from it.

## Global Constraints

- **Worktree:** `/home/lothrop/projects/sleevenote-browser-manager`, branch `feat/browser-manager`, on the unreleased 0.4.1 fix (`edab5ef`). Run every command from the worktree root.
- **Gate:** `npx tsc --noEmit` clean, and `npm test` all passing. That is 156 passing today, plus every test this plan adds. The 9 skipped tests (live and Redis) stay skipped.
- **Red first:** every new test is run and **seen failing for its stated reason** before the code that makes it pass is written. Record the failing line in your report.
- **Sabotage:** after green, break the code each new test guards, confirm the test fails, and restore. Record each run in your report.
- **Every commit ends with exactly** `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`. No other `Co-Authored-By` line, ever.
- **`git add` takes explicit paths only.** Never `git add -A` or `git add .`.
- **No push, no PR, no tag.** Those need the owner's go-ahead.
- **Preserve the existing API:** `createPool(cfg)` stays the real signature. `createPool`'s second argument keeps accepting `{ failNextContextCreations, hangNextContextCloses }` exactly as today, and new options join the same object.
- **Code style:** comments explain *why*, in the voice of the surrounding code. Log lines use the existing `[pool]`, `[browser]` and `[extract]` prefixes through `console.warn` or `console.error`.
- **Types:** typed data only, with no `any` in `src/`. Error shapes on the wire stay `{ error, id, message }`.
- **Version** goes 0.4.1 → **0.5.0**, in Task 9 only, via `npm version 0.5.0 --no-git-tag-version`.

---

### Task 1: `procmem`, the memory of a process tree

**Files:**
- Create: `src/procmem.ts`
- Test: `tests/procmem.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type ProcFs = { readdir(path: string): string[]; readFile(path: string): string }`
  - `export type ProcReader = { pids(): number[] | null; parentOf(pid: number): number | null; memoryOf(pid: number): number | null }`
  - `export function procReader(fs?: ProcFs): ProcReader`
  - `export function processTreeBytes(root: number, proc?: ProcReader): number | null`

- [ ] **Step 1: Write the failing tests** in `tests/procmem.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { processTreeBytes, procReader, type ProcFs, type ProcReader } from '../src/procmem.js'

/** A process table: pid -> parent, and memory in bytes (null = exited mid-walk). */
function table(rows: Record<number, { ppid: number; bytes: number | null }>): ProcReader {
  return {
    pids: () => Object.keys(rows).map(Number),
    parentOf: (pid) => rows[pid]?.ppid ?? null,
    memoryOf: (pid) => rows[pid]?.bytes ?? null,
  }
}

describe('processTreeBytes', () => {
  it('sums a process and every descendant, and nothing else', () => {
    const proc = table({
      1: { ppid: 0, bytes: 1000 }, // init: an ancestor, not part of the tree
      10: { ppid: 1, bytes: 100 }, // the root
      11: { ppid: 10, bytes: 20 },
      12: { ppid: 10, bytes: 30 },
      13: { ppid: 11, bytes: 4 }, // a grandchild
      20: { ppid: 1, bytes: 5000 }, // unrelated
    })
    expect(processTreeBytes(10, proc)).toBe(154)
  })

  it('counts a descendant that exits mid-walk as zero, and still walks past it', () => {
    const proc = table({
      10: { ppid: 1, bytes: 100 },
      11: { ppid: 10, bytes: null },
      12: { ppid: 11, bytes: 7 },
    })
    expect(processTreeBytes(10, proc)).toBe(107)
  })

  it('is null when the root itself has exited', () => {
    expect(processTreeBytes(10, table({ 11: { ppid: 10, bytes: 5 } }))).toBeNull()
  })

  it('is null where there is no /proc', () => {
    expect(processTreeBytes(10, { pids: () => null, parentOf: () => null, memoryOf: () => 1 })).toBeNull()
  })

  it('measures this very process on Linux', () => {
    if (process.platform !== 'linux') return
    expect(processTreeBytes(process.pid)).toBeGreaterThan(0)
  })
})

describe('procReader', () => {
  function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): ProcFs {
    return {
      readdir: (path) => {
        const entries = dirs[path]
        if (entries === undefined) throw new Error(`ENOENT: ${path}`)
        return entries
      },
      readFile: (path) => {
        const body = files[path]
        if (body === undefined) throw new Error(`ENOENT: ${path}`)
        return body
      },
    }
  }

  it('lists only the numeric entries of /proc', () => {
    const proc = procReader(fakeFs({}, { '/proc': ['1', '42', 'self', 'meminfo', '7'] }))
    expect(proc.pids()).toEqual([1, 42, 7])
  })

  it('reports no /proc as null, not as an empty table', () => {
    expect(procReader(fakeFs({})).pids()).toBeNull()
  })

  // Field 2 of /proc/<pid>/stat is the command name in parentheses, and it
  // may contain spaces and ')' itself -- Chromium's do. Splitting on spaces
  // from the start reads the wrong field.
  it('reads the parent pid past a command name containing spaces and parentheses', () => {
    const proc = procReader(fakeFs({ '/proc/42/stat': '42 (chrome (a) b) S 7 42 42 0 -1 4194560' }))
    expect(proc.parentOf(42)).toBe(7)
  })

  it('prefers PSS from smaps_rollup over RSS', () => {
    const proc = procReader(
      fakeFs({
        '/proc/42/smaps_rollup': '55d0-7ffe ---p 00000000 00:00 0 [rollup]\nRss:    900 kB\nPss:    300 kB\nPss_Anon:  100 kB\n',
        '/proc/42/status': 'Name:\tchrome\nVmRSS:\t900 kB\n',
      }),
    )
    expect(proc.memoryOf(42)).toBe(300 * 1024)
  })

  it('falls back to VmRSS when smaps_rollup cannot be read', () => {
    const proc = procReader(fakeFs({ '/proc/42/status': 'Name:\tchrome\nVmRSS:\t900 kB\n' }))
    expect(proc.memoryOf(42)).toBe(900 * 1024)
  })

  it('is null for a process that has exited', () => {
    expect(procReader(fakeFs({})).memoryOf(42)).toBeNull()
    expect(procReader(fakeFs({})).parentOf(42)).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/procmem.test.ts`
Expected: FAIL. The suite cannot resolve `../src/procmem.js`.

- [ ] **Step 3: Implement** `src/procmem.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'

/**
 * The two filesystem calls reading `/proc` needs. Injected, so a test can
 * describe a process table instead of needing one.
 */
export type ProcFs = {
  readdir(path: string): string[]
  readFile(path: string): string
}

/** What the tree walk needs to know about processes. */
export type ProcReader = {
  /** Every pid listed, or null where there is no `/proc` at all. */
  pids(): number[] | null
  /** The parent of `pid`, or null if it has exited. */
  parentOf(pid: number): number | null
  /** Proportional set size in bytes, falling back to resident size; null if it has exited. */
  memoryOf(pid: number): number | null
}

const nodeFs: ProcFs = {
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
}

export function procReader(fs: ProcFs = nodeFs): ProcReader {
  return {
    pids() {
      try {
        return fs
          .readdir('/proc')
          .filter((entry) => /^\d+$/.test(entry))
          .map(Number)
      } catch {
        return null
      }
    },

    parentOf(pid) {
      try {
        const stat = fs.readFile(`/proc/${pid}/stat`)
        // Field 2, the command name, is parenthesised and may itself contain
        // spaces and ')'. Everything after the LAST ')' is space-separated:
        // the state, then the parent pid.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        const ppid = Number(fields[1])
        return Number.isInteger(ppid) ? ppid : null
      } catch {
        return null
      }
    },

    memoryOf(pid) {
      // PSS divides each shared page among the processes that map it, so a
      // tree's PSS adds up. Its RSS counts a shared page once per process,
      // which overstates a Chromium tree by a large and varying amount.
      try {
        const pss = /^Pss:\s+(\d+) kB/m.exec(fs.readFile(`/proc/${pid}/smaps_rollup`))
        if (pss) return Number(pss[1]) * 1024
      } catch {
        // No smaps_rollup (a pre-4.14 kernel, or a permissions quirk): fall back.
      }
      try {
        const rss = /^VmRSS:\s+(\d+) kB/m.exec(fs.readFile(`/proc/${pid}/status`))
        if (rss) return Number(rss[1]) * 1024
      } catch {
        // Exited mid-walk.
      }
      return null
    },
  }
}

/**
 * Memory of `root` and every descendant, in bytes. Null where there is no
 * `/proc`, or when `root` itself has exited. A descendant that exits during
 * the walk counts as zero rather than failing the whole sample.
 */
export function processTreeBytes(root: number, proc: ProcReader = procReader()): number | null {
  const pids = proc.pids()
  if (pids === null) return null
  const rootBytes = proc.memoryOf(root)
  if (rootBytes === null) return null

  const children = new Map<number, number[]>()
  for (const pid of pids) {
    const parent = proc.parentOf(pid)
    if (parent === null) continue
    const siblings = children.get(parent)
    if (siblings) siblings.push(pid)
    else children.set(parent, [pid])
  }

  let total = rootBytes
  const seen = new Set([root])
  const stack = [...(children.get(root) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    total += proc.memoryOf(pid) ?? 0
    stack.push(...(children.get(pid) ?? []))
  }
  return total
}
```

- [ ] **Step 4: Run the tests and the typecheck.** Run `npx vitest run tests/procmem.test.ts && npx tsc --noEmit`. Expected: 11 passed, and tsc clean.

- [ ] **Step 5: Sabotage each test, then restore:**
  - Split `stat` on spaces from the start: the parenthesis test fails.
  - Swap the PSS and VmRSS order: the PSS test fails.
  - Drop `?? 0`, so the result turns into `NaN`: the mid-walk test fails.
  - Remove `if (seen.has(pid)) continue`: nothing fails, since the tables are acyclic. That's acceptable; say so in the report.

- [ ] **Step 6: Commit**

```bash
git add src/procmem.ts tests/procmem.test.ts
git commit -m "feat(procmem): measure a process tree's memory as PSS from /proc

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 2: `BrowserProcess`, one Chromium as an OS process

**Files:**
- Create: `src/browser-process.ts`
- Test: `tests/browser-process.test.ts`

**Interfaces:**
- Consumes: `processTreeBytes`, `procReader` and `ProcReader` from Task 1.
- Produces:
  - `export type DeathCause = 'exited' | 'disconnected'`
  - `export type BrowserProcess = { readonly browser: Browser; readonly pid: number; readonly dead: boolean; onDeath(cb: (cause: DeathCause) => void): void; close(ms: number): Promise<void>; memoryBytes(): number | null }`
  - `export type LaunchOptions = { proc?: ProcReader; hangGracefulClose?: boolean }`
  - `export async function launchBrowserProcess(opts?: LaunchOptions): Promise<BrowserProcess>`

- [ ] **Step 1: Write the failing tests** in `tests/browser-process.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { launchBrowserProcess, type DeathCause } from '../src/browser-process.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

describe('launchBrowserProcess', () => {
  it('launches a Chromium it can name, use and measure, and closes it for good', async () => {
    const bp = await launchBrowserProcess()
    try {
      expect(bp.pid).toBeGreaterThan(0)
      expect(isAlive(bp.pid)).toBe(true)
      expect(bp.dead).toBe(false)
      const context = await bp.browser.newContext()
      const page = await context.newPage()
      await page.setContent('<h1>up</h1>')
      expect(await page.textContent('h1')).toBe('up')
      if (process.platform === 'linux') expect(bp.memoryBytes()).toBeGreaterThan(0)
    } finally {
      await bp.close(5_000)
    }
    expect(isAlive(bp.pid)).toBe(false)
  }, 30_000)

  // A SIGKILL is noticed twice -- the process exits AND the connection drops.
  // The pool must hear about it once, or it relaunches twice.
  it('reports a death it did not cause, exactly once', async () => {
    const bp = await launchBrowserProcess()
    const causes: DeathCause[] = []
    bp.onDeath((cause) => causes.push(cause))
    process.kill(bp.pid, 'SIGKILL')
    expect(await waitFor(() => causes.length > 0, 5_000)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(causes).toHaveLength(1)
    expect(bp.dead).toBe(true)
    expect(bp.memoryBytes()).toBeNull()
    await bp.close(1_000) // closing a dead browser is harmless
  }, 30_000)

  it('does not report its own close as a death', async () => {
    const bp = await launchBrowserProcess()
    const causes: DeathCause[] = []
    bp.onDeath((cause) => causes.push(cause))
    await bp.close(5_000)
    await new Promise((r) => setTimeout(r, 300))
    expect(causes).toEqual([])
  }, 30_000)

  it('kills a browser whose graceful close never finishes', async () => {
    const bp = await launchBrowserProcess({ hangGracefulClose: true })
    const started = Date.now()
    await bp.close(500)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await waitFor(() => !isAlive(bp.pid), 2_000)).toBe(true)
  }, 30_000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/browser-process.test.ts`
Expected: FAIL. The suite cannot resolve `../src/browser-process.js`.

- [ ] **Step 3: Implement** `src/browser-process.ts`:

```ts
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
  const server = await chromium.launchServer({ timeout: LAUNCH_TIMEOUT_MS })
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
```

- [ ] **Step 4: Run the tests and the typecheck.** Run `npx vitest run tests/browser-process.test.ts && npx tsc --noEmit`. Expected: 4 passed, and tsc clean.

- [ ] **Step 5: Sabotage each test, then restore:**
  - Delete `if (dead) return` in `die`: the "exactly once" test fails.
  - Delete `if (!closing)`: the "own close" test fails.
  - Make `close()` skip the kill when it times out: the hang test fails.

- [ ] **Step 6: Commit**

```bash
git add src/browser-process.ts tests/browser-process.test.ts
git commit -m "feat(browser-process): own Chromium as a process -- pid, death, kill, memory

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 3: Configuration for the manager

**Files:**
- Modify: `src/config.ts`
- Modify: `README.md` (the configuration table, after the `CONTEXT_CLOSE_TIMEOUT_MS` row)
- Test: `tests/config.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: seven new `Config` fields, used by Tasks 4 to 7. All are `number`, in milliseconds unless the name says otherwise: `browserMaxAgeMs`, `browserMaxLeases`, `browserMaxMemoryMb`, `browserCheckIntervalMs`, `browserCloseTimeoutMs`, `browserMaxRelaunchFailures` and `poolWaitCapMs`.

- [ ] **Step 1: Write the failing tests** in `tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig: the browser manager', () => {
  it('defaults every knob', () => {
    expect(loadConfig({})).toMatchObject({
      browserMaxAgeMs: 21_600_000,
      browserMaxLeases: 1000,
      browserMaxMemoryMb: 2048,
      browserCheckIntervalMs: 60_000,
      browserCloseTimeoutMs: 10_000,
      browserMaxRelaunchFailures: 5,
      poolWaitCapMs: 20_000,
    })
  })

  it('reads every knob from the environment', () => {
    expect(
      loadConfig({
        BROWSER_MAX_AGE_MS: '1000',
        BROWSER_MAX_LEASES: '3',
        BROWSER_MAX_MEMORY_MB: '100',
        BROWSER_CHECK_INTERVAL_MS: '50',
        BROWSER_CLOSE_TIMEOUT_MS: '200',
        BROWSER_MAX_RELAUNCH_FAILURES: '2',
        POOL_WAIT_CAP_MS: '300',
      }),
    ).toMatchObject({
      browserMaxAgeMs: 1000,
      browserMaxLeases: 3,
      browserMaxMemoryMb: 100,
      browserCheckIntervalMs: 50,
      browserCloseTimeoutMs: 200,
      browserMaxRelaunchFailures: 2,
      poolWaitCapMs: 300,
    })
  })

  it('accepts 0 for BROWSER_MAX_MEMORY_MB, which turns the memory trigger off', () => {
    expect(loadConfig({ BROWSER_MAX_MEMORY_MB: '0' }).browserMaxMemoryMb).toBe(0)
  })

  // Four existing suites shorten the budget without ever setting the cap. A
  // fixed 20s default plus a hard check would break every one of them -- and
  // any operator who did the same.
  it('derives the wait cap from a short budget rather than failing on a knob nobody set', () => {
    expect(loadConfig({ PRODUCE_BUDGET_MS: '5000' }).poolWaitCapMs).toBe(2500)
    expect(loadConfig({ PRODUCE_BUDGET_MS: '1' }).poolWaitCapMs).toBe(1)
  })

  it('refuses an explicit wait cap at or above the budget, which could never fire', () => {
    expect(() => loadConfig({ PRODUCE_BUDGET_MS: '5000', POOL_WAIT_CAP_MS: '5000' })).toThrow(/POOL_WAIT_CAP_MS/)
  })
})
```

Note: `PRODUCE_BUDGET_MS: '1'` gives a derived cap of `max(1, min(20000, 0))`, which is 1. It is *not* below the budget, but the check applies only to an explicit cap, so this is correct.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL. `toMatchObject` reports the missing fields, and the explicit-cap test reports that the function did not throw.

- [ ] **Step 3: Implement** in `src/config.ts`.

Add the fields to `Config`, after `contextCloseTimeoutMs: number`:

```ts
  browserMaxAgeMs: number
  browserMaxLeases: number
  browserMaxMemoryMb: number
  browserCheckIntervalMs: number
  browserCloseTimeoutMs: number
  browserMaxRelaunchFailures: number
  poolWaitCapMs: number
```

Add a parser next to `num` (`num` rejects 0, and 0 is how the memory trigger is turned off):

```ts
function nonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`expected a number >= 0, got ${JSON.stringify(raw)}`)
  }
  return n
}
```

Add the default next to `DEFAULT_PRODUCE_BUDGET_MS`:

```ts
// Long enough to sit behind two warm extractions (4-8s each) on a pool of
// two; short enough that a caller who was never going to be served soon hears
// so in seconds rather than after the whole budget.
export const DEFAULT_POOL_WAIT_CAP_MS = 20_000
```

At the top of `loadConfig`, before `return {`, compute the budget and the cap. Then use `produceBudgetMs` in the returned object in place of the inline `num(env.PRODUCE_BUDGET_MS, ...)` call:

```ts
  const produceBudgetMs = num(env.PRODUCE_BUDGET_MS, DEFAULT_PRODUCE_BUDGET_MS)
  // Left unset, the cap follows the budget, so shortening the budget never
  // breaks on a knob the operator has not heard of. Set explicitly at or
  // above the budget, it could never fire: a misconfiguration worth refusing.
  const poolWaitCapMs =
    env.POOL_WAIT_CAP_MS === undefined
      ? Math.max(1, Math.min(DEFAULT_POOL_WAIT_CAP_MS, Math.floor(produceBudgetMs / 2)))
      : num(env.POOL_WAIT_CAP_MS, DEFAULT_POOL_WAIT_CAP_MS)
  if (env.POOL_WAIT_CAP_MS !== undefined && poolWaitCapMs >= produceBudgetMs) {
    throw new Error(
      `POOL_WAIT_CAP_MS (${poolWaitCapMs}) must be below PRODUCE_BUDGET_MS (${produceBudgetMs}): a cap at or above the budget can never fire`,
    )
  }
```

And in the returned object, after `contextCloseTimeoutMs`:

```ts
    // The browser is recycled on the first of these to hold. See
    // docs/superpowers/specs/2026-09-19-browser-context-manager-design.md.
    browserMaxAgeMs: num(env.BROWSER_MAX_AGE_MS, 6 * 3600 * 1000),
    browserMaxLeases: num(env.BROWSER_MAX_LEASES, 1000),
    browserMaxMemoryMb: nonNegative(env.BROWSER_MAX_MEMORY_MB, 2048),
    browserCheckIntervalMs: num(env.BROWSER_CHECK_INTERVAL_MS, 60_000),
    browserCloseTimeoutMs: num(env.BROWSER_CLOSE_TIMEOUT_MS, 10_000),
    browserMaxRelaunchFailures: num(env.BROWSER_MAX_RELAUNCH_FAILURES, 5),
    poolWaitCapMs,
```

In `README.md`'s configuration table, insert these rows directly after the `CONTEXT_CLOSE_TIMEOUT_MS` row:

```markdown
| `BROWSER_MAX_AGE_MS` | `21600000` (6h) | recycle the whole browser once it is this old. Blue/green: the replacement is launched first, and the old one drains |
| `BROWSER_MAX_LEASES` | `1000` | ...or once it has served this many leases |
| `BROWSER_MAX_MEMORY_MB` | `2048` | ...or once its process tree's PSS passes this. `0` turns the memory trigger off; it is off anyway where there is no `/proc` |
| `BROWSER_CHECK_INTERVAL_MS` | `60000` | how often the triggers are checked and memory is sampled |
| `BROWSER_CLOSE_TIMEOUT_MS` | `10000` | how long a browser may take to close before it is SIGKILLed |
| `BROWSER_MAX_RELAUNCH_FAILURES` | `5` | consecutive failed relaunches after a crash before the process exits, so the container restart policy takes over |
| `POOL_WAIT_CAP_MS` | `min(20000, PRODUCE_BUDGET_MS / 2)` | how long a caller may wait for a context before a 503 `overloaded`. An explicit value must be below `PRODUCE_BUDGET_MS` |
```

- [ ] **Step 4: Run the new tests and the whole suite.** Run `npx vitest run tests/config.test.ts && npx tsc --noEmit && npm test`. Expected: 5 new tests passing, and the full suite green (156 + 5 + Tasks 1 and 2's tests).

- [ ] **Step 5: Sabotage each test, then restore:**
  - Use `num` for `BROWSER_MAX_MEMORY_MB`: the `0` test fails.
  - Make the cap default a fixed 20000: the derive test fails.
  - Delete the explicit-cap check: the refuse test fails.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts README.md
git commit -m "feat(config): knobs for browser recycling, relaunch and the queue wait cap

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 4: The pool manages generations of browsers

This rewrites `createPool()` over `BrowserProcess`: one serving generation, and none of the new policies yet. Every existing pool test must keep passing; that is this task's main proof.

**Files:**
- Modify: `src/browser.ts` (replace the whole file with the content below)
- Modify: `tests/browser.test.ts`
  - update the 0.4.1 stats test, whose `stats()` shape grows;
  - append the new tests.

**Interfaces:**
- Consumes:
  - from Task 2: `launchBrowserProcess` and `BrowserProcess`;
  - from Task 3: `cfg.browserCloseTimeoutMs`.
- Produces, used by Tasks 5 to 8:
  - `Lease = { page; release; lost: AbortSignal }`;
  - `PoolStats` with `generations`, `browserAgeSeconds` and `browserMemoryBytes`;
  - `LaunchReason`, `LaunchEvent = { reason; generation; pid }` and `PoolObserver = { launched(event: LaunchEvent): void; launchFailed(): void }`;
  - `PoolOptions`: `observer`, plus the test hooks `failNextContextCreations`, `hangNextContextCloses` and `memoryOf`;
  - `export class PoolClosedError`.
- Inside `createPool`, later tasks extend these by name: `Generation`, `ContextRecord`, `launchGeneration`, `promote`, `closeContext`, `replaceContext`, `releaseRecord`, `makeLease`, `sampleMemory`, and the state `serving`, `draining` and `waiters`.

- [ ] **Step 1: Update the stats test and write the failing tests**

In `tests/browser.test.ts`, the test `'reports free, leased and waiting counts'` uses `toEqual` on `stats()`. Change its three `toEqual` calls on `sPool.stats()` to `toMatchObject`, since `stats()` gains fields in this task.

Change the import line at the top of `tests/browser.test.ts` to:

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { createPool, type LaunchEvent } from '../src/browser.js'
```

Append:

```ts
describe('createPool: browser generations', () => {
  it('serves from one generation at startup, and says so', async () => {
    const launches: LaunchEvent[] = []
    const gPool = await createPool(loadConfig({ POOL_SIZE: '1' }), {
      observer: { launched: (e) => { launches.push(e) }, launchFailed: () => {} },
    })
    try {
      expect(launches).toHaveLength(1)
      expect(launches[0]).toMatchObject({ reason: 'startup', generation: 1 })
      expect(launches[0].pid).toBeGreaterThan(0)
      const stats = gPool.stats()
      expect(stats.generations).toEqual({ serving: 1, draining: 0 })
      expect(stats.browserAgeSeconds).toBeGreaterThanOrEqual(0)
      if (process.platform === 'linux') expect(stats.browserMemoryBytes).toBeGreaterThan(0)
    } finally {
      await gPool.close()
    }
    expect(gPool.stats().generations).toEqual({ serving: 0, draining: 0 })
  }, 20_000)

  it('gives every lease a lost signal that stays quiet when nothing goes wrong', async () => {
    const lPool = await createPool(loadConfig({ POOL_SIZE: '1' }))
    try {
      const lease = await lPool.acquire()
      expect(lease.lost).toBeInstanceOf(AbortSignal)
      await lease.page.setContent('<h1>fine</h1>')
      await lease.release()
      expect(lease.lost.aborted).toBe(false)
    } finally {
      await lPool.close()
    }
  }, 20_000)

  it('reports memory through the reader it is given', async () => {
    const mPool = await createPool(loadConfig({ POOL_SIZE: '1' }), { memoryOf: () => 123_456 })
    try {
      expect(mPool.stats().browserMemoryBytes).toBe(123_456)
    } finally {
      await mPool.close()
    }
  }, 20_000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/browser.test.ts -t 'browser generations'`
Expected:
- the first test fails because the observer is never called, so `launches` has length 0;
- the second fails with `lease.lost` undefined;
- the third fails with `browserMemoryBytes` undefined.

- [ ] **Step 3: Replace `src/browser.ts` with:**

```ts
import type { BrowserContext, Page } from 'playwright'
import type { Config } from './config.js'
import { launchBrowserProcess, type BrowserProcess } from './browser-process.js'

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

// Test-only fault injection, not part of the Pool contract: `createPool(cfg)`
// alone is the real signature. The hooks ride in the same options object as
// the real ones, so every existing call site keeps working.
type TestFaultHooks = {
  failNextContextCreations?: number
  hangNextContextCloses?: number
  /** Replaces the `/proc` reading of a generation's memory. */
  memoryOf?: (pid: number) => number | null
}

export type PoolOptions = { observer?: PoolObserver } & TestFaultHooks

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
    const process = await launchBrowserProcess()
    const gen: Generation = {
      id: nextGenerationId++,
      process,
      state: 'starting',
      startedAt: Date.now(),
      leases: 0,
      records: new Set(),
      free: [],
      memoryBytes: null,
    }
    try {
      for (let i = 0; i < cfg.poolSize; i++) gen.free.push(await createContext(gen))
      // A browser that died during the fill must not be promoted: nothing
      // would ever notice, since its death arrived while it was 'starting'.
      if (process.dead) throw new Error(`browser generation ${gen.id} died before it could serve`)
    } catch (err) {
      gen.state = 'closed'
      await process.close(cfg.browserCloseTimeoutMs)
      throw err
    }
    gen.memoryBytes = sampleMemory(gen)
    opts.observer?.launched({ reason, generation: gen.id, pid: process.pid })
    console.warn(`[pool] browser generation ${gen.id} launched (pid ${process.pid}, ${reason})`)
    return gen
  }

  function promote(gen: Generation): void {
    gen.state = 'serving'
    serving = gen
    while (waiters.length > 0 && gen.free.length > 0) waiters.shift()!.resolve(gen.free.shift()!)
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
      return
    }

    const waiter = waiters.shift()
    if (waiter) waiter.resolve(returned)
    else gen.free.push(returned)
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

  promote(await launchGeneration('startup'))
  failuresRemaining = opts.failNextContextCreations ?? 0
  closeHangsRemaining = opts.hangNextContextCloses ?? 0

  return {
    async acquire(deadline?: AbortSignal): Promise<Lease> {
      if (closed) throw new Error('browser pool is closed')
      deadline?.throwIfAborted()
      const ready = serving?.free.shift()
      if (ready !== undefined) return makeLease(ready, deadline)
      const queued = await new Promise<ContextRecord>((resolve, reject) => {
        // A caller whose deadline passes leaves the queue. Left in it, it
        // would be handed the next free context after it had stopped
        // listening, ahead of a caller that is still waiting.
        const leave = (): void => {
          const i = waiters.indexOf(waiter)
          if (i !== -1) waiters.splice(i, 1)
          reject(deadline?.reason)
        }
        const waiter: Waiter = {
          resolve: (r) => {
            deadline?.removeEventListener('abort', leave)
            resolve(r)
          },
          reject: (err) => {
            deadline?.removeEventListener('abort', leave)
            reject(err)
          },
        }
        deadline?.addEventListener('abort', leave, { once: true })
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
        browserAgeSeconds: serving === null ? null : (Date.now() - serving.startedAt) / 1000,
        browserMemoryBytes: serving?.memoryBytes ?? null,
      }
    },

    async close(): Promise<void> {
      closed = true
      // Nothing will ever release into a closing pool.
      while (waiters.length > 0) waiters.shift()!.reject(new PoolClosedError())
      const gens = [...(serving === null ? [] : [serving]), ...draining]
      serving = null
      draining.clear()
      for (const gen of gens) gen.state = 'closed'
      // Tears down contexts still out on unreleased leases too, so a leaked
      // lease cannot leak a Chromium process past shutdown.
      await Promise.all(gens.map((gen) => gen.process.close(cfg.browserCloseTimeoutMs)))
    },
  }
}
```

- [ ] **Step 4: Run the pool tests, then everything.** Run `npx vitest run tests/browser.test.ts && npx tsc --noEmit && npm test`. Expected:
  - every pre-existing test in `tests/browser.test.ts` passes unchanged, apart from the `toMatchObject` edit;
  - the 3 new tests pass;
  - the whole suite is green, including `tests/extract.test.ts`, which now runs over `connect()`.

  If an extract test regresses, suspect the transport first. The owner's probe showed `page.route` works over `connect()`, but report any difference you find.

- [ ] **Step 5: Sabotage each test, then restore:**
  - Skip the `observer?.launched` call: the startup test fails.
  - Return `browserMemoryBytes: null`: the memory test fails.
  - Drop `lost` from the returned lease: the lost test fails.
  - Make `liveContexts()` count `draining` too: nothing fails yet. Say so; Task 6 covers it.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts tests/browser.test.ts
git commit -m "refactor(pool): manage a generation of browser over BrowserProcess

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 5: A browser crash is survived

**Files:**
- Modify: `src/browser.ts`
- Test: `tests/browser.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 4 produced, and `DeathCause` from Task 2.
- Produces:
  - `export class BrowserUnavailableError extends Error {}`;
  - `PoolOptions` gains `onFatal?: (err: Error) => void`, and the test hooks gain `failNextLaunches?: number` and `backoffBaseMs?: number`;
  - inside `createPool`: `onDeath(gen, cause)`, `relaunch()`, `backoff(n)`, and the state `relaunching` and `relaunchFailures`. Task 6 extends `relaunch` and `onDeath`.

- [ ] **Step 1: Write the failing tests.** Change the import lines at the top of `tests/browser.test.ts` to:

```ts
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createPool, BrowserUnavailableError, type LaunchEvent } from '../src/browser.js'
```

Append the helpers and tests:

```ts
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

/** An observer that records every launch and counts failures. */
function observed() {
  const launches: LaunchEvent[] = []
  let failures = 0
  return {
    launches,
    failures: () => failures,
    observer: {
      launched: (e: LaunchEvent) => {
        launches.push(e)
      },
      launchFailed: () => {
        failures++
      },
    },
  }
}

// Before this, nothing listened for the browser going away: a Chromium crash
// made every later context creation fail until someone restarted the
// container, and nothing would, because /health's 503 has no healthcheck
// behind it on either stack.
describe('createPool: a browser crash', () => {
  it('fails the lease it was holding as BrowserUnavailableError, and a new browser takes over', async () => {
    const o = observed()
    const cPool = await createPool(loadConfig({ POOL_SIZE: '1' }), { observer: o.observer })
    try {
      const lease = await cPool.acquire()
      const pending = lease.page.evaluate(() => new Promise<never>(() => {})).catch((e: unknown) => e)
      process.kill(o.launches[0].pid, 'SIGKILL')

      expect(await settlesWithin(pending, 5_000)).toBeInstanceOf(Error)
      // The pending call and the death notice race: the call can reject a few
      // milliseconds before the pool hears of the death.
      expect(await waitFor(() => lease.lost.aborted, 5_000)).toBe(true)
      expect(lease.lost.reason).toBeInstanceOf(BrowserUnavailableError)

      const next = await settlesWithin(cPool.acquire(), 15_000)
      expect(next).not.toBe(TIMED_OUT)
      if (next === TIMED_OUT) return
      await next.page.setContent('<h1>after</h1>')
      expect(await next.page.textContent('h1')).toBe('after')
      expect(o.launches.map((e) => e.reason)).toEqual(['startup', 'crash'])
      await next.release()
      await lease.release() // a late release from the dead browser is harmless
      expect(cPool.liveContexts()).toBe(1)
      expect(cPool.stats().generations).toEqual({ serving: 1, draining: 0 })
    } finally {
      await cPool.close()
    }
  }, 30_000)

  it('serves a caller that was already queued when the browser died', async () => {
    const o = observed()
    const qPool = await createPool(loadConfig({ POOL_SIZE: '1' }), { observer: o.observer })
    try {
      const held = await qPool.acquire()
      const queued = qPool.acquire()
      process.kill(o.launches[0].pid, 'SIGKILL')
      const got = await settlesWithin(queued, 15_000)
      expect(got).not.toBe(TIMED_OUT)
      if (got === TIMED_OUT) return
      await got.page.setContent('<h1>served</h1>')
      expect(await got.page.textContent('h1')).toBe('served')
      await got.release()
      await held.release()
    } finally {
      await qPool.close()
    }
  }, 30_000)

  it('backs off between failed relaunches and recovers without giving up', async () => {
    const o = observed()
    const fatal = vi.fn()
    const bPool = await createPool(loadConfig({ POOL_SIZE: '1' }), {
      observer: o.observer,
      onFatal: fatal,
      failNextLaunches: 2,
      backoffBaseMs: 50,
    })
    try {
      process.kill(o.launches[0].pid, 'SIGKILL')
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(o.failures()).toBe(2)
      expect(fatal).not.toHaveBeenCalled()
      expect(bPool.liveContexts()).toBe(1)
    } finally {
      await bPool.close()
    }
  }, 30_000)

  it('gives up after BROWSER_MAX_RELAUNCH_FAILURES failed relaunches, calling onFatal exactly once', async () => {
    const o = observed()
    const fatal = vi.fn()
    const gPool = await createPool(loadConfig({ POOL_SIZE: '1', BROWSER_MAX_RELAUNCH_FAILURES: '3' }), {
      observer: o.observer,
      onFatal: fatal,
      failNextLaunches: 10,
      backoffBaseMs: 10,
    })
    try {
      process.kill(o.launches[0].pid, 'SIGKILL')
      expect(await waitFor(() => fatal.mock.calls.length > 0, 10_000)).toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      expect(fatal).toHaveBeenCalledTimes(1)
      expect(fatal.mock.calls[0][0]).toBeInstanceOf(Error)
      expect(o.failures()).toBe(3)
      expect(gPool.liveContexts()).toBe(0)
    } finally {
      await gPool.close()
    }
  }, 30_000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/browser.test.ts -t 'a browser crash'`
Expected:
- compilation fails, because `BrowserUnavailableError` is not exported;
- after adding only a bare export to test that, the first test fails with `lease.lost.aborted` false and `next` TIMED_OUT, since nothing relaunches;
- the escalation test fails with `fatal` never called.

- [ ] **Step 3: Implement** in `src/browser.ts`.

(a) Change the import from `./browser-process.js` to:

```ts
import { launchBrowserProcess, type BrowserProcess, type DeathCause } from './browser-process.js'
```

(b) After `PoolClosedError`, add:

```ts
/** No browser could serve: the lease's browser died, or none was serving while the caller waited. */
export class BrowserUnavailableError extends Error {}
```

(c) Extend the options types:

```ts
type TestFaultHooks = {
  failNextContextCreations?: number
  hangNextContextCloses?: number
  /** Replaces the `/proc` reading of a generation's memory. */
  memoryOf?: (pid: number) => number | null
  /** Launches after startup that fail before starting Chromium. */
  failNextLaunches?: number
  /** Replaces the 1s base of the relaunch and recycle backoff. */
  backoffBaseMs?: number
}

export type PoolOptions = {
  observer?: PoolObserver
  /**
   * Called once when relaunching has failed `browserMaxRelaunchFailures`
   * times in a row. index.ts exits the process, so the container restart
   * policy gives it a clean start; the pool never exits by itself.
   */
  onFatal?: (err: Error) => void
} & TestFaultHooks
```

(d) After `closeWithin`, add the module helpers:

```ts
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd so a pending backoff cannot hold the process open at shutdown.
    setTimeout(resolve, ms).unref()
  })
}

/** First line only: Playwright folds a stack into `message`. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n')[0] ?? message
}
```

(e) Inside `createPool`, after `let closed = false`, add:

```ts
  let launchFailuresRemaining = 0
  let relaunching = false
  let relaunchFailures = 0
  const onFatal =
    opts.onFatal ?? ((err: Error) => console.error(`[pool] giving up on the browser: ${firstLine(err)}`))
  const backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS

  function backoff(attempt: number): number {
    return Math.min(backoffBaseMs * 2 ** (attempt - 1), BACKOFF_CAP_MS)
  }
```

(f) At the very top of `launchGeneration`, before `launchBrowserProcess()`:

```ts
    if (launchFailuresRemaining > 0) {
      launchFailuresRemaining--
      throw new Error('injected launch failure (test)')
    }
```

In `launchGeneration`, immediately after the `const gen: Generation = { ... }` literal:

```ts
    process.onDeath((cause) => onDeath(gen, cause))
```

(g) After `makeLease`, add:

```ts
  // A browser that dies is never trusted again: every lease on it is lost, and
  // if it was serving, a relaunch starts at once.
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
    const reason = new BrowserUnavailableError(`the browser died (${cause}) while this lookup was using it`)
    for (const record of gen.records) record.lost?.abort(reason)
    gen.records.clear()
    gen.free = []
    // A dropped connection can leave the process itself running.
    void gen.process.close(cfg.browserCloseTimeoutMs)
    if (wasServing) {
      serving = null
      void relaunch()
    }
  }

  // Keeps trying until something serves, backing off between failures. A
  // queued caller is served by whichever launch succeeds. Past the limit, the
  // pool stops, rejects everyone waiting, and hands the decision to onFatal.
  async function relaunch(): Promise<void> {
    if (relaunching) return
    relaunching = true
    try {
      while (!closed && serving === null) {
        try {
          const gen = await launchGeneration('crash')
          if (closed) {
            await gen.process.close(cfg.browserCloseTimeoutMs)
            return
          }
          relaunchFailures = 0
          promote(gen)
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          relaunchFailures++
          opts.observer?.launchFailed()
          console.warn(
            `[pool] relaunch ${relaunchFailures} of ${cfg.browserMaxRelaunchFailures} failed: ${firstLine(error)}`,
          )
          if (relaunchFailures >= cfg.browserMaxRelaunchFailures) {
            console.error(`[pool] ${relaunchFailures} relaunches in a row failed -- giving up on the browser`)
            while (waiters.length > 0) {
              waiters.shift()!.reject(new BrowserUnavailableError('no browser could be launched'))
            }
            onFatal(error)
            return
          }
          await sleep(backoff(relaunchFailures))
        }
      }
    } finally {
      relaunching = false
    }
  }
```

(h) After `closeHangsRemaining = opts.hangNextContextCloses ?? 0`, add:

```ts
  launchFailuresRemaining = opts.failNextLaunches ?? 0
```

- [ ] **Step 4: Run the new tests, then everything.** Run `npx vitest run tests/browser.test.ts -t 'a browser crash' && npx tsc --noEmit && npm test`. Expected: 4 passed, and the full suite green.

- [ ] **Step 5: Sabotage each test, then restore:**
  - Remove the `record.lost?.abort(reason)` loop: test 1 fails.
  - Remove `void relaunch()`: tests 1 and 2 time out, and so does test 3.
  - Set `relaunchFailures = 0` inside the catch: test 4 fails, because `onFatal` is never called.
  - Delete `if (relaunching) return`: nothing fails. Say so; the double-report guard is proven in Task 2.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts tests/browser.test.ts
git commit -m "feat(pool): survive a browser crash -- lose its leases, relaunch with backoff, escalate

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 6: Recycling the browser, blue/green

**Files:**
- Modify: `src/browser.ts`
- Test: `tests/browser.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 4 and 5, and `cfg.browserMaxAgeMs`, `browserMaxLeases`, `browserMaxMemoryMb` and `browserCheckIntervalMs` from Task 3.
- Produces: the test hook `now?: () => number`, and inside `createPool`: `startDraining`, `closeIfDrained`, `recycleReason`, `checkRecycle`, `recycle`, `launchInFlight`, and a `tick` interval.

- [ ] **Step 1: Write the failing tests.** Append:

```ts
describe('createPool: recycling the browser', () => {
  it('recycles on age, draining the old browser rather than cutting it off', async () => {
    let t = 0
    const o = observed()
    const rPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_AGE_MS: '60000', BROWSER_CHECK_INTERVAL_MS: '50' }),
      { observer: o.observer, now: () => t },
    )
    try {
      const old = await rPool.acquire()
      t = 60_000
      expect(await waitFor(() => rPool.stats().generations.draining === 1, 15_000)).toBe(true)
      expect(o.launches.map((e) => e.reason)).toEqual(['startup', 'recycle_age'])

      // Drained, not revoked: the lease on the old browser still works.
      await old.page.setContent('<h1>still mine</h1>')
      expect(await old.page.textContent('h1')).toBe('still mine')

      // A draining browser never hands out a context; the new one does.
      const fresh = await settlesWithin(rPool.acquire(), 2_000)
      expect(fresh).not.toBe(TIMED_OUT)
      if (fresh === TIMED_OUT) return
      expect(fresh.page.context().browser()).not.toBe(old.page.context().browser())
      expect(rPool.liveContexts()).toBe(1)

      await fresh.release()
      await old.release()
      expect(await waitFor(() => rPool.stats().generations.draining === 0, 15_000)).toBe(true)
      expect(await waitFor(() => !isAlive(o.launches[0].pid), 15_000)).toBe(true)
    } finally {
      await rPool.close()
    }
  }, 60_000)

  it('recycles once BROWSER_MAX_LEASES leases have been served', async () => {
    const o = observed()
    const lPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_LEASES: '3', BROWSER_CHECK_INTERVAL_MS: '600000' }),
      { observer: o.observer },
    )
    try {
      for (let i = 0; i < 2; i++) await (await lPool.acquire()).release()
      await new Promise((r) => setTimeout(r, 200))
      expect(o.launches).toHaveLength(1) // two leases: under the limit
      await (await lPool.acquire()).release()
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(o.launches[1].reason).toBe('recycle_leases')
      // Nothing was leased from the old browser, so it drains at once.
      expect(await waitFor(() => !isAlive(o.launches[0].pid), 15_000)).toBe(true)
    } finally {
      await lPool.close()
    }
  }, 60_000)

  it('recycles when the browser grows past BROWSER_MAX_MEMORY_MB', async () => {
    let bytes = 1
    const o = observed()
    const mPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_MEMORY_MB: '100', BROWSER_CHECK_INTERVAL_MS: '50' }),
      { observer: o.observer, memoryOf: () => bytes },
    )
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(o.launches).toHaveLength(1) // under the limit
      bytes = 100 * 1024 * 1024
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      bytes = 1 // or the new browser, measured by the same fake, recycles too
      expect(o.launches[1].reason).toBe('recycle_memory')
    } finally {
      await mPool.close()
    }
  }, 60_000)

  it('keeps the old browser serving when a recycle launch fails, and never gives up over it', async () => {
    let t = 0
    const o = observed()
    const fatal = vi.fn()
    const fPool = await createPool(
      loadConfig({ POOL_SIZE: '1', BROWSER_MAX_AGE_MS: '60000', BROWSER_CHECK_INTERVAL_MS: '50' }),
      { observer: o.observer, now: () => t, failNextLaunches: 1, onFatal: fatal },
    )
    try {
      t = 60_000
      expect(await waitFor(() => o.failures() === 1, 15_000)).toBe(true)
      expect(fPool.stats().generations).toEqual({ serving: 1, draining: 0 })
      const lease = await settlesWithin(fPool.acquire(), 2_000)
      expect(lease).not.toBe(TIMED_OUT)
      if (lease !== TIMED_OUT) await lease.release()

      // Past the backoff, the next attempt succeeds.
      t = 60_000 + 60_000
      expect(await waitFor(() => o.launches.length === 2, 15_000)).toBe(true)
      expect(fatal).not.toHaveBeenCalled()
    } finally {
      await fPool.close()
    }
  }, 60_000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/browser.test.ts -t 'recycling the browser'`
Expected: all 4 fail at their first `waitFor`, which is false because nothing recycles. The leases test fails at `o.launches.length === 2`.

- [ ] **Step 3: Implement** in `src/browser.ts`.

(a) Add `now?: () => number` to `TestFaultHooks`:

```ts
  /** Replaces the clock the age trigger reads. */
  now?: () => number
```

(b) Inside `createPool`, after `backoff`, add:

```ts
  const now = opts.now ?? Date.now
  // At most one launch in flight: a recycle, or a relaunch's wait on it.
  let launchInFlight: Promise<void> | null = null
  let recycleFailures = 0
  let nextRecycleAt = 0
```

In `launchGeneration`, change `startedAt: Date.now(),` to `startedAt: now(),`. In `stats()`, change `(Date.now() - serving.startedAt) / 1000` to `(now() - serving.startedAt) / 1000`.

(c) Replace `promote` with:

```ts
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
```

(d) In `releaseRecord`, the two non-serving branches each end with `closeIfDrained(gen)`:

```ts
    if (gen.state !== 'serving') {
      // A draining or dead browser never hands a context out again.
      gen.records.delete(record)
      await closeContext(record)
      closeIfDrained(gen)
      return
    }
```

```ts
    if (gen.state !== 'serving') {
      // The generation stopped serving while the replacement was being made.
      gen.records.delete(returned)
      await closeContext(returned)
      closeIfDrained(gen)
      return
    }
```

At the end of `releaseRecord`, after the waiter/free hand-back, add:

```ts
    checkRecycle()
```

(e) After `relaunch`, add:

```ts
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
      console.warn(`[pool] recycle launch failed; generation ${old.id} keeps serving: ${firstLine(err)}`)
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
```

(f) At the top of `relaunch`, right after `relaunching = true` and before `try {`, nothing changes. Inside the `try`, before the `while`, add:

```ts
      // A recycle launching when the browser died will adopt the empty slot
      // itself; wait for it rather than launching a second browser.
      if (launchInFlight !== null) await launchInFlight
```

(g) After `launchFailuresRemaining = opts.failNextLaunches ?? 0`, add:

```ts
  const tick = setInterval(() => {
    if (serving !== null) serving.memoryBytes = sampleMemory(serving)
    checkRecycle()
  }, cfg.browserCheckIntervalMs)
  tick.unref()
  if (serving !== null && serving.memoryBytes === null) {
    console.warn('[pool] browser memory is not measurable here -- the memory recycle trigger is off')
  }
```

(h) In `close()`, make the first two lines `closed = true` and then `clearInterval(tick)`. At the end of `close()`, after `await Promise.all(...)`, add:

```ts
      // A recycle mid-launch sees `closed` and closes what it launched.
      if (launchInFlight !== null) await launchInFlight
```

- [ ] **Step 4: Run the new tests, then everything.** Run `npx vitest run tests/browser.test.ts -t 'recycling the browser' && npx tsc --noEmit && npm test`. Expected: 4 passed, and the full suite green.

- [ ] **Step 5: Sabotage each test, then restore:**
  - In `promote`, delete the `startDraining(old)` call: the age test fails, because `draining` never becomes 1.
  - Make `releaseRecord` hand a draining generation's context back out, by removing the first non-serving branch: the age test's `fresh`/`old` browser inequality or the liveContexts assertion fails.
  - Remove `checkRecycle()` from `releaseRecord`: the leases test fails.
  - Skip the memory sample in the tick: the memory test fails.
  - Make the recycle catch call `onFatal`: the failed-recycle test fails.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts tests/browser.test.ts
git commit -m "feat(pool): recycle the browser blue/green on age, leases served, or memory

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 7: The queue wait cap

**Files:**
- Modify: `src/browser.ts`
- Test: `tests/browser.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 4 to 6, and `cfg.poolWaitCapMs` from Task 3.
- Produces: `export class PoolOverloadedError extends Error {}`. The queue path of `acquire()` rejects with it, or with `BrowserUnavailableError`, after `cfg.poolWaitCapMs`.

- [ ] **Step 1: Write the failing tests.** Change the import to:

```ts
import { createPool, BrowserUnavailableError, PoolOverloadedError, type LaunchEvent } from '../src/browser.js'
```

Append:

```ts
// Before this, an excess caller waited up to the whole budget just to queue,
// then got the same 504 as a genuinely stuck extraction.
describe('createPool: the wait cap', () => {
  it('turns a caller away with PoolOverloadedError once it has waited POOL_WAIT_CAP_MS', async () => {
    const wPool = await createPool(loadConfig({ POOL_SIZE: '1', POOL_WAIT_CAP_MS: '300' }))
    try {
      const held = await wPool.acquire()
      const started = Date.now()
      const err = await settlesWithin(wPool.acquire().catch((e: unknown) => e), 5_000)
      expect(err).toBeInstanceOf(PoolOverloadedError)
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(wPool.stats().waiting).toBe(0)
      await held.release()
    } finally {
      await wPool.close()
    }
  }, 20_000)

  it('answers BrowserUnavailableError when no browser was serving while the caller waited', async () => {
    const o = observed()
    const uPool = await createPool(loadConfig({ POOL_SIZE: '1', POOL_WAIT_CAP_MS: '300' }), {
      observer: o.observer,
      failNextLaunches: 10,
      backoffBaseMs: 60_000, // the relaunch stays pending for the whole test
    })
    try {
      process.kill(o.launches[0].pid, 'SIGKILL')
      expect(await waitFor(() => uPool.liveContexts() === 0, 5_000)).toBe(true)
      const err = await settlesWithin(uPool.acquire().catch((e: unknown) => e), 5_000)
      expect(err).toBeInstanceOf(BrowserUnavailableError)
    } finally {
      await uPool.close()
    }
  }, 20_000)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/browser.test.ts -t 'the wait cap'`
Expected: compilation fails until `PoolOverloadedError` exists. With a bare export in place, both fail with `err` equal to TIMED_OUT, since the caller waits forever.

- [ ] **Step 3: Implement** in `src/browser.ts`.

(a) After `BrowserUnavailableError`, add:

```ts
/** A caller waited POOL_WAIT_CAP_MS for a context while a browser was serving. */
export class PoolOverloadedError extends Error {}
```

(b) In `acquire()`, replace the whole `const queued = await new Promise<ContextRecord>(...)` block with:

```ts
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
```

- [ ] **Step 4: Run the new tests, then everything.** Run `npx vitest run tests/browser.test.ts -t 'the wait cap' && npx tsc --noEmit && npm test`. Expected: 2 passed, and the full suite green. 0.4.1's `'drops a queued caller whose deadline passes'` must still pass: its deadline of 200 ms is shorter than the default cap.

- [ ] **Step 5: Sabotage each test, then restore:**
  - Delete the `setTimeout` for the cap: both tests fail.
  - Always reject with `PoolOverloadedError`: the unavailable test fails.
  - Skip the `waiters.splice` in `leave`: the overloaded test's `waiting` assertion fails.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts tests/browser.test.ts
git commit -m "feat(pool): cap how long a caller queues -- overloaded or browser_unavailable

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 8: Extraction, HTTP, metrics and startup wiring

**Files:**
- Modify: `src/extract.ts` (`runExtraction`)
- Modify: `src/server.ts`:
  - imports;
  - `RelayedFailure`, `classifyFailure` and `reviveFailure`;
  - `recordFailureMetrics`;
  - the route's catch chain;
  - `/metrics`.
- Modify: `src/metrics.ts`
- Modify: `src/index.ts`
- Test: `tests/extract.test.ts`, `tests/server.test.ts` and `tests/index.test.ts` (append to each)

**Interfaces:**
- Consumes:
  - from Task 5: `BrowserUnavailableError` and `Lease.lost`;
  - from Task 7: `PoolOverloadedError`;
  - from Task 4: `PoolStats`, `PoolOptions` and `LaunchEvent`.
- Produces:
  - `export function poolOptionsFor(exit: (code: number) => void): PoolOptions` in `src/index.ts`;
  - the metrics `browserGenerations`, `browserAge`, `browserMemory`, `browserLaunches` and `browserLaunchFailures`.

- [ ] **Step 1: Write the failing tests.**

In `tests/extract.test.ts`:
- add `BrowserUnavailableError` and `type LaunchEvent` to the import from `'../src/browser.js'`, adding the import line if the file only imports `createPool`;
- inside `describe('extract: a stuck extraction', ...)`, add:

```ts
  it('reports a browser crash mid-extraction as BrowserUnavailableError, not as the Playwright error it interrupted', async () => {
    const launches: LaunchEvent[] = []
    const cCfg = loadConfig({ POOL_SIZE: '1' })
    const cPool = await createPool(cCfg, {
      observer: { launched: (e) => { launches.push(e) }, launchFailed: () => {} },
    })
    try {
      const page = await routedPage(cPool)
      // The document never arrives, so the extraction sits in goto.
      await page.route('https://open.spotify.com/**', () => {})
      const pending = extract('track', 'crashId', cPool, cCfg).catch((e: unknown) => e)
      await new Promise((r) => setTimeout(r, 500))
      process.kill(launches[0].pid, 'SIGKILL')
      expect(await settlesWithin(pending, 10_000)).toBeInstanceOf(BrowserUnavailableError)
    } finally {
      await cPool.close()
    }
  }, 30_000)
```

In `tests/server.test.ts`:
- add to the imports:

```ts
import { PoolOverloadedError, BrowserUnavailableError } from '../src/browser.js'
```

- replace `fakePool`'s `stats` with:

```ts
  stats: () => ({
    free: 0,
    leased: 2,
    waiting: 3,
    generations: { serving: 1, draining: 1 },
    browserAgeSeconds: 42,
    browserMemoryBytes: 1234,
  }),
```

- inside `describe('GET /metrics', ...)`, add:

```ts
  it('exposes the browser generations, age and memory', async () => {
    const res = await server(async () => TRACK).inject({ method: 'GET', url: '/metrics' })
    expect(res.body).toMatch(/sleevenote_browser_generations\{state="serving"\} 1/)
    expect(res.body).toMatch(/sleevenote_browser_generations\{state="draining"\} 1/)
    expect(res.body).toMatch(/sleevenote_browser_age_seconds\{state="serving"\} 42/)
    expect(res.body).toMatch(/sleevenote_browser_memory_bytes\{state="serving"\} 1234/)
    expect(res.body).toContain('sleevenote_browser_launches_total')
    expect(res.body).toContain('sleevenote_browser_launch_failures_total')
  })

  // Absent, not zero: a zero would read as a brand-new browser, or one using
  // no memory at all.
  it('omits the age and memory samples while no browser is serving', async () => {
    const idle = {
      ...fakePool,
      stats: () => ({
        free: 0, leased: 0, waiting: 0,
        generations: { serving: 0, draining: 0 },
        browserAgeSeconds: null, browserMemoryBytes: null,
      }),
    }
    const app = buildServer({ cfg, store: new MemoryStore(), pool: idle as any, extract: async () => TRACK })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.body).not.toMatch(/sleevenote_browser_age_seconds\{/)
    expect(res.body).not.toMatch(/sleevenote_browser_memory_bytes\{/)
  })
```

- append:

```ts
describe('shedding load and losing the browser', () => {
  it('maps PoolOverloadedError to 503 overloaded, with Retry-After', async () => {
    const res = await server(async () => { throw new PoolOverloadedError('busy') }).inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')
    expect(res.json()).toMatchObject({ error: 'overloaded', id: 'abc' })
  })

  it('maps BrowserUnavailableError to 503 browser_unavailable, with Retry-After', async () => {
    const res = await server(async () => { throw new BrowserUnavailableError('gone') }).inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')
    expect(res.json()).toMatchObject({ error: 'browser_unavailable', id: 'abc' })
  })

  it('counts each as its own failure reason', async () => {
    const before = await counterValue(scrapeFailures, { reason: 'overloaded' })
    await server(async () => { throw new PoolOverloadedError('busy') }).inject({ method: 'GET', url: '/v1/track/abc' })
    expect(await counterValue(scrapeFailures, { reason: 'overloaded' })).toBe(before + 1)
    const beforeU = await counterValue(scrapeFailures, { reason: 'browser_unavailable' })
    await server(async () => { throw new BrowserUnavailableError('gone') }).inject({ method: 'GET', url: '/v1/track/abc' })
    expect(await counterValue(scrapeFailures, { reason: 'browser_unavailable' })).toBe(beforeU + 1)
  })

  it('serves stale rather than 503 when a shed key has a stale entry', async () => {
    const store = new MemoryStore()
    let shed = false
    const app = server(async () => { if (shed) throw new PoolOverloadedError('busy'); return TRACK }, store)
    await app.inject({ method: 'GET', url: '/v1/track/abc' })
    shed = true
    const raw = JSON.parse((await store.get('v1:track:abc'))!)
    raw.storedAt = 0
    await store.set('v1:track:abc', JSON.stringify(raw), 9999)
    const res = await app.inject({ method: 'GET', url: '/v1/track/abc' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('stale')
  })
})
```

- inside `describe('concurrent callers on a failing entity', ...)`, add:

```ts
  it('preserves overloaded and browser_unavailable for waiters too', async () => {
    const cases = [
      { id: 'shedalbum', code: 'overloaded', make: () => new PoolOverloadedError('busy') },
      { id: 'lostalbum', code: 'browser_unavailable', make: () => new BrowserUnavailableError('gone') },
    ]
    for (const { id, code, make } of cases) {
      let calls = 0
      const app = fastServer(async () => {
        calls++
        await new Promise((r) => setTimeout(r, 50))
        throw make()
      })
      const [a, b] = await Promise.all([
        app.inject({ method: 'GET', url: `/v1/album/${id}` }),
        app.inject({ method: 'GET', url: `/v1/album/${id}` }),
      ])
      expect(calls).toBe(1)
      for (const res of [a, b]) {
        expect(res.statusCode).toBe(503)
        expect(res.json().error).toBe(code)
      }
    }
  })
```

In `tests/index.test.ts`, add `poolOptionsFor` to the import from `'../src/index.js'`, import the counters, and append:

```ts
import { browserLaunches, browserLaunchFailures } from '../src/metrics.js'

describe('poolOptionsFor', () => {
  it('counts launches by reason and failed launches', async () => {
    const opts = poolOptionsFor(() => {})
    const before = (await browserLaunches.get()).values.find((v) => v.labels.reason === 'crash')?.value ?? 0
    opts.observer!.launched({ reason: 'crash', generation: 2, pid: 123 })
    const after = (await browserLaunches.get()).values.find((v) => v.labels.reason === 'crash')?.value ?? 0
    expect(after).toBe(before + 1)
    const failsBefore = (await browserLaunchFailures.get()).values[0]?.value ?? 0
    opts.observer!.launchFailed()
    expect((await browserLaunchFailures.get()).values[0]?.value ?? 0).toBe(failsBefore + 1)
  })

  // The pool never exits by itself; index.ts decides, so the container
  // restart policy gives the service a clean start.
  it('exits non-zero when the pool gives up on the browser', () => {
    const exits: number[] = []
    poolOptionsFor((code) => { exits.push(code) }).onFatal!(new Error('no browser'))
    expect(exits).toEqual([1])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/extract.test.ts -t 'browser crash mid-extraction' tests/server.test.ts tests/index.test.ts`
Expected:
- the extract test fails with a Playwright error (`Target page, context or browser has been closed`), not `BrowserUnavailableError`;
- the server tests fail with 502 `internal` instead of 503, and the gauges are missing;
- the index tests fail because `poolOptionsFor` is not exported.

- [ ] **Step 3: Implement.**

`src/extract.ts`: add, near `sleep`:

```ts
// How long a failed Playwright call waits to learn whether the browser died
// under it. The call and the pool's death notice race -- the call can reject
// a few milliseconds before the exit or disconnect is seen (measured: exit
// at +5ms, disconnect at +14ms after a SIGKILL).
const LOST_GRACE_MS = 1_000

/** Resolves when `signal` aborts, or after `ms`, whichever is first. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    timer.unref()
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
```

In `runExtraction`, turn the existing `try { ... } finally { await lease.release() }` into `try { ... } catch ... finally`, adding this catch between them:

```ts
  } catch (err) {
    // A crash is reported as what it was, not as whichever Playwright call
    // happened to be pending when the browser went. Our own verdicts
    // (ExtractionError) never wait; anything else might be the browser dying,
    // so it waits briefly for the pool to say so.
    if (!(err instanceof ExtractionError) && !lease.lost.aborted) await abortedWithin(lease.lost, LOST_GRACE_MS)
    if (lease.lost.aborted) throw lease.lost.reason
    throw err
  } finally {
```

A goto timeout pays at most one extra second, on top of its 45 s. A deadline revocation pays it too, but its caller was answered at the deadline, so nobody waits on it.

`src/metrics.ts`, before `buildInfo`, add:

```ts
// Generations, age and memory are read from the pool at scrape time. Age and
// memory carry a constant `state="serving"` label for one reason: reset() on a
// labelled gauge empties it, so the sample is ABSENT while no browser serves.
// An unlabelled gauge resets to 0, which would read as a brand-new browser.
export const browserGenerations = new Gauge({
  name: 'sleevenote_browser_generations',
  help: 'Browser generations by state (serving/draining), read from the pool at scrape time.',
  labelNames: ['state'] as const,
  registers: [registry],
})

export const browserAge = new Gauge({
  name: 'sleevenote_browser_age_seconds',
  help: 'Age of the serving browser, read at scrape time. Absent while none is serving.',
  labelNames: ['state'] as const,
  registers: [registry],
})

export const browserMemory = new Gauge({
  name: 'sleevenote_browser_memory_bytes',
  help: "PSS of the serving browser's process tree at the last sample. Absent while unmeasurable.",
  labelNames: ['state'] as const,
  registers: [registry],
})

export const browserLaunches = new Counter({
  name: 'sleevenote_browser_launches_total',
  help: 'Browser generations launched, by reason (startup/recycle_age/recycle_leases/recycle_memory/crash).',
  labelNames: ['reason'] as const,
  registers: [registry],
})

export const browserLaunchFailures = new Counter({
  name: 'sleevenote_browser_launch_failures_total',
  help: 'Browser launches after startup that failed, relaunch or recycle.',
  registers: [registry],
})
```

`src/server.ts`:
- **Imports:** add `import { PoolOverloadedError, BrowserUnavailableError } from './browser.js'`, and add `browserGenerations, browserAge, browserMemory` to the metrics import.
- **`RelayedFailure`:** add two members:

```ts
  | { kind: 'overloaded'; message: string }
  | { kind: 'browser_unavailable'; message: string }
```

- **`classifyFailure`:** before `return { kind: 'other', message }`, add:

```ts
  if (err instanceof PoolOverloadedError) return { kind: 'overloaded', message }
  if (err instanceof BrowserUnavailableError) return { kind: 'browser_unavailable', message }
```

- **`reviveFailure`:** add two cases:

```ts
    case 'overloaded':
      return new PoolOverloadedError(f.message)
    case 'browser_unavailable':
      return new BrowserUnavailableError(f.message)
```

- **`recordFailureMetrics`:** before `scrapeFailures.inc({ reason: 'unknown' })`, add:

```ts
  if (err instanceof PoolOverloadedError) {
    scrapeFailures.inc({ reason: 'overloaded' })
    return
  }
  if (err instanceof BrowserUnavailableError) {
    scrapeFailures.inc({ reason: 'browser_unavailable' })
    return
  }
```

- **The route's catch chain:** after the `ExtractionTimeoutError` arm and before the final 502, add:

```ts
      if (err instanceof PoolOverloadedError) {
        // Transient and cheap to retry: nothing was attempted.
        reply.code(503)
        reply.header('Retry-After', '5')
        return { error: 'overloaded', id, message: err.message }
      }
      if (err instanceof BrowserUnavailableError) {
        // Transient: the browser is being relaunched. Says nothing about
        // Spotify's page, so it must not read as an extraction failure.
        reply.code(503)
        reply.header('Retry-After', '5')
        return { error: 'browser_unavailable', id, message: err.message }
      }
```

- **The `/metrics` handler:** replace the pool-gauge lines with:

```ts
    const stats = pool.stats()
    poolContexts.set({ state: 'free' }, stats.free)
    poolContexts.set({ state: 'leased' }, stats.leased)
    poolWaiting.set(stats.waiting)
    browserGenerations.set({ state: 'serving' }, stats.generations.serving)
    browserGenerations.set({ state: 'draining' }, stats.generations.draining)
    browserAge.reset()
    if (stats.browserAgeSeconds !== null) browserAge.set({ state: 'serving' }, stats.browserAgeSeconds)
    browserMemory.reset()
    if (stats.browserMemoryBytes !== null) browserMemory.set({ state: 'serving' }, stats.browserMemoryBytes)
```

`src/index.ts`:
- add `import type { PoolOptions } from './browser.js'`;
- add `browserLaunches, browserLaunchFailures` to the metrics import;
- above `main`, add:

```ts
/**
 * How the pool reports to the process. It counts launches, and when the pool
 * gives up on the browser it exits non-zero, so the container restart policy
 * gives the service a clean start: a process answering 503 forever is an
 * outage nobody is told about. `exit` is injected so this is testable.
 */
export function poolOptionsFor(exit: (code: number) => void): PoolOptions {
  return {
    observer: {
      launched: ({ reason }) => browserLaunches.inc({ reason }),
      launchFailed: () => browserLaunchFailures.inc(),
    },
    onFatal: (err) => {
      console.error(`[sleevenote] the browser cannot be relaunched -- exiting so the container restarts: ${err.message}`)
      exit(1)
    },
  }
}
```

- in `main`, change `createPool(cfg)` to `createPool(cfg, poolOptionsFor((code) => process.exit(code)))`.

- [ ] **Step 4: Run the new tests, then everything.** Run `npx tsc --noEmit && npm test`. Expected: the full suite green, with every new test passing.

- [ ] **Step 5: Sabotage each test, then restore:**
  - Delete the `lost` check in `runExtraction`: the extract test fails.
  - Delete only the `abortedWithin` wait: the extract test fails, *or* passes when the death happens to be seen first. Run it 5 times and report how many fail. The wait exists for the race, so a pass here is not proof it is unneeded.
  - Delete each server arm in turn: its status test fails.
  - Delete the relay members: the waiters test fails, with `internal`.
  - Remove `browserMemory.reset()`: the "omits" test fails, since the value leaks from the previous scrape. If test order hides this, run the two metrics tests in the other order and say so.
  - Make `onFatal` exit with 0: the index test fails.

- [ ] **Step 6: Commit**

```bash
git add src/extract.ts src/server.ts src/metrics.ts src/index.ts tests/extract.test.ts tests/server.test.ts tests/index.test.ts
git commit -m "feat: 503 overloaded and browser_unavailable, browser gauges, and exit on a browser that will not relaunch

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

---

### Task 9: Documentation and 0.5.0

**Files:**
- Modify: `docs/design-notes.md` (the `## The browser pool` section)
- Modify: `README.md` (the API section and the metrics paragraph)
- Modify: `package.json` and `package-lock.json` (via npm)

**Interfaces:**
- Consumes: everything. Produces: nothing code-facing.

- [ ] **Step 1: design-notes.** In `docs/design-notes.md`, directly after the subsection `### The pool owns the deadline, not the holder` (added in 0.4.1), add a subsection `### Generations: surviving the browser itself`. It covers, in this document's plain register (short paragraphs, **bold** for the load-bearing point, measured numbers rather than adjectives):
  - **why `launchServer()` rather than `launch()`:** pid, exit event, SIGKILL; and that the probe measured exit at +5 ms and disconnect at +14 ms after a SIGKILL;
  - **the state machine** `serving → draining → closed`, and why exactly one generation serves;
  - **blue/green** and the ~2× memory it costs for a few seconds;
  - **why PSS and not RSS;**
  - **relaunch backoff and escalation**, and why exiting beats a 503 that nobody acts on;
  - **the two 503 codes**, and why they are distinct;
  - **that the wait cap's default follows the budget**, and why a fixed default with a hard check would break a shortened budget.

  Link the spec: `docs/superpowers/specs/2026-09-19-browser-context-manager-design.md`.

- [ ] **Step 2: README.** In the API section, after the paragraph about `?partial=allow`, add:

```markdown
When sleevenote cannot take a lookup on, it answers **503** with
`Retry-After: 5` rather than making the caller wait: `overloaded` when every
browser context stayed busy for `POOL_WAIT_CAP_MS`, and `browser_unavailable`
when the browser died mid-lookup or is being relaunched. Both are transient.
Neither says anything about Spotify's page, which is why they are not 502s.
A key with a stale cache entry serves that entry instead.
```

After the paragraph about `sleevenote_pool_contexts`, add:

```markdown
The browser itself is `sleevenote_browser_generations{state="serving"|"draining"}`,
`sleevenote_browser_age_seconds` and `sleevenote_browser_memory_bytes` (both
absent while nothing is serving), with `sleevenote_browser_launches_total{reason}`
and `sleevenote_browser_launch_failures_total` counting what the manager did.
```

- [ ] **Step 3: Version**

Run: `npm version 0.5.0 --no-git-tag-version`
Then check with `git diff package.json package-lock.json`. Expected: only the version lines change, from `0.4.1` to `0.5.0`.

- [ ] **Step 4: The full gate.** Run `npx tsc --noEmit && npm test`. Expected: green. Record the verbatim `Tests` line in the report.

- [ ] **Step 5: Commit**

```bash
git add docs/design-notes.md README.md package.json package-lock.json
git commit -m "docs: the browser context manager; 0.5.0

Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)"
```

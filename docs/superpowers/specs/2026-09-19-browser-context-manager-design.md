# A browser context manager: crash recovery, recycling, and load shedding

**Date:** 2026-09-19
**Status:** approved in outline (approach A, and the component breakdown in
section 1). Sections 2 to 6 were settled autonomously at the owner's request
("run autonomously until we're at the live testing / ready PR"). Each call
made that way is marked **Ruling**, with what it costs if wrong.
**Builds on:** `fix/pool-lease-deadline` (0.4.1, unreleased; hotfixed onto
TuneTitan): pool-owned lease deadlines, revocation, bounded close and
bounded body waits. None of that changes here.
**Scope:** this repo. The cracktunes client and the homelab compose files
are follow-ups (see *Out of scope*).

## The problem

The 0.4.1 fix stops a stuck *lease* from starving the pool. It does nothing
for the *browser*, which the pool launches once and trusts for the life of
the process:

- **A Chromium crash is a permanent outage.** Nothing listens for the browser
  going away. Every later `newContext()` fails, `/health` goes 503, and
  neither stack has a healthcheck on sleevenote, so nothing restarts it.
- **One browser lives as long as the container.** Production's Chromium was
  at 1.27 GB of RSS three hours after a restart on 2026-09-19, and the
  previous one had run for 10 days. Context recycling at `CONTEXT_MAX_USES`
  bounds each context's growth, but not the browser's.
- **The queue has no bound but the budget.** An excess caller waits up to
  `PRODUCE_BUDGET_MS` (150 s) just to queue, and then gets the same 504 as a
  genuinely stuck extraction.

## Decisions

| | decision | settled by |
|---|---|---|
| D1 | The manager owns **crash → relaunch**, **aging → recycle**, and **overload → shed**. Zombie reaping stays a deployment concern (`init: true`). | owner |
| D2 | Recycle on **age or uses** (primary), and on **memory** (safety net). | owner |
| D3 | Shed on a **wait cap**: a caller waits at most `POOL_WAIT_CAP_MS` for a context, then gets a fast 503. | owner |
| D4 | **Approach A.** Browser generations in-process, launched with `chromium.launchServer()` and joined with `chromium.connect()`, so the manager holds the real OS process. | owner |
| D5 | Relaunch with exponential backoff. After `BROWSER_MAX_RELAUNCH_FAILURES` consecutive failures, escalate to an injected `onFatal`, which exits the process so the container restart policy takes over. | owner |
| D6 | A lease caught in a browser crash fails as a **transient 503**, not a 502. | owner |

Approach A was verified before this spec was written (Playwright 1.62.1, on
this workstation):

- `launchServer()` yields `server.process().pid`, and `page.route` works
  across `connect()`.
- A 6-process Chromium tree is fully readable through `/proc/<pid>/smaps_rollup`.
- A SIGKILL fires the process `exit` event after 5 ms, and `disconnected`
  after 14 ms.
- A pending `page.evaluate` rejects at once with `Browser closed`.

## 1. Components

The `Pool` interface keeps its shape: `acquire(deadline)`, `liveContexts()`,
`stats()`, `close()`. `extract.ts` and `server.ts` learn only two new error
types and a wider `stats()`.

| unit | job | depends on |
|---|---|---|
| `src/browser-process.ts` → `BrowserProcess` | One Chromium as an OS process: `launch()`, `browser`, `pid`, `onDeath(cb)` (process exit or disconnect, whichever is first, delivered exactly once), `close(ms)` (graceful, with a SIGKILL fallback through `server.kill()`), `memoryBytes()`. No pooling, no policy. | Playwright, `procmem` |
| `src/procmem.ts` → `processTreeBytes(pid, proc)` | Sums proportional set size (PSS) over a process and all its descendants. `/proc` access is an injected reader, so tests use a fake table. Returns `null` when `/proc` is absent, which disables the memory trigger rather than breaking it. | nothing |
| `src/browser.ts` → `createPool()`, the manager | All policy: generations, the waiter queue, lease deadlines and revocation (as in 0.4.1), the wait cap, recycle triggers, crash handling, backoff and escalation. | the two above |

**Ruling: PSS, not RSS.** Summing RSS across a Chromium tree counts shared
pages once per process, which overstates the tree by a large and varying
amount, so a threshold on it would be noise. `/proc/<pid>/smaps_rollup`'s
`Pss` divides each shared page among the processes that map it. A process
missing `smaps_rollup` falls back to `VmRSS` from `status`. *Costs if wrong:*
the memory trigger fires late or early. It is the safety net, not the
primary trigger.

## 2. Generations and their lifecycle

A **generation** is one `BrowserProcess` plus the contexts created from it,
its launch time, and its count of leases served. It is in exactly one state:

```
serving ──(recycle trigger)──▶ draining ──(last lease ends)──▶ closed
   │                              │
   └──────(process dies)──────────┴──────────────────────────▶ closed
```

- **Exactly one generation serves at a time**, or none while a relaunch is
  pending. Every new lease comes from the serving generation.
- **A draining generation never hands out a context.** A context released
  into it is closed, not reused. When its last lease ends, whether released
  or revoked at its deadline, the generation closes. Draining therefore lasts
  at most `PRODUCE_BUDGET_MS` plus `BROWSER_CLOSE_TIMEOUT_MS`.
- **The queue belongs to the manager.** A caller waiting across a recycle or
  a crash is served by the next serving generation, and never sees the switch.
- **Per-context recycling is unchanged.** A context is replaced at
  `CONTEXT_MAX_USES`, or when its page has closed, within its own generation.
- **Deadline revocation (0.4.1) follows the generation's state.** A revoked
  lease's context is closed either way. In the serving generation a fresh
  context replaces it; in a draining generation nothing does.
- **Startup is not a relaunch.** If the very first launch fails,
  `createPool()` rejects, as it does today, and `main()` exits non-zero. Backoff
  and escalation apply only once something has served.
- **`liveContexts()` counts the serving generation only**, so `/health` goes
  503 while nothing is serving. `stats()` counts `free` and `leased` across
  every generation, so a lease still held by a draining browser shows up.

### Recycle (D2)

Triggers are checked in two places: when a lease is released, and on a
periodic tick every `BROWSER_CHECK_INTERVAL_MS`. The tick also samples memory.
The first trigger to hold starts a recycle:

| trigger | default | knob |
|---|---|---|
| age | 6 h | `BROWSER_MAX_AGE_MS` |
| leases served | 1000 | `BROWSER_MAX_LEASES` |
| PSS of the process tree | 2048 MB (`0` disables) | `BROWSER_MAX_MEMORY_MB` |

`close()` stops the tick, rejects every waiter with `PoolClosedError`, and
closes every generation.

A recycle launches a new generation and fills it to `POOL_SIZE` contexts.
Only then does it swap the serving pointer, and the old generation starts
draining. A queued waiter is handed a context from the new generation
straight away.

- **Ruling: blue/green, not stop-the-world.** Launching the replacement
  before draining the old one costs a few seconds of about 2× browser memory,
  and in exchange no caller ever waits on a recycle. Production's VM has
  7.7 GB, and the browser has been measured at 1.3 GB. *Costs if wrong:* a
  memory-tight host would want the opposite. That would be a knob, not a
  redesign.
- **One recycle in flight at a time.** A trigger that fires during a launch is
  ignored; the next check re-evaluates it.
- **A failed recycle launch leaves the old generation serving.** It still
  works, which is the whole point. The next attempt waits for the same backoff
  as a relaunch, but a failed *recycle* never escalates.
- **Ruling: defaults.** Six hours and 1000 leases mean a low-traffic
  deployment (production sees tens of lookups a day) recycles on age, about
  four times a day, at the cost of a cold first extraction (~8 s instead of
  ~5 s). 2048 MB sits above the 1.3 GB seen three hours into a production
  run. The real numbers come from the new gauges; these are starting points.

### Crash (D5, D6)

`BrowserProcess.onDeath` fires once, on whichever comes first: the process
`exit` event or the browser's `disconnected` event.

- **The serving generation dies:** it is marked closed, and every lease on it
  is **lost** (below). The serving pointer is cleared, and a relaunch starts
  at once.
- **A draining generation dies:** it is marked closed and its leases are
  lost. No relaunch, since something else is already serving.
- **Relaunch backoff:** an attempt that fails waits 1 s, then 2 s, 4 s and so
  on, capped at 30 s. After `BROWSER_MAX_RELAUNCH_FAILURES` (default 5)
  consecutive failures, the manager calls `onFatal(err)` once and stops
  trying. `index.ts` passes a handler that logs and calls `process.exit(1)`,
  and `restart: unless-stopped` gives it a clean container.
- **Ruling: escalate by exiting, not by marking unhealthy.** Neither stack
  has a healthcheck on sleevenote, and one should not be required, so a
  process that answers 503 forever is an outage nobody is told about. *Costs
  if wrong:* a host with no restart policy loses the process instead of
  keeping a 503-answering one. That is no worse; both are down.

### Lost leases (D6)

Each `Lease` gains `lost: AbortSignal`. The manager aborts it when the
lease's browser dies, with a `BrowserUnavailableError` as the reason.
`runExtraction` checks it in one place: on any error, `if (lease.lost.aborted)
throw lease.lost.reason`. A crash is then reported as what it was, not as the
`Browser closed` or `Target closed` Playwright error the extraction happened
to be waiting on.

The failed call and the death notice race: the call can reject a few
milliseconds before the pool sees the exit or the disconnect. So a failure
that is not one of our own `ExtractionError` verdicts waits up to 1 s for
`lost` before it is judged. Our verdicts never wait. A goto timeout pays at
most one extra second on top of its 45 s, and a revoked lease's caller was
answered at the deadline, so nobody waits on that. A deadline revocation (0.4.1) does not abort `lost`;
`withBudget` already answers that caller with `ExtractionTimeoutError`.

## 3. Acquiring: the wait cap (D3)

`acquire(deadline)` keeps 0.4.1's semantics and adds one bound. A queued
caller that has waited `POOL_WAIT_CAP_MS` (default 20 s) leaves the queue and
is rejected with:

- `BrowserUnavailableError` if no generation is serving at that moment,
  because a relaunch is pending;
- `PoolOverloadedError` otherwise.

The deadline still applies, and whichever fires first wins.

**Ruling: the default follows the budget.** Left unset, `POOL_WAIT_CAP_MS` is
`min(20000, floor(PRODUCE_BUDGET_MS / 2))`. `loadConfig` **throws** only when
the operator sets it explicitly at or above `PRODUCE_BUDGET_MS`: the cap would
never fire, and that misconfiguration would otherwise be silent. A fixed
default with the same check would break any deployment that shortened the
budget without ever hearing of the cap (four existing tests do exactly that).

**Ruling: 20 s.** Warm extractions take 4 to 8 s, so a caller behind two
in-flight extractions on a pool of two is normally served well within it. A
caller that would have waited longer was going to see a slow answer at best,
and a 504 at worst.

## 4. The HTTP surface

| error | status | `error` code | header |
|---|---|---|---|
| `PoolOverloadedError` | 503 | `overloaded` | `Retry-After: 5` |
| `BrowserUnavailableError` | 503 | `browser_unavailable` | `Retry-After: 5` |

Both codes join the whole existing failure path:

- the route's `instanceof` chain;
- the single-flight `RelayedFailure` union (`classifyFailure` and
  `reviveFailure`), so a cohort waiting on the same key gets the same answer;
- `recordFailureMetrics`, as `reason="overloaded"` and
  `reason="browser_unavailable"`.

Stale-on-error needs no change: a key with a stale entry serves it with a 200,
exactly as for any other produce failure.

**Ruling: two codes, not one.** "Too busy" and "the browser is restarting"
call for different operator responses (raise `POOL_SIZE`, or read the crash
logs), and this service's rule is that failure kinds stay distinct. *Costs if
wrong:* one extra enum arm in a client.

## 5. Observability

Read from the manager at scrape time, as the 0.4.1 pool gauges are:

- `sleevenote_pool_contexts{state="free"|"leased"}` and
  `sleevenote_pool_waiting` (unchanged names; contexts counted across every
  generation);
- `sleevenote_browser_generations{state="serving"|"draining"}`;
- `sleevenote_browser_age_seconds` (serving generation);
- `sleevenote_browser_memory_bytes` (serving generation, last sample; absent
  when unmeasurable).

Counted through an injected observer, so `browser.ts` does not import the
metrics module. `observer.launched({ reason, generation, pid })` carries the
generation number and browser pid too: the pid is what a test SIGKILLs, and
what an operator matches against `ps`. `observer.launchFailed()` counts a
failed launch after startup:

- `sleevenote_browser_launches_total{reason}`, where `reason` is one of
  `startup`, `recycle_age`, `recycle_leases`, `recycle_memory` or `crash`;
- `sleevenote_browser_launch_failures_total`.

Each launch, recycle, crash, failed launch and escalation also logs one
`[pool]` line with the generation number and the reason.

## 6. Configuration

New knobs, all defaulted, all in the README table:

| key | default |
|---|---|
| `BROWSER_MAX_AGE_MS` | `21600000` (6 h) |
| `BROWSER_MAX_LEASES` | `1000` |
| `BROWSER_MAX_MEMORY_MB` | `2048` (`0` disables) |
| `BROWSER_CHECK_INTERVAL_MS` | `60000` |
| `BROWSER_CLOSE_TIMEOUT_MS` | `10000` |
| `BROWSER_MAX_RELAUNCH_FAILURES` | `5` |
| `POOL_WAIT_CAP_MS` | `min(20000, PRODUCE_BUDGET_MS / 2)`; an explicit value must be below `PRODUCE_BUDGET_MS` |

The backoff base (1 s) and cap (30 s) are constants. Tests reach them through
the existing test-only fault hooks, which grow `failNextLaunches`,
`backoffBaseMs`, `memoryOf` (in place of the `/proc` reading) and `now` (a
clock, so the age trigger is tested without waiting). Like the existing
hooks, they ride in `createPool`'s second argument next to `onFatal` and
`observer`, so `createPool(cfg)` stays the real signature.

## Testing

Real Chromium where the behaviour is Chromium's, and fakes where it is
arithmetic, as the suite already does.

- **`procmem`:** a fake `/proc` table covering a tree sum, a child that exits
  mid-walk, the `VmRSS` fallback, and `null` without `/proc`.
- **`BrowserProcess`:** launch gives a live `pid`, and `memoryBytes() > 0` on
  Linux. An external SIGKILL fires `onDeath` exactly once, however many of
  exit and disconnect arrive. `close(ms)` falls back to kill when the
  graceful close hangs, reached through a fault hook.
- **The manager:**
  - *age:* a tiny `BROWSER_MAX_AGE_MS` and check interval produce a new
    generation. A lease on the old one keeps working until it is released,
    since that is a drain, not a revoke. The old process is then gone.
  - *leases:* `BROWSER_MAX_LEASES=3` recycles on the fourth lease.
  - *memory:* the fault-hook reader reports an over-limit value, and a recycle
    follows.
  - *crash:* SIGKILL the serving pid. The in-flight lease's `lost` aborts with
    `BrowserUnavailableError`, a waiting caller is served by the relaunched
    generation, and `liveContexts()` recovers.
  - *escalation:* `failNextLaunches` beyond the limit calls `onFatal` exactly
    once.
  - *failed recycle launch:* the old generation keeps serving, and `onFatal`
    is not called.
  - *wait cap:* `overloaded` when saturated, `browser_unavailable` when
    nothing is serving.
  - All of 0.4.1's pool tests keep passing unchanged.
- **`extract`:** a crash mid-extraction rejects with `BrowserUnavailableError`,
  not a Playwright error.
- **`server`:** both 503 mappings with `Retry-After`, a relay round-trip for
  both kinds, stale served on `overloaded`, and the new gauges.
- **Config:** `POOL_WAIT_CAP_MS >= PRODUCE_BUDGET_MS` throws.
- Every new test is seen failing first, and every test is sabotaged once.
- **Live:** `SLEEVENOTE_LIVE=1` smoke passes, then a TuneTitan canary through
  the same hotfix override used for 0.4.1.

## Out of scope

- **cracktunes' client** (`crack-sleevenote`) learning `overloaded` and
  `browser_unavailable`. Until it does, it keeps them as
  `ErrorCode::Unrecognized` and shows a generic error. A follow-up should map
  both to a "busy, try again" message, and consider one retry on
  `browser_unavailable`.
- **homelab:** `init: true` for sleevenote in both stacks, made permanent
  rather than living only in the hotfix override; the image pin bump; a
  healthcheck if wanted.
- **Out-of-process browsers** (approach C). Nothing here forecloses it:
  `BrowserProcess` is the seam a remote browser would replace.
- **Zombie reaping inside the image** (D1).

## Risks

- **`connect()` adds a WebSocket hop.** Loopback only, and a probe showed
  routing and events behave identically, but it is a changed transport under
  every extraction. The full offline suite and the live smoke run over it
  before merge.
- **Blue/green briefly doubles browser memory**, as ruled above.
- **The PSS walk reads a few dozen `/proc` files per sample**, once a minute.
  Negligible, but it is Linux-specific: elsewhere the memory trigger is off,
  and says so once at startup.

Version: **0.5.0** (a feature). The branch sits on the unreleased 0.4.1 fix.

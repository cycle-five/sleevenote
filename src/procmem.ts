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

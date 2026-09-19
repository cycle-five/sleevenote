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

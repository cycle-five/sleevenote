import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * The running build's version, read from package.json at startup.
 *
 * Walks up looking for *this package's* manifest rather than hardcoding a
 * relative path, because the same module resolves from two different depths:
 * `dist/src/version.js` in the image and under `npm start`, but `src/
 * version.ts` under vitest. A fixed '../..' is correct for exactly one of
 * those and silently wrong for the other. The `name` check is what stops the
 * walk from picking up a parent directory's unrelated package.json if this
 * repo is ever checked out inside another project.
 *
 * Never throws: an unreadable manifest degrades to 'unknown'. A service must
 * not fail to boot over its own version string.
 */
export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === 'sleevenote' && pkg.version) return pkg.version
    } catch {
      // Not here (or not readable) -- keep walking.
    }
    dir = dirname(dir)
  }
  return 'unknown'
}

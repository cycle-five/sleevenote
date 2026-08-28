import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * The running build's version, read from package.json at startup.
 *
 * Walks up rather than hardcoding a relative path: this module resolves from
 * `dist/src` in the image but `src` under vitest, so a fixed '../..' is right
 * for exactly one of them. The `name` check stops the walk from picking up an
 * enclosing project's manifest. Never throws -- a service must not fail to
 * boot over its own version string.
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

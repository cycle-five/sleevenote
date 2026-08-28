import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { readVersion } from '../src/version.js'

describe('readVersion', () => {
  // Guards the walk in both directions: a version that came back 'unknown'
  // means the walk failed to find the manifest, and one that disagrees with
  // package.json means it found the wrong manifest. Either way /metrics would
  // report a build that isn't the one running.
  it('reports the version in package.json, not a fallback', () => {
    const declared = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }).version
    expect(readVersion()).toBe(declared)
    expect(readVersion()).not.toBe('unknown')
  })
})

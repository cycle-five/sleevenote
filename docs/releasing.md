# Releasing sleevenote

The artifact is a **container image**, not an npm package. Nobody installs
this from a registry of modules; cracktunes talks to it over HTTP. So a
release means: a signed tag, an image on ghcr.io, and a GitHub release.

## The loop

```
branch → change → bump package.json → PR → green → merge
       → git checkout master && git pull --ff-only
       → git tag -s vX.Y.Z -m "..." && git push origin vX.Y.Z
```

Pushing the tag is the only thing that publishes. `.github/workflows/release.yml`
then does the rest: verifies, builds, pushes the image, and creates the
GitHub release with generated notes. There is no manual `gh release create`
step — the workflow owns it.

## Version bumps

Patch for bugs, minor for features, matching the standing cadence. The bump
goes in the **PR**, not in a commit on master afterwards: the release
workflow refuses to publish a tag that disagrees with `package.json`, so a
forgotten bump fails loudly at the tag rather than shipping an image whose
reported version cannot be found in git.

`0.x` while the HTTP contract is still settling against its first real
consumer. Breaking the JSON shapes or route names before `1.0.0` costs a
minor bump, not a major.

## What the release workflow checks before publishing

1. The tag matches `package.json`.
2. `tsc --noEmit`.
3. The offline suite.
4. **The live smoke suite**, against real Spotify.

Step 4 is the deliberate exception to the rule that CI never depends on a
third party. The offline corpus is a snapshot and cannot notice that Spotify
changed its page shape since the corpus was recorded — which is the single
failure mode this service exists to absorb. Gating the release there is worth
the coupling; gating *CI* there would not be, which is why `ci.yml` still
never sets `SLEEVENOTE_LIVE`.

If a release fails on step 4 because Spotify is down or rate-limiting rather
than because extraction is broken, re-run the job once it recovers. Do not
route around it by publishing manually.

## Consuming the image

```
ghcr.io/cycle-five/sleevenote:0.1.0   # exact
ghcr.io/cycle-five/sleevenote:0.1     # floats patches
ghcr.io/cycle-five/sleevenote:latest  # newest non-prerelease
```

Pin exactly in anything that matters. The package inherits the repository's
visibility, so while this repo is private the image needs a token to pull.

## Which build is running

`GET /metrics` reports `sleevenote_build_info{version="..."} 1`, set once at
startup from `package.json`. That is the authoritative answer to "what is
deployed" — the deploy log is not.

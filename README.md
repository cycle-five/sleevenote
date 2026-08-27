# sleevenote

Resolve a music-entity URL to normalized metadata. No provider API key.

Sleeve notes are the printed metadata on an album sleeve — artist, title, track
listing. That is what this returns.

**Status: design only.** Nothing is implemented yet. Start with
[the design spec](docs/superpowers/specs/2026-08-27-sleevenote-design.md).

## What it does

```
GET /v1/track/:id      -> Track
GET /v1/album/:id      -> Album      (includes tracks)
GET /v1/playlist/:id   -> Playlist   (includes tracks)
GET /health            -> "sleevenote ok"
GET /metrics           -> Prometheus exposition
```

A stateless TypeScript service that drives headless Chromium via Playwright,
reads the JSON the page itself fetches, normalizes it, and caches aggressively
in Redis. Auth and rate limiting are deliberately absent — they belong to a load
balancer in front, which keeps private and public deployments the same artifact.

## Why

The provider API this replaces stopped being obtainable. Spotify deprecated a
set of Web API endpoints in November 2024 and, separately, has blocked the
creation of new Web API applications since roughly December 2025. An operator
without pre-existing credentials cannot get them. The design document covers
what was tried before resorting to this, and what it costs.

## Licence

MIT.

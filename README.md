# sleevenote

Resolve a music-entity URL to normalized metadata. No provider API key.

Sleeve notes are the printed metadata on an album sleeve — artist, title, track
listing. That is what this returns.

A stateless TypeScript service that drives headless Chromium via Playwright,
reads the JSON the page itself fetches, normalizes it, and caches aggressively
in Redis. Auth and rate limiting are deliberately absent — they belong to a load
balancer in front, which keeps private and public deployments the same artifact.

## What it does

```
GET /v1/track/:id      -> Track
GET /v1/album/:id      -> Album      (includes tracks)
GET /v1/playlist/:id   -> Playlist   (includes tracks)
GET /health            -> "sleevenote ok"
GET /metrics           -> Prometheus exposition
```

`:id` is the raw Spotify entity id (the last path segment of
`open.spotify.com/{track,album,playlist}/{id}`), not a full URL.

Real request/response examples, captured from a running deployment, live in
[docs/examples](docs/examples/README.md) -- a committed contract an
out-of-repo client can build and test against.

## Running it

```bash
cp .env.example .env
# Edit .env: at minimum, set BIND_ADDR to this host's own address on the
# private network you want to serve on -- compose refuses to start without it.
docker compose build
docker compose up -d
```

The image is built `FROM` Playwright's own published image
(`mcr.microsoft.com/playwright:v1.62.1-noble`), tag-matched to the `playwright`
version pinned in `package-lock.json`. This is deliberate: a bare Node image
with an apt-get'd Chromium is exactly the browser/driver mismatch that rotted
the prior art this project replaces. If you bump the `playwright` dependency,
bump the `FROM` tag in the `Dockerfile` in the same change.

`docker-compose.yml` publishes on `${BIND_ADDR}:3000` and has no default,
deliberately. `BIND_ADDR` must be **this host's own address** on the network
you intend to serve — not `0.0.0.0`, which silently starts publishing on any
interface the host later gains, and not a bare network address like
`10.0.0.0`, which is not assignable to a host and cannot be bound at all.

**The service has no authentication of its own.** It is designed to sit behind
something that provides it — a load balancer, a reverse proxy, a firewalled
private network. Publishing it anywhere that is not already true gives
anonymous callers a browser that will fetch URLs on their behalf. Binding to a
private address is a convenience, not the control; the network is.

### Checking it came up

`docker compose` builds and runs the stack wherever the *active Docker
context* points, which is not necessarily `localhost` — e.g. a remote context
over SSH. Don't assume `127.0.0.1`; resolve the host you're actually talking
to:

```bash
HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}' \
  | sed -E 's#^(tcp|ssh)://([^@/]+@)?##; s#:.*$##; s#^unix://.*#127.0.0.1#')
echo "docker context: $(docker context show) -> $HOST"
curl -fsS "http://$HOST:3000/health"
```

Expected: `sleevenote ok`, printed alongside the host it hit. Then
`docker compose down`.

## Configuration

Every key `loadConfig` reads, with its default — see `.env.example` for the
copy-pasteable version with fuller comments:

| Key | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port the service listens on |
| `LOG_LEVEL` | `info` | pino level. `silent` turns logging off; anything below `warn` still emits one line per request |
| `REDIS_URL` | `redis://127.0.0.1:6379` | the only state this stateless service depends on |
| `POOL_SIZE` | `2` | browser contexts kept warm; excess requests queue, they don't fail |
| `CONTEXT_MAX_USES` | `50` | extractions served before a context is recycled |
| `NAV_TIMEOUT_MS` | `45000` | cap on a single page navigation |
| `PRODUCE_BUDGET_MS` | `150000` | cap on one whole extraction; also sets the cache's single-flight lock TTL (see `src/config.ts`) |
| `TTL_TRACK` | `2592000` (30d) | track cache TTL, in seconds |
| `TTL_ALBUM` | `2592000` (30d) | album cache TTL, in seconds |
| `TTL_PLAYLIST` | `14400` (4h) | playlist cache TTL — playlists genuinely change |
| `TTL_NEGATIVE` | `600` | how long a confirmed-absent id is negative-cached |
| `FAILURE_RELAY_TTL` | `5` | how long a failed extraction stays visible to callers already waiting on the same id. Seconds, deliberately: this is a handoff to the cohort already blocked, not a negative cache for errors. Raising it throttles a permanently-broken entity, at the price of a fixed-and-redeployed scraper still serving the old failure until it expires |

### Items that cannot be resolved

A playlist may hold podcast episodes and local files. Episodes are returned as
tracks, attributed to their show. Local files cannot be -- their Spotify uri
carries no id -- so `Playlist` and `Album` both report `unresolvedItems`:
`tracks.length + unresolvedItems` always equals what Spotify listed.

## Design notes

Why the code is shaped the way it is -- the pagination techniques that failed
before the current one worked, why four extraction errors stay distinct, why
the failure-relay TTL is seconds -- lives in
[docs/design-notes.md](docs/design-notes.md). The comments in `src/` are kept
short and point there.

## Releasing

Pushing a signed `vX.Y.Z` tag builds and publishes
`ghcr.io/cycle-five/sleevenote` and creates the GitHub release. The version
bump belongs in the PR — the release workflow refuses a tag that disagrees
with `package.json`. Full process, and the reasoning behind the live-Spotify
release gate, in [docs/releasing.md](docs/releasing.md).

A running instance reports its own build as
`sleevenote_build_info{version="..."}` on `GET /metrics`.

## Testing

```bash
npx vitest run
```

Runs the offline suite: no network required, though `tests/store.redis.test.ts`
exercises a real Redis if one is reachable at `REDIS_URL` and otherwise skips
with a stated reason.

### Live smoke test

`tests/live.smoke.test.ts` is the only test that touches the real internet —
it drives an actual browser against `open.spotify.com`. It SKIPs with a stated
reason unless explicitly opted in, so a red run always means something is
broken, never "no network":

```bash
SLEEVENOTE_LIVE=1 npx vitest run tests/live.smoke.test.ts
```

CI runs the offline suite only; a schedule runs this one separately.

## Why

The provider API this replaces stopped being obtainable. Spotify deprecated a
set of Web API endpoints in November 2024 and, separately, has blocked the
creation of new Web API applications since roughly December 2025. An operator
without pre-existing credentials cannot get them.
[The design document](docs/superpowers/specs/2026-08-27-sleevenote-design.md)
covers what was tried before resorting to this, and what it costs.

## Licence

MIT.

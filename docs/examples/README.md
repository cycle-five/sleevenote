# Response examples

Five real HTTP responses, captured directly from a running sleevenote v0.1.0
deployment -- not hand-written. Field shapes are defined by `src/types.ts`;
these are worked examples of what that code actually produced on the wire.

They are a **contract artifact**: an out-of-repo Rust client deserializes
these fixtures in its own CI, so a wire-format regression here fails a build
over there before it reaches production.

| File             | Response | Contents |
|-------------------|----------|----------|
| `track.json`      | 200      | a Track |
| `album.json`      | 200      | an Album (60 tracks) |
| `playlist.json`   | 200      | a Playlist (2 tracks, 2 unresolved -- a podcast episode and a local file) |
| `notfound.json`   | 404      | the error shape |
| `invalid.json`    | 400      | the error shape |

`album.json` and `playlist.json` each carry two fields present on **every**
Album/Playlist response, complete or not:

| Field | Meaning |
|---|---|
| `declaredItems` | Spotify's own declared total for the listing; `null` when the page declared none |
| `complete` | whether every declared item was seen; `true` when `declaredItems` is `null`, because a shortfall cannot be claimed against a total that was never measured |

Both fixtures here happen to be complete (`complete: true`) -- a short
listing (`complete: false`) is served only to a caller that opts in with
`?partial=allow`; see the root `README.md`.

If a change touches a response shape -- a field added, renamed, or its
nullability changed -- update these files in the **same** change.
`tests/examples.test.ts` checks them against `src/types.ts`; it does not
regenerate them.

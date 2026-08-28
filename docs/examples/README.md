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

If a change touches a response shape -- a field added, renamed, or its
nullability changed -- update these files in the **same** change.
`tests/examples.test.ts` checks them against `src/types.ts`; it does not
regenerate them.

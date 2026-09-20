# pedals-mcp

Remote MCP server over the pedal manuals published at
[pedals.kyxap.pro](https://pedals.kyxap.pro) (source: [kyxap1/pedals](https://github.com/kyxap1/pedals)).

Agents ask it questions instead of loading whole manual files into context.

## What is here

`build-db.mjs` turns the manuals into `dist/pedals.sql`: one row per section,
split so nothing served exceeds 3000 characters, plus the tables kept whole and
an FTS5 index over the full text. Every section carries a `…/<slug>/#<id>`
citation back to the published page.

```
node build-db.mjs <manuals-root> [out.sql]
npm test                     # PEDALS_ROOT=<manuals-root> to point at the manuals
```

The tests run against real manuals rather than checked-in fixtures, so they need
`kyxap1/pedals` checked out — by default as a sibling directory named `pedals`.

## Deployment

A push to `kyxap1/pedals` that touches a manual fires `repository_dispatch` here,
which rebuilds the database and applies it to D1. A full rebuild drops and
recreates every table, so the result never depends on what was there before.

Requires `CLOUDFLARE_API_TOKEN` in this repository's secrets, and
`MCP_DISPATCH_TOKEN` in `kyxap1/pedals` — a fine-grained PAT with Actions: write
scoped to this repository.

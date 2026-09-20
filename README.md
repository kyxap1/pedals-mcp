# pedals-mcp

Remote MCP server over the pedal manuals published at
[pedals.kyxap.pro](https://pedals.kyxap.pro) (source: [kyxap1/pedals](https://github.com/kyxap1/pedals)).

Agents ask it questions instead of loading whole manual files into context.

Endpoint: `https://pedals-mcp.kyxap.pro/mcp` (Streamable HTTP, no auth).

## What is here

`build-db.mjs` turns the manuals into rows: one per section, split so nothing
served exceeds 3000 characters, plus the tables kept whole and an FTS5 index
over the full text. Every section carries a `…/<slug>/#<id>` citation back to
the published page. `schema.mjs` holds the DDL both the builder and the Worker
apply. `src/index.js` is the Worker: five tools — `search`, `fetch`,
`list_pedals`, `get_section`, `get_table` — and the `/load` route.

```
node build-db.mjs <manuals-root> [out.sql]   # local SQL dump, for inspection
npm test                                     # PEDALS_ROOT=<manuals-root>

npx wrangler dev --local --var DB_WRITE_TOKEN:test
MCP_URL=http://127.0.0.1:8787 DB_WRITE_TOKEN=test node load.mjs <manuals-root>
MCP_URL=http://127.0.0.1:8787 node e2e.mjs   # every tool against a loaded database
```

`wrangler dev` needs glibc: on a musl image npm skips the `workerd` binary.

The tests run against real manuals rather than checked-in fixtures, so they need
`kyxap1/pedals` checked out — by default as a sibling directory named `pedals`.

## Deployment

A push to `kyxap1/pedals` that touches a manual dispatches the rebuild workflow
here. It deploys the Worker, then runs `load.mjs`, which POSTs the rows to the
Worker's `/load` route; the Worker writes them through its own D1 binding. A
load starts by dropping every table, so the result never depends on what was
there before.

Data travels as values rather than as a SQL file run by `wrangler d1 execute`
so that **CI never holds a D1 credential**. D1 API tokens cannot be scoped to a
single database, so one would reach every database in the account; the Worker's
binding reaches this one and nothing else.

Secrets:

| Where | Name | What |
|---|---|---|
| this repo | `CLOUDFLARE_API_TOKEN` | Workers: Editor, scoped to the `pedals-mcp` Worker alone |
| this repo | `DB_WRITE_TOKEN` | shared with the Worker; authorises `/load` |
| Worker | `DB_WRITE_TOKEN` | the same value, set in Settings → Variables and Secrets |
| `kyxap1/pedals` | `MCP_DISPATCH_TOKEN` | fine-grained PAT scoped to this repo, Actions: write |

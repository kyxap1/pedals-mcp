# pedals-mcp

Remote MCP server over the pedal manuals published at
[pedals.kyxap.pro](https://pedals.kyxap.pro) (source: [kyxap1/pedals](https://github.com/kyxap1/pedals)).

Agents ask it questions instead of loading whole manual files into context.

Endpoint: `https://pedals-mcp.kyxap.pro/mcp` (Streamable HTTP, no auth; 20 requests per
10 seconds per client IP, then 429).

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

Code and data ship on separate triggers, so neither can block the other:

- **`deploy.yml`** — a push here that touches `src/`, `schema.mjs`,
  `wrangler.toml` or the lockfile runs `wrangler deploy`.
- **`rebuild.yml`** — `workflow_dispatch` only; `kyxap1/pedals` fires it when a
  manual changes. It runs `load.mjs`, which POSTs the rows to the Worker's
  `/load` route, then `e2e.mjs` against the result. Rows fill `*_new` tables and
  a final request swaps them in as one transaction, so the tools keep serving the
  old data until then and a failed load leaves it untouched. The swap is refused
  (409) unless every staged table holds the row count the loader reports.

Data travels as values rather than as a SQL file run by `wrangler d1 execute`
so that **CI never holds a D1 credential**. D1 API tokens cannot be scoped to a
single database, so one would reach every database in the account; the Worker's
binding reaches this one and nothing else.

`pedals-mcp.kyxap.pro` is attached to the Worker by hand and is not declared in
`wrangler.toml`; see the comment there. The DDL a load applies is the one that
shipped with the deployed Worker, so a push to `master` dispatches `rebuild.yml`
once `deploy.yml` has gone live.

Secrets:

| Where | Name | What |
|---|---|---|
| this repo | `CLOUDFLARE_API_TOKEN` | Workers: Editor, scoped to the `pedals-mcp` Worker alone |
| this repo | `DB_WRITE_TOKEN` | shared with the Worker; authorises `/load` |
| Worker | `DB_WRITE_TOKEN` | the same value, set in Settings → Variables and Secrets |
| `kyxap1/pedals` | `MCP_DISPATCH_TOKEN` | fine-grained PAT scoped to this repo, Actions: write |

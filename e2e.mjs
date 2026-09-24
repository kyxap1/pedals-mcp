#!/usr/bin/env node
// The one check on the Worker: every tool answered from a real loaded database.
//
//   npx wrangler dev --local --var DB_WRITE_TOKEN:test
//   MCP_URL=http://127.0.0.1:8787 DB_WRITE_TOKEN=test node load.mjs <manuals-root>
//   MCP_URL=http://127.0.0.1:8787 node e2e.mjs
//
// Usage: MCP_URL=… node e2e.mjs

import assert from 'node:assert/strict';

const BASE = process.env.MCP_URL || 'http://127.0.0.1:8787';

// Streamable HTTP answers as SSE, so the JSON-RPC envelope arrives in a data:
// line rather than as the whole body.
async function call(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200, `${name} returned ${res.status}`);
  const line = (await res.text()).split('\n').find((l) => l.startsWith('data: '));
  assert.ok(line, `${name} returned no data frame`);
  return JSON.parse(line.slice(6)).result;
}

const ok = (r, what) => {
  assert.ok(!r.isError, `${what}: ${r.content?.[0]?.text}`);
  // The contract both connector styles rely on: the payload twice, and the
  // text copy parsing back to the same thing.
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, `${what}: copies differ`);
  return r.structuredContent;
};

const load = await fetch(`${BASE}/load`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ init: true }),
});
assert.equal(load.status, 401, '/load accepted an unauthorised request');

const { results } = ok(await call('search', { query: 'rc-5 midi clock' }), 'search');
assert.ok(results.length, 'search found nothing');
for (const r of results) assert.ok(r.url && r.chars > 0, `search result without url or size: ${r.id}`);

// A stray quote is an FTS5 syntax error unless the query is sanitised.
ok(await call('search', { query: 'midi "clock' }), 'search with a stray quote');

const section = ok(await call('fetch', { id: results[0].id }), 'fetch');
assert.equal(section.id, results[0].id);
assert.ok(section.text.length, 'fetch returned an empty section');

const table = ok(
  await call('get_table', { pedal: 'source-audio-eq2', anchor: 'midi-mapping', limit: 2 }),
  'get_table'
);
assert.equal(table.rows.length, 2);
assert.equal(table.next_offset, 2, 'a paged table must say where to continue');
assert.ok(table.total > 2 && table.headers.length, 'headers repeat with every page');

const { pedals } = ok(await call('list_pedals', {}), 'list_pedals');
assert.ok(pedals.length > 1 && pedals.every((p) => p.url), 'every pedal carries a page URL');

const missing = await call('get_section', { pedal: 'nope', anchor: 'x' });
assert.ok(missing.isError, 'a missing section must be an error, not an empty answer');

console.log(`ok — ${pedals.length} pedals, ${results.length} hits, table of ${table.total} rows`);

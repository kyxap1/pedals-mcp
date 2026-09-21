#!/usr/bin/env node
// Loads the built rows into D1 through the Worker's /load route.
//
// The Worker owns the D1 binding, so nothing here needs a Cloudflare token —
// only the shared DB_WRITE_TOKEN. That is the whole reason the rows travel as
// values rather than as a SQL file run by `wrangler d1 execute`.
//
// Usage: MCP_URL=… DB_WRITE_TOKEN=… node load.mjs <manuals-root>

import { readFile } from 'node:fs/promises';
import { findManuals, parsePage, tablesOf } from './build-db.mjs';
import { COLUMNS } from './schema.mjs';

const MAX_ROWS = 100; // one bound statement per row inside a D1 batch
const MAX_BYTES = 400_000; // keeps JSON.parse in the Worker well under its CPU slice

function* chunks(rows) {
  let buf = [];
  let size = 0;
  for (const row of rows) {
    const bytes = JSON.stringify(row).length;
    if (buf.length && (buf.length >= MAX_ROWS || size + bytes > MAX_BYTES)) {
      yield buf;
      buf = [];
      size = 0;
    }
    buf.push(row);
    size += bytes;
  }
  if (buf.length) yield buf;
}

async function post(url, token, body) {
  const res = await fetch(new URL('/load', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const url = process.env.MCP_URL;
  const token = process.env.DB_WRITE_TOKEN;
  if (!url || !token) throw new Error('MCP_URL and DB_WRITE_TOKEN must be set');

  const root = process.argv[2];
  if (!root) throw new Error('usage: node load.mjs <manuals-root>');

  const pages = [];
  for (const m of await findManuals(root))
    pages.push(parsePage(await readFile(m.file, 'utf8'), m.slug));

  if (!pages.length) throw new Error(`no manuals under ${root}`);

  const tables = tablesOf(pages);

  await post(url, token, { reset: true });
  const counts = {};
  for (const [table] of Object.entries(COLUMNS)) {
    let sent = 0;
    for (const rows of chunks(tables[table])) {
      await post(url, token, { table, rows });
      sent += rows.length;
    }
    counts[table] = sent;
    console.log(`${table}: ${sent} rows`);
  }
  await post(url, token, { finish: true, counts });

  console.log(`loaded ${pages.length} manuals into ${url}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

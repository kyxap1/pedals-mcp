#!/usr/bin/env node
// Loads the built rows into D1 through the Worker's /load route.
//
// The Worker owns the D1 binding, so nothing here needs a Cloudflare token —
// only the shared DB_WRITE_TOKEN. That is the whole reason the rows travel as
// values rather than as a SQL file run by `wrangler d1 execute`.
//
// Only pedals whose hash changed are rewritten, each in one request. The hash
// covers the builder and the schema as well as the page, so a parser change
// reloads everything.
//
// Usage: MCP_URL=… DB_WRITE_TOKEN=… node load.mjs <manuals-root>

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { findManuals, parsePage, tablesOf } from './build-db.mjs';

async function post(url, token, body, query = '') {
  const res = await fetch(new URL(`/load${query}`, url), {
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

  const manuals = await findManuals(root);
  // An empty checkout would otherwise drop every pedal.
  if (!manuals.length) throw new Error(`no manuals under ${root}`);

  const builder = await Promise.all(
    ['build-db.mjs', 'schema.mjs'].map((f) => readFile(new URL(f, import.meta.url)))
  );
  const { hashes } = await post(url, token, { init: true });

  let loaded = 0;
  for (const m of manuals) {
    const html = await readFile(m.file, 'utf8');
    const hash = createHash('sha256').update(builder[0]).update(builder[1]).update(html).digest('hex');
    if (hashes[m.slug] === hash) continue;

    const page = parsePage(html, m.slug);
    page.hash = hash;
    const tables = tablesOf([page]);
    await post(url, token, tables, `?put=${encodeURIComponent(m.slug)}`);
    console.log(`loaded ${m.slug}: ${tables.section.length} sections, ${tables.tbl.length} tables`);
    loaded++;
  }

  const local = new Set(manuals.map((m) => m.slug));
  let dropped = 0;
  for (const slug of Object.keys(hashes))
    if (!local.has(slug)) {
      await post(url, token, { drop: slug });
      console.log(`dropped ${slug}`);
      dropped++;
    }

  console.log(`${loaded} loaded, ${dropped} dropped, ${manuals.length - loaded} unchanged — ${url}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

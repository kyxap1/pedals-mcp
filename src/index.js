// The MCP server over the pedal manuals, plus the route CI loads D1 through.
//
// CI holds no D1 credentials: its Cloudflare token is Workers-Editor on this
// Worker alone. It POSTs rows here and the Worker writes them through its own
// binding, which reaches this database and no other.

import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { DDL_STATEMENTS, COLUMNS, FTS_REBUILD, SITE } from '../schema.mjs';

const SEARCH_LIMIT = 10;
const TABLE_LIMIT = 30;
const SNIPPET_TOKENS = 12;

// ------------------------------------------------------------------ shared

const urlOf = (slug, anchor) => `${SITE}/${slug}/${anchor ? `#${anchor}` : ''}`;
const idOf = (r) => `${r.slug}#${r.anchor}${r.part > 1 ? `/${r.part}` : ''}`;

// `<slug>#<anchor>[/part]`. A manual's intro section has no anchor, so the
// fragment can legitimately be empty.
function parseId(id) {
  const hash = id.indexOf('#');
  if (hash < 0) return null;
  const slug = id.slice(0, hash);
  const rest = id.slice(hash + 1);
  const slash = rest.indexOf('/');
  return slash < 0
    ? { slug, anchor: rest, part: 1 }
    : { slug, anchor: rest.slice(0, slash), part: Number(rest.slice(slash + 1)) || 1 };
}

// Both shapes at once: structuredContent for clients that read it, the same
// JSON as text for the ones that only read content[0].
const reply = (data) => ({
  structuredContent: data,
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const fail = (message) => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

// ------------------------------------------------------------------ search

// User text reaches FTS5's query parser, where a stray quote or hyphen is a
// syntax error rather than a term. Quoting each token defuses all of it.
const terms = (query) =>
  (query.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) || []).map((t) => `"${t.replace(/"/g, '')}"`);

const SEARCH_SQL = `
  SELECT s.slug, s.anchor, s.title, s.part, s.chars,
         snippet(section_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snip
  FROM section_fts JOIN section s ON s.id = section_fts.rowid
  WHERE section_fts MATCH ?1
  ORDER BY bm25(section_fts, 10.0, 1.0)
  LIMIT ?2`;

async function search(db, query, limit) {
  const t = terms(query);
  if (!t.length) return [];
  const run = (match) => db.prepare(SEARCH_SQL).bind(match, limit).all();
  // All terms first, because precision is what keeps a reply small; any term
  // only when that finds nothing, because an empty result is a dead end.
  let { results } = await run(t.join(' '));
  if (!results.length && t.length > 1) ({ results } = await run(t.join(' OR ')));
  return results;
}

// ------------------------------------------------------------------- tools

const SECTION_SQL = `
  SELECT s.*, (SELECT MAX(part) FROM section p
               WHERE p.slug = s.slug AND p.anchor = s.anchor) AS parts
  FROM section s
  WHERE s.slug = ?1 AND s.anchor = ?2 AND s.part = ?3`;

async function sectionOf(db, { slug, anchor, part }) {
  return db.prepare(SECTION_SQL).bind(slug, anchor, part).first();
}

function sectionPayload(row) {
  return {
    id: idOf(row),
    pedal: row.slug,
    title: row.title,
    text: row.render,
    url: urlOf(row.slug, row.anchor),
    metadata: {
      chars: row.chars,
      part: row.part,
      parts: row.parts,
      next: row.part < row.parts ? `${row.slug}#${row.anchor}/${row.part + 1}` : null,
    },
  };
}

const SECTION_OUT = {
  id: z.string(),
  pedal: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.object({
    chars: z.number(),
    part: z.number(),
    parts: z.number(),
    next: z.string().nullable(),
  }),
};

function createServer(env) {
  const db = env.DB;
  const server = new McpServer({ name: 'pedals-mcp', version: '1.0.0' });

  server.registerTool(
    'search',
    {
      description:
        'Full-text search across every guitar-pedal manual. Returns section ids, titles, ' +
        'deep links and the size of each section, so a fetch can be chosen before it is paid for.',
      inputSchema: {
        query: z.string().describe('words to look for, e.g. "rc-5 midi clock"'),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
            pedal: z.string(),
            snippet: z.string(),
            chars: z.number(),
          })
        ),
      },
    },
    async ({ query }) => {
      const rows = await search(db, query, SEARCH_LIMIT);
      return reply({
        results: rows.map((r) => ({
          id: idOf(r),
          title: r.title,
          url: urlOf(r.slug, r.anchor),
          pedal: r.slug,
          snippet: r.snip,
          chars: r.chars,
        })),
      });
    }
  );

  server.registerTool(
    'fetch',
    {
      description: 'Return one manual section by the id that search gave back.',
      inputSchema: { id: z.string().describe('<pedal>#<anchor>[/part], from search') },
      outputSchema: SECTION_OUT,
    },
    async ({ id }) => {
      const ref = parseId(id);
      if (!ref) return fail(`Malformed id "${id}"; expected <pedal>#<anchor>[/part].`);
      const row = await sectionOf(db, ref);
      return row ? reply(sectionPayload(row)) : fail(`No section "${id}".`);
    }
  );

  server.registerTool(
    'list_pedals',
    {
      description: 'Every pedal with a manual here: slug, name and the page URL.',
      inputSchema: {},
      outputSchema: {
        pedals: z.array(z.object({ slug: z.string(), name: z.string(), url: z.string() })),
      },
    },
    async () => {
      const { results } = await db
        .prepare('SELECT slug, name, url FROM pedal ORDER BY slug')
        .all();
      return reply({ pedals: results });
    }
  );

  server.registerTool(
    'get_section',
    {
      description:
        'Return one section of one manual by its heading anchor. Long sections are split; ' +
        'ask for the next part when metadata.next is set.',
      inputSchema: {
        pedal: z.string().describe('slug, e.g. "boss-rc-5"'),
        anchor: z.string().describe('heading id, e.g. "midi-implementation"'),
        part: z.number().int().min(1).optional(),
      },
      outputSchema: SECTION_OUT,
    },
    async ({ pedal, anchor, part }) => {
      const row = await sectionOf(db, { slug: pedal, anchor, part: part ?? 1 });
      return row ? reply(sectionPayload(row)) : fail(`No section ${pedal}#${anchor} part ${part ?? 1}.`);
    }
  );

  server.registerTool(
    'get_table',
    {
      description:
        'Page through a printed table that was too large to inline in a section — ' +
        'MIDI implementation charts and the like. Headers come back with every page.',
      inputSchema: {
        pedal: z.string(),
        anchor: z.string().describe('anchor of the section the table sits in'),
        index: z.number().int().min(1).optional().describe('when the section holds several tables'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: {
        pedal: z.string(),
        anchor: z.string(),
        caption: z.string().nullable(),
        headers: z.array(z.string()),
        rows: z.array(z.array(z.string())),
        total: z.number(),
        offset: z.number(),
        next_offset: z.number().nullable(),
        url: z.string(),
      },
    },
    async ({ pedal, anchor, index, offset, limit }) => {
      const row = await db
        .prepare(
          `SELECT t.caption, t.data FROM tbl t JOIN section s ON s.id = t.section_id
           WHERE t.slug = ?1 AND s.anchor = ?2 AND t.ord = ?3`
        )
        .bind(pedal, anchor, index ?? 1)
        .first();
      if (!row) return fail(`No table ${index ?? 1} in ${pedal}#${anchor}.`);

      const { headers, rows } = JSON.parse(row.data);
      const from = offset ?? 0;
      const take = limit ?? TABLE_LIMIT;
      return reply({
        pedal,
        anchor,
        caption: row.caption,
        headers,
        rows: rows.slice(from, from + take),
        total: rows.length,
        offset: from,
        next_offset: from + take < rows.length ? from + take : null,
        url: urlOf(pedal, anchor),
      });
    }
  );

  return server;
}

// ------------------------------------------------------------------ ingest

// Both strings are ours, so only the length is public; the comparison itself
// must not leak where a wrong token first diverges.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A load runs as many requests as CI needs to ship the rows, so it is not one
// transaction. It does not have to be: every load starts by dropping the
// tables, and a half-finished one is replaced wholesale by the next.
async function load(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!env.DB_WRITE_TOKEN || !sameToken(auth, `Bearer ${env.DB_WRITE_TOKEN}`))
    return Response.json({ error: 'unauthorized' }, { status: 401 });

  const body = await request.json();

  if (body.reset) {
    await env.DB.batch(DDL_STATEMENTS.map((s) => env.DB.prepare(s)));
    return Response.json({ ok: true, reset: true });
  }

  if (body.finish) {
    await env.DB.prepare(FTS_REBUILD).run();
    return Response.json({ ok: true, finish: true });
  }

  const columns = COLUMNS[body.table];
  if (!columns) return Response.json({ error: 'unknown table' }, { status: 400 });

  const sql = `INSERT INTO ${body.table} (${columns.join(', ')})
               VALUES (${columns.map(() => '?').join(', ')})`;
  const stmt = env.DB.prepare(sql);
  await env.DB.batch(body.rows.map((r) => stmt.bind(...r)));
  return Response.json({ ok: true, rows: body.rows.length });
}

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/load' && request.method === 'POST') return load(request, env);
    if (pathname === '/') return new Response(`MCP endpoint: ${new URL('/mcp', request.url)}\n`);
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};

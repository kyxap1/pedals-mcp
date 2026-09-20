#!/usr/bin/env node
// Turns the manuals into dist/pedals.sql: sections, tables, FTS5 rebuild.
// Pure — HTML in, one SQL file out. No network, no D1, no wrangler.
//
// Usage: node build-db.mjs [repo-root] [out.sql]

import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

export const SITE = 'https://pedals.kyxap.pro';
export const PART_CHARS = 3000; // split target, measured on render
export const BIG_TABLE_ROWS = 25; // above this, render stubs the table
export const BIG_TABLE_CHARS = 2000; // …and so does a short table with long cells
const INTRO_CHARS = 120; // below this the orphan is just the masthead wordmark
const MAX_STATEMENT = 80_000; // D1 caps statement length; batch well under it

// ---------------------------------------------------------------- markdown

function makeTurndown(slug) {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  td.remove(['script', 'style']);

  // A relative anchor is dead once the text is quoted away from its page.
  td.addRule('absoluteAnchor', {
    filter: (node) =>
      node.nodeName === 'A' && (node.getAttribute('href') || '').startsWith('#'),
    replacement: (content, node) =>
      `[${content}](${SITE}/${slug}/${node.getAttribute('href')})`,
  });

  // The picture costs tokens and says nothing; its caption or alt is the content.
  td.addRule('figure', {
    filter: 'figure',
    replacement: (_content, node) => {
      const cap = node.querySelector('figcaption')?.textContent?.trim();
      const alt = node.querySelector('img')?.getAttribute('alt')?.trim();
      const text = (cap || alt || '').replace(/\s+/g, ' ');
      return text ? `\n\n_Figure: ${text}_\n\n` : '';
    },
  });
  // Same for an image with no <figure> around it: drop the picture, keep the
  // alt. Some headings have nothing else under them.
  td.addRule('bareImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      return alt ? `_Figure: ${alt}_` : '';
    },
  });

  return td;
}

const clean = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------ tables

function directRows($, table) {
  const out = [];
  $(table)
    .children()
    .each((_, ch) => {
      const tag = (ch.tagName || '').toLowerCase();
      if (tag === 'tr') out.push({ el: ch, head: false });
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot')
        $(ch)
          .children('tr')
          .each((__, tr) => out.push({ el: tr, head: tag === 'thead' }));
    });
  return out;
}

function cellText($, cell, td) {
  const md = td.turndown($.html($(cell).contents()) || '');
  // A Markdown cell is one line: <br> and stacked <p> become " / ".
  return clean(md.replace(/\s*\n+\s*/g, ' / ')).replace(/\|/g, '\\|');
}

// The HTML table model, reduced to what a Markdown row can carry. A rowspan
// repeats its value down so every row stands alone — that is the whole point,
// since Markdown has no rowspan. A colspan leaves its continuation cells empty
// instead of duplicating a sentence across them.
export function normalizeTable($, table, td) {
  const grid = [];
  const headRows = [];
  const at = (r, c) => (grid[r] ||= [])[c];
  const put = (r, c, v) => ((grid[r] ||= [])[c] = v);

  directRows($, table).forEach(({ el, head }, r) => {
    if (head) headRows.push(r);
    let c = 0;
    $(el)
      .children('th,td')
      .each((_, cell) => {
        while (at(r, c) !== undefined) c++;
        const text = cellText($, cell, td);
        const rs = Math.max(1, parseInt($(cell).attr('rowspan') || '1', 10));
        const cs = Math.max(1, parseInt($(cell).attr('colspan') || '1', 10));
        for (let dr = 0; dr < rs; dr++)
          for (let dc = 0; dc < cs; dc++) put(r + dr, c + dc, dc === 0 ? text : '');
        c += cs;
      });
  });

  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  const full = grid.map((row) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(row[i] ?? '');
    return out;
  });

  let headers = [];
  let bodyFrom = 0;
  if (headRows.length) {
    // A multi-row thead stacks into one header line.
    headers = full[0].map((_, i) =>
      headRows
        .map((r) => full[r][i])
        .filter(Boolean)
        .join(' / ')
    );
    bodyFrom = headRows.length;
  } else if (full.length && $(directRows($, table)[0].el).children('td').length === 0) {
    headers = full[0];
    bodyFrom = 1;
  }

  const caption = clean($(table).children('caption').text() || '');
  return { headers, rows: full.slice(bodyFrom), caption };
}

// A nested table cannot stay a table inside a Markdown cell.
function flattenNested($, table, td) {
  const { rows } = normalizeTable($, table, td);
  return rows
    .map((r) => {
      const cells = r.filter((c) => c !== '');
      if (!cells.length) return '';
      const [first, ...rest] = cells;
      return rest.length ? `${first}: ${rest.join(' / ')}` : first;
    })
    .filter(Boolean)
    .join('; ');
}

export const isBigTable = (t) =>
  t.rows.length > BIG_TABLE_ROWS || tableToMarkdown(t).length > BIG_TABLE_CHARS;

export function tableToMarkdown({ headers, rows, caption }) {
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const pad = (r) => Array.from({ length: width }, (_, i) => r[i] ?? '');
  const line = (r) => `| ${pad(r).join(' | ')} |`;
  const head = headers.length ? headers : Array.from({ length: width }, () => '');
  const out = [line(head), `|${' --- |'.repeat(width)}`, ...rows.map(line)];
  return (caption ? `**${caption}**\n\n` : '') + out.join('\n');
}

function tableStub(t, slug, anchor, ord) {
  const cols = Math.max(t.headers.length, ...t.rows.map((r) => r.length), 1);
  const head = t.headers.filter(Boolean).join(' | ');
  return [
    `_Table${t.caption ? ` "${t.caption}"` : ''}: ${t.rows.length} rows × ${cols} columns`,
    head ? ` (${head})` : '',
    `. Too large to inline — page it with get_table(pedal="${slug}", anchor="${anchor}"`,
    ord ? `, index=${ord}` : '',
    `)._`,
  ].join('');
}

// ---------------------------------------------------------------- sections

// Headings that carry an id are the cut points. They are not siblings — the
// pages nest them in <section> and <div class="topic"> — so a container is
// recursed into when it holds one and appended whole when it does not.
export function sectionsOf($, main) {
  const sections = [];
  let cur = null;
  let orphan = '';
  let orphanText = '';
  const HEADINGS = 'h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]';
  const isBoundary = (el) =>
    /^h[1-6]$/.test((el.tagName || '').toLowerCase()) && $(el).attr('id');

  const walk = (parent) => {
    $(parent)
      .contents()
      .each((_, node) => {
        if (node.type === 'text') {
          if (cur) cur.html += $.html(node);
          else {
            orphan += $.html(node);
            orphanText += $(node).text();
          }
          return;
        }
        if (node.type !== 'tag') return;
        if (isBoundary(node)) {
          cur = {
            anchor: $(node).attr('id'),
            title: clean($(node).text()),
            level: Number((node.tagName || 'h2')[1]),
            html: '',
          };
          sections.push(cur);
        } else if ($(node).find(HEADINGS).length) {
          walk(node);
        } else if (cur) {
          cur.html += $.html(node);
        } else {
          orphan += $.html(node);
          orphanText += $(node).text();
        }
      });
  };
  walk(main);
  return { sections, orphan, orphanText: clean(orphanText) };
}

// Turndown renders a whole list as one block, so a long one busts the budget
// on its own. Unlike a table it cuts safely, at item boundaries.
function splitList(block) {
  if (block.length <= PART_CHARS) return [block];
  const items = [];
  for (const line of block.split('\n')) {
    if (!items.length || /^\s{0,3}(?:[-*+]|\d+\.)\s/.test(line)) items.push(line);
    else items[items.length - 1] += `\n${line}`;
  }
  if (items.length < 2) return [block];
  const out = [];
  let cur = [];
  let size = 0;
  for (const it of items) {
    if (cur.length && size + it.length > PART_CHARS) {
      out.push(cur.join('\n'));
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += it.length + 1;
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

// Split on block boundaries only, and a table is a single block — a table cut
// in half leaves a headerless fragment, which is worse than a long reply.
function splitParts(blocks) {
  const parts = [];
  let cur = [];
  let size = 0;
  for (const b of blocks) {
    if (cur.length && size + b.render.length > PART_CHARS) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += b.render.length + 2;
  }
  if (cur.length) parts.push(cur);
  return parts.length ? parts : [[]];
}

// -------------------------------------------------------------------- page

export function parsePage(html, slug) {
  const $ = cheerio.load(html);
  const td = makeTurndown(slug);
  const main = $('#main-doc');
  main.find('nav, #toc-mobile, script, style').remove();

  const name = clean($('title').text()).replace(/\s*Pedal Manual\s*$/i, '');
  const { sections, orphan, orphanText } = sectionsOf($, main);

  // Prose ahead of the first anchored heading has no section to belong to.
  // Above the masthead wordmark it is real content — provenance, or the
  // safety notice — and dropping it would lose it silently.
  if (orphanText.length > INTRO_CHARS)
    sections.unshift({ anchor: '', title: name, level: 1, html: orphan });

  const tables = [];

  for (const s of sections) {
    const $s = cheerio.load(`<div id="sec">${s.html}</div>`);
    const root = $s('#sec');

    // Innermost first, so an outer table reads its nested ones as plain text.
    const nested = root.find('table table').toArray().reverse();
    for (const t of nested) $s(t).replaceWith(`<span>${escapeHtml(flattenNested($s, t, td))}</span>`);

    let ord = 0;
    root.find('table').each((_, t) => {
      const data = normalizeTable($s, t, td);
      data.slug = slug;
      data.anchor = s.anchor;
      data.ord = ++ord;
      data.idx = tables.length;
      tables.push(data);
      $s(t).replaceWith(`<p>@@TBL:${data.idx}@@</p>`);
    });
    s.tablesInSection = ord;
    s.md = td.turndown(root.html() || '');
  }

  // A chapter heading whose prose lives entirely in its sub-headings would
  // otherwise be a fetchable anchor that answers with nothing.
  sections.forEach((s, i) => {
    if (s.md.trim()) return;
    const kids = [];
    for (let j = i + 1; j < sections.length && sections[j].level > s.level; j++)
      kids.push(sections[j]);
    if (!kids.length) return;
    const top = Math.min(...kids.map((k) => k.level));
    s.md = ['This chapter is covered by its sections:', '']
      .concat(
        kids
          .filter((k) => k.level === top)
          .map((k) => `- [${k.title}](${SITE}/${slug}/#${k.anchor})`)
      )
      .join('\n');
  });

  // A heading with no prose, no table and no sub-sections — the print has a
  // few — is nothing to fetch and only noise in the index.
  return {
    slug,
    name,
    sections: sections.filter((s) => s.md.trim()),
    tables,
    orphan: orphanText,
  };
}

export function buildRows(page) {
  const sectionRows = [];
  const tableRows = [];
  let ord = 0;

  for (const s of page.sections) {
    const blocks = s.md
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean)
      .flatMap((b) => {
        // A table inside a numbered step shares its block, so substitution is
        // by occurrence — a placeholder left in place would be served as text.
        const ids = [...b.matchAll(/@@TBL:(\d+)@@/g)].map((m) => Number(m[1]));
        if (!ids.length) return splitList(b).map((chunk) => ({ body: chunk, render: chunk }));
        const subst = (pick) =>
          b.replace(/@@TBL:(\d+)@@/g, (_, n) => pick(page.tables[Number(n)]));
        return {
          body: subst(tableToMarkdown),
          render: subst((t) =>
            isBigTable(t)
              ? tableStub(t, page.slug, s.anchor, s.tablesInSection > 1 ? t.ord : 0)
              : tableToMarkdown(t)
          ),
          tables: ids.map((i) => page.tables[i]),
        };
      });

    const parts = splitParts(blocks);
    parts.forEach((part, i) => {
      const id = sectionRows.length + 1;
      const body = part.map((b) => b.body).join('\n\n');
      const render = part.map((b) => b.render).join('\n\n');
      sectionRows.push({
        id,
        slug: page.slug,
        anchor: s.anchor,
        title: s.title,
        level: s.level,
        ord: ++ord,
        part: i + 1,
        chars: render.length,
        body,
        render,
      });
      for (const b of part)
        for (const t of b.tables || [])
          tableRows.push({
            slug: page.slug,
            section_id: id,
            ord: t.ord,
            caption: t.caption,
            data: JSON.stringify({ headers: t.headers, rows: t.rows }),
          });
    });
  }
  return { sectionRows, tableRows };
}

// --------------------------------------------------------------------- sql

const q = (v) =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

const DDL = `
DROP TABLE IF EXISTS section_fts;
DROP TABLE IF EXISTS tbl;
DROP TABLE IF EXISTS section;
DROP TABLE IF EXISTS pedal;

CREATE TABLE pedal (
  slug  TEXT PRIMARY KEY,
  name  TEXT,
  brand TEXT, model TEXT, type TEXT,
  url   TEXT,
  specs TEXT
);

CREATE TABLE section (
  id     INTEGER PRIMARY KEY,
  slug   TEXT, anchor TEXT,
  title  TEXT, level INT, ord INT,
  part   INT DEFAULT 1,
  chars  INT,
  body   TEXT,
  render TEXT
);

CREATE TABLE tbl (
  id INTEGER PRIMARY KEY,
  slug TEXT, section_id INT, ord INT,
  caption TEXT,
  data TEXT
);

CREATE INDEX section_slug ON section(slug, anchor, part);
CREATE INDEX tbl_section ON tbl(section_id);

CREATE VIRTUAL TABLE section_fts USING fts5(
  title, body, content='section', content_rowid='id'
);
`.trim();

function batched(table, columns, tuples) {
  const out = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    if (!buf.length) return;
    out.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${buf.join(',\n')};`);
    buf = [];
    size = 0;
  };
  for (const t of tuples) {
    if (buf.length >= 500 || size + t.length > MAX_STATEMENT) flush();
    buf.push(t);
    size += t.length;
  }
  flush();
  return out;
}

export function toSql(pages) {
  const out = [DDL];
  const pedals = [];
  const sections = [];
  const tables = [];
  let sectionOffset = 0;

  for (const page of pages) {
    const { sectionRows, tableRows } = buildRows(page);
    pedals.push(
      `(${[page.slug, page.name, null, null, null, `${SITE}/${page.slug}/`, null]
        .map(q)
        .join(', ')})`
    );
    for (const s of sectionRows)
      sections.push(
        `(${[
          s.id + sectionOffset,
          q(s.slug),
          q(s.anchor),
          q(s.title),
          s.level,
          s.ord,
          s.part,
          s.chars,
          q(s.body),
          q(s.render),
        ].join(', ')})`
      );
    for (const t of tableRows)
      tables.push(
        `(${[q(t.slug), t.section_id + sectionOffset, t.ord, q(t.caption), q(t.data)].join(', ')})`
      );
    sectionOffset += sectionRows.length;
  }

  out.push(...batched('pedal', ['slug', 'name', 'brand', 'model', 'type', 'url', 'specs'], pedals));
  out.push(
    ...batched(
      'section',
      ['id', 'slug', 'anchor', 'title', 'level', 'ord', 'part', 'chars', 'body', 'render'],
      sections
    )
  );
  out.push(...batched('tbl', ['slug', 'section_id', 'ord', 'caption', 'data'], tables));
  // External-content FTS stores no copy of the body and does not fill itself.
  out.push(`INSERT INTO section_fts(section_fts) VALUES('rebuild');`);
  return out.join('\n\n') + '\n';
}

// -------------------------------------------------------------------- main

async function findManuals(root) {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const file = join(root, e.name, 'index.html');
    try {
      await stat(file);
      out.push({ slug: e.name, file });
    } catch {
      /* not a manual directory */
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(process.argv[2] || join(here, '..'));
  const outFile = resolve(process.argv[3] || join(here, 'dist', 'pedals.sql'));

  const manuals = await findManuals(root);
  const pages = [];
  for (const m of manuals) pages.push(parsePage(await readFile(m.file, 'utf8'), m.slug));

  const sql = toSql(pages);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, sql);

  let sections = 0;
  let tables = 0;
  let biggest = { chars: 0 };
  for (const p of pages) {
    const r = buildRows(p);
    sections += r.sectionRows.length;
    tables += r.tableRows.length;
    for (const s of r.sectionRows) if (s.chars > biggest.chars) biggest = { ...s, slug: p.slug };
    // Content before the first heading with an id belongs to no section.
    if (p.orphan.length > 400)
      console.warn(`warn  ${p.slug}: ${p.orphan.length} chars outside any anchored section`);
  }
  console.log(
    `${pages.length} manuals · ${sections} sections · ${tables} tables · ` +
      `${(sql.length / 1024).toFixed(0)} KB SQL`
  );
  console.log(
    `largest render: ${biggest.chars} chars (${biggest.slug}#${biggest.anchor} part ${biggest.part})`
  );
  console.log(`wrote ${outFile}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();

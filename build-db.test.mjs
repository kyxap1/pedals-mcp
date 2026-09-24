// Runs against the real manuals rather than copies of them: a checked-in
// fixture of a page that lives two directories up would rot silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePage, buildRows, PART_CHARS } from './build-db.mjs';

// The manuals live in their own repository, checked out beside this one in CI.
const ROOT = process.env.PEDALS_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', 'pedals');

// One manual per failure mode the builder exists to survive.
const FIXTURES = {
  'source-audio-collider': 'rowspan enumerations',
  'boss-rc-5': 'rowspan, colspan, nested .mini tables',
  'source-audio-eq2': 'the 96-row table that must be stubbed',
  'disaster-area-designs-dpc-micro-ns': 'th scope="row" label columns',
  'boss-ge-7': 'the trivial case',
};

const pages = {};
for (const slug of Object.keys(FIXTURES))
  pages[slug] = parsePage(await readFile(join(ROOT, slug, 'index.html'), 'utf8'), slug);

const distinctiveTerm = (row) =>
  row
    .flatMap((c) => c.split(/[^\p{L}\p{N}#]+/u))
    .filter((w) => w.length >= 4 && /\p{L}/u.test(w))
    .sort((a, b) => b.length - a.length)[0];

for (const [slug, why] of Object.entries(FIXTURES)) {
  const page = pages[slug];

  test(`${slug}: every row is as wide as its header (${why})`, () => {
    for (const t of page.tables) {
      const width = t.headers.length || t.rows[0]?.length || 0;
      for (const [i, row] of t.rows.entries())
        assert.equal(row.length, width, `${slug}#${t.anchor} table ${t.ord} row ${i}`);
    }
  });

  test(`${slug}: no render exceeds the budget`, () => {
    for (const s of buildRows(page).sectionRows)
      assert.ok(
        s.chars <= PART_CHARS,
        `${slug}#${s.anchor} part ${s.part} is ${s.chars} chars`
      );
  });

  test(`${slug}: every table is findable by a term from its last row`, () => {
    const bodies = buildRows(page).sectionRows.map((s) => s.body);
    for (const t of page.tables) {
      const last = t.rows.at(-1);
      if (!last) continue;
      const term = distinctiveTerm(last);
      if (!term) continue;
      assert.ok(
        bodies.some((b) => b.includes(term)),
        `${slug}#${t.anchor} table ${t.ord}: "${term}" reached no indexed body`
      );
    }
  });

  test(`${slug}: every table resolves to a section`, () => {
    const { sectionRows, tableRows } = buildRows(page);
    const anchors = new Set(sectionRows.map((s) => s.anchor));
    assert.equal(tableRows.length, page.tables.length);
    for (const t of tableRows) assert.ok(anchors.has(t.anchor), `orphan table in ${slug}`);
  });

  test(`${slug}: anchors survive leaving the page`, () => {
    for (const s of buildRows(page).sectionRows)
      assert.ok(!s.body.includes(']('.concat('#')), `${slug}#${s.anchor} kept a relative link`);
  });
}

// The defects that motivated the design, pinned to the rows that exposed them.

test('dpc.micro: a th scope="row" label column survives', () => {
  const t = pages['disaster-area-designs-dpc-micro-ns'].tables.find((x) =>
    x.headers.includes('Chain ID')
  );
  assert.ok(t, 'Chain ID table not found');
  assert.deepEqual(t.headers, ['Chain ID', '0 (RED)', '1 (GRN)', '2 (BLU)', '3 (ORG)']);
  assert.deepEqual(t.rows[0], ['Loop A CC', '50', '53', '56', '59']);
});

test('boss-rc-5: a rowspan label repeats down and <br> stays in the cell', () => {
  const t = pages['boss-rc-5'].tables.find((x) =>
    x.rows.some((r) => r[0].startsWith('CC#80 FUNC'))
  );
  assert.ok(t, 'CC FUNC table not found');
  const label = t.rows.find((r) => r[0].startsWith('CC#80 FUNC'))[0];
  assert.match(label, /CC#80 FUNC \/ CC#81 FUNC/, '<br> did not become a separator');
  assert.ok(
    t.rows.filter((r) => r[0] === label).length > 30,
    'rowspan=41 did not carry the label down'
  );
});

test('boss-rc-5: a colspan blanks its continuation instead of duplicating', () => {
  const t = pages['boss-rc-5'].tables.find((x) =>
    x.rows.some((r) => r[0].startsWith('CC#80 FUNC'))
  );
  const lead = t.rows.find((r) => r[1].startsWith('This sets the functions'));
  assert.equal(lead.at(-1), '', 'colspan duplicated a sentence across columns');
});

test('boss-rc-5: a nested .mini table collapses into its cell', () => {
  const flat = pages['boss-rc-5'].tables
    .flatMap((t) => t.rows.flat())
    .find((c) => c.includes('Lit blue'));
  assert.ok(flat, 'nested .mini table vanished');
  assert.match(flat, /Lit blue: No phrase; Lit red: Recording/);
});

test('source-audio-eq2: the 96-row table is whole in body and stubbed in render', () => {
  const page = pages['source-audio-eq2'];
  const big = page.tables.find((t) => t.rows.length > 90);
  assert.ok(big, 'the 96-row table is gone');
  const { sectionRows } = buildRows(page);
  const row = sectionRows.find((s) => s.anchor === big.anchor);
  assert.ok(row.body.length > 3000, 'body lost the full table');
  assert.match(row.render, /get_table\(/, 'render did not stub the table');
});

// Shared by the builder, which writes a local SQL dump, and by the Worker,
// which applies the same schema to D1 before a load.

// Where the manuals are published; every citation a tool returns points here.
export const SITE = 'https://pedals.kyxap.pro';

const TABLES = `
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
`.trim();

const INDEXES = `
CREATE INDEX section_slug ON section(slug, anchor, part);
CREATE INDEX tbl_section ON tbl(section_id);
`.trim();

const FTS = `
CREATE VIRTUAL TABLE section_fts USING fts5(
  title, body, content='section', content_rowid='id'
);
`.trim();

const DROPS = `
DROP TABLE IF EXISTS section_fts;
DROP TABLE IF EXISTS tbl;
DROP TABLE IF EXISTS section;
DROP TABLE IF EXISTS pedal;
`.trim();

export const DDL = [DROPS, TABLES, INDEXES, FTS].join('\n\n');

// D1 takes one statement per prepare() call; nothing above has a ';' inside.
const statements = (sql) =>
  sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

const LIVE = ['pedal', 'section', 'tbl'];

// A load fills `<table>_new` while the live tables keep serving.
export const STAGE_STATEMENTS = [
  ...LIVE.map((t) => `DROP TABLE IF EXISTS ${t}_new`),
  ...statements(TABLES.replace(/CREATE TABLE (\w+)/g, 'CREATE TABLE $1_new')),
];

// Run as one batch, which D1 executes as a transaction: readers see the old
// tables or the new ones. The FTS table is rebuilt here rather than renamed
// because it names its content table.
export const SWAP_STATEMENTS = [
  ...statements(DROPS),
  ...LIVE.map((t) => `ALTER TABLE ${t}_new RENAME TO ${t}`),
  ...statements(INDEXES),
  ...statements(FTS),
  `INSERT INTO section_fts(section_fts) VALUES('rebuild')`,
];

export const COLUMNS = {
  pedal: ['slug', 'name', 'brand', 'model', 'type', 'url', 'specs'],
  section: ['id', 'slug', 'anchor', 'title', 'level', 'ord', 'part', 'chars', 'body', 'render'],
  tbl: ['slug', 'section_id', 'ord', 'caption', 'data'],
};

// External-content FTS stores no copy of the body and does not fill itself.
export const FTS_REBUILD = `INSERT INTO section_fts(section_fts) VALUES('rebuild')`;

// Shared by the builder, which writes a local SQL dump, and by the Worker,
// which applies the same schema to D1 before a load.

// Where the manuals are published; every citation a tool returns points here.
export const SITE = 'https://pedals.kyxap.pro';

export const DDL = `
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

// The order the loader applies them in; a statement per array entry, because
// D1 takes one statement per prepare() call.
export const DDL_STATEMENTS = DDL.split(';\n')
  .map((s) => s.trim())
  .filter(Boolean);

export const COLUMNS = {
  pedal: ['slug', 'name', 'brand', 'model', 'type', 'url', 'specs'],
  section: ['id', 'slug', 'anchor', 'title', 'level', 'ord', 'part', 'chars', 'body', 'render'],
  tbl: ['slug', 'section_id', 'ord', 'caption', 'data'],
};

// External-content FTS stores no copy of the body and does not fill itself.
export const FTS_REBUILD = `INSERT INTO section_fts(section_fts) VALUES('rebuild')`;

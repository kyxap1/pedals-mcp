// Shared by the builder, which writes a local SQL dump, and by the Worker,
// which applies the same schema to D1 before a load.

// Where the manuals are published; every citation a tool returns points here.
export const SITE = 'https://pedals.kyxap.pro';

const TABLES = [
  `CREATE TABLE pedal (
  slug  TEXT PRIMARY KEY,
  name  TEXT,
  brand TEXT, model TEXT, type TEXT,
  url   TEXT,
  specs TEXT,
  hash  TEXT
)`,
  `CREATE TABLE section (
  id     INTEGER PRIMARY KEY,
  slug   TEXT, anchor TEXT,
  title  TEXT, level INT, ord INT,
  part   INT DEFAULT 1,
  chars  INT,
  body   TEXT,
  render TEXT
)`,
  `CREATE TABLE tbl (
  id INTEGER PRIMARY KEY,
  slug TEXT, anchor TEXT, ord INT,
  caption TEXT,
  data TEXT
)`,
  // The DDL the tables were created with; a Worker shipping different DDL
  // recreates them.
  `CREATE TABLE meta (ddl TEXT)`,
];

const INDEXES = [
  `CREATE INDEX section_slug ON section(slug, anchor, part)`,
  `CREATE INDEX tbl_slug ON tbl(slug, anchor, ord)`,
];

const FTS = `CREATE VIRTUAL TABLE section_fts USING fts5(
  title, body, content='section', content_rowid='id'
)`;

// External-content FTS stores no copy of the body and does not fill itself;
// the triggers keep it in step row by row, so a load touches only its pedal.
const TRIGGERS = [
  `CREATE TRIGGER section_ai AFTER INSERT ON section BEGIN
  INSERT INTO section_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END`,
  `CREATE TRIGGER section_ad AFTER DELETE ON section BEGIN
  INSERT INTO section_fts(section_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END`,
];

const DROPS = ['section_fts', 'tbl', 'section', 'pedal', 'meta'].map(
  (t) => `DROP TABLE IF EXISTS ${t}`
);

// One statement per entry: D1 takes one per prepare() call.
export const DDL_STATEMENTS = [...DROPS, ...TABLES, ...INDEXES, FTS, ...TRIGGERS];

export const DDL = DDL_STATEMENTS.map((s) => `${s};`).join('\n\n');

// A pedal's rows land in one transaction, so the pedal row is the whole list.
export const HASHES_SQL = `SELECT slug, hash FROM pedal`;

export const COLUMNS = {
  pedal: ['slug', 'name', 'brand', 'model', 'type', 'url', 'specs', 'hash'],
  section: ['slug', 'anchor', 'title', 'level', 'ord', 'part', 'chars', 'body', 'render'],
  tbl: ['slug', 'anchor', 'ord', 'caption', 'data'],
};


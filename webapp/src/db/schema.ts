// Schema DDL. Kept as single exported arrays of statements so migrations can
// `exec()` them in order. `PRAGMA user_version` tracks migration state.
//
// The migration ladder lives in `applyMigrations` (sqlite.ts):
//   - 0 → 1: run INITIAL_SCHEMA_V1
//   - 1 → 2: run MIGRATION_V2
// A fresh DB applies INITIAL_SCHEMA (= v1 statements + v2 deltas) in a single
// transaction so it lands at user_version=2 directly, skipping the ladder.
//
// Later steps are code migrations in sqlite.ts because they can't be expressed
// as idempotent statement arrays: v3→v4 moves tweet_embeddings to its own db
// (migrateEmbeddingsOut), and v4→v5 ALTERs tweets (+ article columns) and
// rebuilds tweets_fts with an article_title column (migrateToV5).

export const SCHEMA_VERSION = 5;

// v1 schema statements without their trailing PRAGMA. Reused by INITIAL_SCHEMA
// (fresh DB) and INITIAL_SCHEMA_V1 (the migration test fixture).
const V1_STATEMENTS: string[] = [
  `PRAGMA foreign_keys = ON;`,
  `PRAGMA journal_mode = MEMORY;`,

  `CREATE TABLE IF NOT EXISTS tweets (
    id TEXT PRIMARY KEY,
    author_handle TEXT NOT NULL,
    author_display_name TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    liked_at INTEGER,
    like_count INTEGER DEFAULT 0,
    retweet_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    is_thread INTEGER DEFAULT 0,
    thread_id TEXT,
    image_urls TEXT,
    source_file TEXT,
    imported_at INTEGER NOT NULL,
    is_favorite INTEGER DEFAULT 0,
    user_notes TEXT,
    has_video INTEGER DEFAULT 0,
    link TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT,
    source TEXT NOT NULL CHECK (source IN ('classifier','manual')),
    created_at INTEGER NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS tweet_categories (
    tweet_id TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    confidence REAL,
    assigned_at INTEGER NOT NULL,
    assigned_by TEXT NOT NULL CHECK (assigned_by IN ('classifier','user')),
    PRIMARY KEY (tweet_id, category_id),
    FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS tweet_tags (
    tweet_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (tweet_id, tag_id),
    FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('ticker','hashtag','mention')),
    value TEXT NOT NULL,
    UNIQUE(type, value)
  );`,

  `CREATE TABLE IF NOT EXISTS tweet_entities (
    tweet_id TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    PRIMARY KEY (tweet_id, entity_id),
    FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  );`,

  `CREATE INDEX IF NOT EXISTS idx_tweets_created_at ON tweets(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_liked_at ON tweets(liked_at);`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_author ON tweets(author_handle);`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_like_count ON tweets(like_count);`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_retweet_count ON tweets(retweet_count);`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_is_thread ON tweets(is_thread);`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_is_favorite ON tweets(is_favorite);`,
  `CREATE INDEX IF NOT EXISTS idx_tweet_categories_category ON tweet_categories(category_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tweet_categories_tweet ON tweet_categories(tweet_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tweet_entities_entity ON tweet_entities(entity_id);`,
  `CREATE INDEX IF NOT EXISTS idx_tweet_entities_tweet ON tweet_entities(tweet_id);`,

  // sql.js 1.14.1 ships SQLite with FTS3/FTS4 only (no FTS5), so we use an
  // external-content FTS4 table backed by `tweets`. The columns must match
  // the columns we want to search on the parent table by name.
  `CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts4(
    content,
    author_handle,
    author_display_name,
    content="tweets"
  );`,

  // External-content FTS4 needs explicit triggers to stay in sync. Deletes
  // and updates run BEFORE so `old.rowid` still resolves to the row being
  // removed; inserts run AFTER so the row is materialized.
  `CREATE TRIGGER IF NOT EXISTS tweets_bd BEFORE DELETE ON tweets BEGIN
    DELETE FROM tweets_fts WHERE docid = old.rowid;
  END;`,

  `CREATE TRIGGER IF NOT EXISTS tweets_bu BEFORE UPDATE ON tweets BEGIN
    DELETE FROM tweets_fts WHERE docid = old.rowid;
  END;`,

  `CREATE TRIGGER IF NOT EXISTS tweets_au AFTER UPDATE ON tweets BEGIN
    INSERT INTO tweets_fts(docid, content, author_handle, author_display_name)
    VALUES (new.rowid, new.content, new.author_handle, new.author_display_name);
  END;`,

  `CREATE TRIGGER IF NOT EXISTS tweets_ai AFTER INSERT ON tweets BEGIN
    INSERT INTO tweets_fts(docid, content, author_handle, author_display_name)
    VALUES (new.rowid, new.content, new.author_handle, new.author_display_name);
  END;`,
];

// The exact set of statements that landed in `PRAGMA user_version = 1`.
// Exposed so the migration test can construct an authentic v1 fixture.
export const INITIAL_SCHEMA_V1: string[] = [
  ...V1_STATEMENTS,
  `PRAGMA user_version = 1;`,
];

// v2 delta - embeddings, enrichments, and the chat session/message tables
// that back the chat surface. `model` participates in the embeddings primary
// key and the enrichments UNIQUE so swapping to a newer Voyage / Vision model
// adds rows alongside the old ones rather than overwriting.
export const MIGRATION_V2: string[] = [
  `CREATE TABLE IF NOT EXISTS tweet_embeddings (
    tweet_id   TEXT NOT NULL,
    model      TEXT NOT NULL,
    dim        INTEGER NOT NULL,
    dtype      TEXT NOT NULL CHECK (dtype IN ('float32','int8')),
    scale      REAL,
    offset     REAL,
    vector     BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tweet_id, model),
    FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_model ON tweet_embeddings(model);`,

  `CREATE TABLE IF NOT EXISTS enrichments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id      TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('url_content','image_description')),
    source_ref    TEXT NOT NULL,
    content       TEXT NOT NULL,
    model         TEXT,
    metadata_json TEXT,
    created_at    INTEGER NOT NULL,
    UNIQUE(tweet_id, type, source_ref, model),
    FOREIGN KEY (tweet_id) REFERENCES tweets(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS idx_enrichments_tweet ON enrichments(tweet_id);`,
  `CREATE INDEX IF NOT EXISTS idx_enrichments_type  ON enrichments(type);`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id           TEXT PRIMARY KEY,
    title        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    model        TEXT,
    filters_json TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content             TEXT NOT NULL,
    citations_json      TEXT,
    retrieved_ids_json  TEXT,
    tool_calls_json     TEXT,
    created_at          INTEGER NOT NULL,
    token_input         INTEGER,
    token_output        INTEGER,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);`,

  `PRAGMA user_version = 2;`,
];

// v3 delta - cross-device sync scaffolding (active in cloud / proxy mode only).
//
// `sync_outbox` is an append-only log of local user mutations (favorite, notes,
// manual category assign/unassign). The sync client pushes these to the
// D1-backed `/api/sync` endpoint, where they're merged last-write-wins, then
// prunes the pushed rows. `sync_state` is a tiny key/value bag holding the
// per-device id and the pull cursor (`last_pulled_at`, unix ms). Neither table
// touches the existing tweet/category data, so the migration is purely additive.
export const MIGRATION_V3: string[] = [
  `CREATE TABLE IF NOT EXISTS sync_outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    value      TEXT,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_sync_outbox_id ON sync_outbox(id);`,

  `CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );`,

  `PRAGMA user_version = 3;`,
];

// Fresh-DB schema. Concatenates v1 statements with the v2 + v3 deltas so a
// brand-new snapshot lands at user_version=3 in one BEGIN/COMMIT. The
// intermediate `PRAGMA user_version = 2` is harmless - the final pragma wins.
// (The v3→v4 step - moving tweet_embeddings to its own DB - happens in code in
// sqlite.ts because it spans two databases; see migrateEmbeddingsOut.)
export const INITIAL_SCHEMA: string[] = [
  ...V1_STATEMENTS,
  ...MIGRATION_V2,
  ...MIGRATION_V3,
];

// v5 delta - X long-form article support. `is_article` is tri-state:
// NULL = unknown (row predates extension v1.1 / article-aware capture),
// 0 = known non-article, 1 = known article. `article_title` holds the article
// card's title text when the scrape exposed it. The FTS table gains
// article_title as a fourth indexed column so title text is searchable even
// though article posts have empty `content`. The ALTERs and the FTS rebuild
// are NOT idempotent, so this step is applied by the guarded `migrateToV5`
// code migration in sqlite.ts; these constants keep the FTS DDL in one place.
export const FTS_CREATE_V5 = `CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts4(
  content,
  author_handle,
  author_display_name,
  article_title,
  content="tweets"
);`;

export const FTS_TRIGGERS_V5: string[] = [
  `CREATE TRIGGER IF NOT EXISTS tweets_bd BEFORE DELETE ON tweets BEGIN
    DELETE FROM tweets_fts WHERE docid = old.rowid;
  END;`,

  `CREATE TRIGGER IF NOT EXISTS tweets_bu BEFORE UPDATE ON tweets BEGIN
    DELETE FROM tweets_fts WHERE docid = old.rowid;
  END;`,

  `CREATE TRIGGER IF NOT EXISTS tweets_au AFTER UPDATE ON tweets BEGIN
    INSERT INTO tweets_fts(docid, content, author_handle, author_display_name, article_title)
    VALUES (new.rowid, new.content, new.author_handle, new.author_display_name, new.article_title);
  END;`,

  `CREATE TRIGGER IF NOT EXISTS tweets_ai AFTER INSERT ON tweets BEGIN
    INSERT INTO tweets_fts(docid, content, author_handle, author_display_name, article_title)
    VALUES (new.rowid, new.content, new.author_handle, new.author_display_name, new.article_title);
  END;`,
];

// Schema for the SEPARATE embeddings database (embDb). tweet_embeddings is large
// (tens of MB of int8 vectors) and immutable after import, yet it lived in the main
// DB and got re-serialized on every favorite/notes mutation. We keep it in its
// own sql.js database, snapshotted to its own IndexedDB key only on import, so
// the per-mutation snapshot no longer rewrites it. No FK to tweets here (they're
// in a different database); a dangling embedding is harmless - retrieval ignores
// vectors whose tweet isn't in the FTS candidate set.
export const EMBEDDINGS_SCHEMA: string[] = [
  `PRAGMA journal_mode = MEMORY;`,
  `CREATE TABLE IF NOT EXISTS tweet_embeddings (
    tweet_id   TEXT NOT NULL,
    model      TEXT NOT NULL,
    dim        INTEGER NOT NULL,
    dtype      TEXT NOT NULL CHECK (dtype IN ('float32','int8')),
    scale      REAL,
    offset     REAL,
    vector     BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tweet_id, model)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_model ON tweet_embeddings(model);`,
];

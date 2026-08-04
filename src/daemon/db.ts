import Database from 'better-sqlite3';
import { paths } from './paths.js';

// GlasHaus rules: WAL, forward-only idempotent migrations gated on
// user_version, fresh DB created complete on first touch.

const MIGRATIONS: string[] = [
  // v1 — Phase 0 core
  `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    title TEXT,
    automaton TEXT NOT NULL DEFAULT 'chat',
    project TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL DEFAULT 'live',
    tokens_in INTEGER,
    tokens_out INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    session_id INTEGER,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  `,
  // v2 — Phase 1: the memory transplant. Facts (tier 1 core flag + tier 2
  // deep store), episodes (folding), FTS everywhere (AFTER UPDATE OF —
  // narrow triggers, the Hermes lesson), soft-delete only.
  `
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    scope TEXT NOT NULL DEFAULT 'global',
    category TEXT NOT NULL DEFAULT 'general',
    content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5,
    salience REAL,
    core INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'capture',
    source_session INTEGER,
    embedding BLOB
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, content='facts', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE OF content ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    session_id INTEGER,
    started_at TEXT,
    ended_at TEXT,
    summary TEXT NOT NULL,
    salience REAL,
    first_message_id INTEGER,
    last_message_id INTEGER,
    embedding BLOB
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(summary, content='episodes', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
    INSERT INTO episodes_fts(rowid, summary) VALUES (new.id, new.summary);
  END;

  ALTER TABLE messages ADD COLUMN summarized INTEGER NOT NULL DEFAULT 0;
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages;
  `,
];

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(paths.db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
  }
  return db;
}

/** Append-only audit line. Detail is JSON; never updated, never deleted. */
export function receipt(kind: string, detail: Record<string, unknown>, sessionId?: number): void {
  getDb()
    .prepare('INSERT INTO receipts (session_id, kind, detail) VALUES (?, ?, ?)')
    .run(sessionId ?? null, kind, JSON.stringify(detail));
}

export function createSession(automaton = 'chat'): number {
  return Number(
    getDb().prepare('INSERT INTO sessions (automaton) VALUES (?)').run(automaton).lastInsertRowid,
  );
}

export function saveMessage(
  sessionId: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  tokens?: { in?: number; out?: number },
): number {
  const id = Number(
    getDb()
      .prepare('INSERT INTO messages (session_id, role, content, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, role, content, tokens?.in ?? null, tokens?.out ?? null).lastInsertRowid,
  );
  // First user line names the session until something smarter (Phase 1) does.
  if (role === 'user') {
    getDb()
      .prepare("UPDATE sessions SET title = COALESCE(title, ?) WHERE id = ?")
      .run(content.slice(0, 64), sessionId);
  }
  return id;
}

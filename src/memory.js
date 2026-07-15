// src/memory.js — persistent cross-session memory backed by node:sqlite (built-in Node 22+)
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_DB_PATH } from './config.js';
import { printMemory } from './ui.js';

let db;

function getDB() {
  if (db) return db;
  db = new DatabaseSync(MEMORY_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  initSchema(db);
  return db;
}

function initSchema(db) {
  // Use separate exec calls — node:sqlite can be strict about multi-statement strings
  db.exec(`CREATE TABLE IF NOT EXISTS memories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    tags      TEXT DEFAULT '',
    project   TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project    TEXT DEFAULT '',
    started_at TEXT DEFAULT (datetime('now')),
    ended_at   TEXT,
    summary    TEXT DEFAULT '',
    tokens_in  INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS session_turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         TEXT DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    language    TEXT DEFAULT '',
    framework   TEXT DEFAULT '',
    learned_at  TEXT DEFAULT (datetime('now')),
    summary     TEXT DEFAULT ''
  )`);

  // Simple text-search index
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project)`);
}

// ── Memory CRUD ───────────────────────────────────────────────────────────────

export function remember(key, value, tags = [], project = '') {
  const db = getDB();
  const existing = db.prepare('SELECT id FROM memories WHERE key = ?').get(key);
  if (existing) {
    db.prepare(`UPDATE memories SET value=?, tags=?, project=?, updated_at=datetime('now') WHERE id=?`)
      .run(value, tags.join(','), project, existing.id);
    printMemory(`Updated: ${key}`);
  } else {
    db.prepare('INSERT INTO memories (key, value, tags, project) VALUES (?,?,?,?)')
      .run(key, value, tags.join(','), project);
    printMemory(`Saved: ${key}`);
  }
}

export function recall(query, limit = 8) {
  const db = getDB();
  if (!query || query.trim() === '') return [];
  // Multi-keyword LIKE search across key, value, tags
  const words = query.trim().split(/\s+/).slice(0, 5);
  const conditions = words.map(() => '(key LIKE ? OR value LIKE ? OR tags LIKE ?)').join(' OR ');
  const params = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`]);
  params.push(limit);
  return db.prepare(`SELECT key, value, tags, project, updated_at FROM memories WHERE ${conditions} ORDER BY updated_at DESC LIMIT ?`).all(...params);
}

export function listMemories(limit = 50) {
  const db = getDB();
  return db.prepare('SELECT key, value, tags, project, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export function deleteMemory(key) {
  const db = getDB();
  db.prepare('DELETE FROM memories WHERE key = ?').run(key);
}

export function clearMemories(project = null) {
  const db = getDB();
  if (project) db.prepare('DELETE FROM memories WHERE project = ?').run(project);
  else db.prepare('DELETE FROM memories').run();
}

// ── Session tracking ──────────────────────────────────────────────────────────

export function createSession(project = '') {
  const db = getDB();
  const result = db.prepare('INSERT INTO sessions (project) VALUES (?)').run(project);
  return result.lastInsertRowid;
}

export function closeSession(sessionId, summary, tokensIn, tokensOut) {
  const db = getDB();
  db.prepare(`UPDATE sessions SET ended_at=datetime('now'), summary=?, tokens_in=?, tokens_out=? WHERE id=?`)
    .run(summary, tokensIn, tokensOut, sessionId);
}

export function saveSessionTurn(sessionId, role, content) {
  const db = getDB();
  db.prepare('INSERT INTO session_turns (session_id, role, content) VALUES (?,?,?)').run(sessionId, role, content);
}

export function getSessionHistory(sessionId) {
  const db = getDB();
  return db.prepare('SELECT role, content FROM session_turns WHERE session_id=? ORDER BY id').all(sessionId);
}

export function getRecentSessions(limit = 10) {
  const db = getDB();
  return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit);
}

// ── Project registry ──────────────────────────────────────────────────────────

export function upsertProject(path, name, language = '', framework = '', summary = '') {
  const db = getDB();
  db.prepare(`
    INSERT INTO projects (path, name, language, framework, summary) VALUES (?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET name=excluded.name, language=excluded.language,
      framework=excluded.framework, summary=excluded.summary, learned_at=datetime('now')
  `).run(path, name, language, framework, summary);
}

export function getProject(path) {
  const db = getDB();
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(path);
}

export function listProjects() {
  const db = getDB();
  return db.prepare('SELECT * FROM projects ORDER BY learned_at DESC').all();
}

export function getMemoryStats() {
  const db = getDB();
  const mCount = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
  const sCount = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const pCount = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
  const tokens = db.prepare('SELECT COALESCE(SUM(tokens_in+tokens_out),0) as t FROM sessions').get().t;
  return { memories: mCount, sessions: sCount, projects: pCount, totalTokens: tokens };
}

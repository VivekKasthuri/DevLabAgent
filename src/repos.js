// src/repos.js — multi-repository registry backed by node:sqlite
import { DatabaseSync } from 'node:sqlite';
import { MEMORY_DB_PATH } from './config.js';
import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, basename } from 'path';
import { homedir } from 'os';

let db;
function getDB() {
  if (db) return db;
  db = new DatabaseSync(MEMORY_DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS repos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    tags       TEXT DEFAULT '',
    added_at   TEXT DEFAULT (datetime('now')),
    last_scan  TEXT,
    last_fix   TEXT,
    issue_count INTEGER DEFAULT 0,
    fixed_count INTEGER DEFAULT 0,
    status     TEXT DEFAULT 'unknown'
  )`);
  return db;
}

export function addRepo(path, { tags = [], name = '' } = {}) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);
  const db = getDB();
  db.prepare(`INSERT INTO repos (path, name, tags) VALUES (?,?,?)
    ON CONFLICT(path) DO UPDATE SET name=excluded.name, tags=excluded.tags`)
    .run(abs, name || basename(abs), tags.join(','));
  return abs;
}

export function removeRepo(path) {
  const abs = resolve(path);
  const db = getDB();
  db.prepare('DELETE FROM repos WHERE path = ?').run(abs);
}

export function listRepos() {
  const db = getDB();
  return db.prepare('SELECT * FROM repos ORDER BY added_at DESC').all();
}

export function updateRepoStatus(path, { lastScan, lastFix, issueCount, fixedCount, status } = {}) {
  const db = getDB();
  const fields = [];
  const vals = [];
  if (lastScan !== undefined) { fields.push('last_scan=?'); vals.push(lastScan); }
  if (lastFix !== undefined)  { fields.push('last_fix=?');  vals.push(lastFix); }
  if (issueCount !== undefined) { fields.push('issue_count=?'); vals.push(issueCount); }
  if (fixedCount !== undefined) { fields.push('fixed_count=?'); vals.push(fixedCount); }
  if (status !== undefined)   { fields.push('status=?');    vals.push(status); }
  if (!fields.length) return;
  vals.push(resolve(path));
  db.prepare(`UPDATE repos SET ${fields.join(', ')} WHERE path=?`).run(...vals);
}

/**
 * Auto-discover git repos under a root directory (max 2 levels deep)
 */
export function discoverRepos(rootPath = homedir(), { maxDepth = 2 } = {}) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (!existsSync(dir)) return;
    try {
      if (existsSync(join(dir, '.git'))) {
        found.push(dir);
        return; // don't recurse into nested git repos
      }
      const entries = readdirSync(dir);
      for (const e of entries) {
        if (e.startsWith('.') || e === 'node_modules' || e === '__pycache__') continue;
        const full = join(dir, e);
        try {
          if (statSync(full).isDirectory()) walk(full, depth + 1);
        } catch {}
      }
    } catch {}
  }
  walk(rootPath, 0);
  return found;
}

// Semantic code index — Cursor-style "search by meaning" for any codebase.
// Two-tier design:
//   1. Ollama embeddings (nomic-embed-text / all-minilm) when available → true semantic search
//   2. Zero-dependency TF-IDF + code-aware tokenization fallback → works fully offline
// Index persists to .devlab/index/ and updates incrementally via content hashes.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const INDEX_DIR = '.devlab/index';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODELS = ['nomic-embed-text', 'all-minilm', 'mxbai-embed-large'];
const SRC_EXT = /\.(js|jsx|ts|tsx|py|go|rb|java|kt|kts|swift|dart|cs|php|m|mm|vue|svelte)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.dart_tool', 'Pods', 'DerivedData', '.gradle', 'vendor', '__pycache__', '.devlab', 'coverage', '.next', 'out']);
const CHUNK_LINES = 40;      // lines per chunk
const CHUNK_OVERLAP = 8;     // overlapping lines between chunks
const MAX_FILES = 2000;

// ---------- tokenization (code-aware) ----------
function tokenize(text) {
  return text
    // split camelCase and PascalCase: getUserName -> get User Name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // split snake_case and kebab-case
    .replace(/[_\-.]/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && t.length < 40);
}

// ---------- chunking ----------
function chunkFile(filePath, content) {
  const lines = content.split('\n');
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join('\n');
    if (text.trim().length < 20) continue;
    chunks.push({ file: filePath, startLine: start + 1, endLine: end, text });
    if (end >= lines.length) break;
  }
  return chunks;
}

function walkSource(root) {
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 8 || files.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
      } else if (SRC_EXT.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return files;
}

// ---------- Ollama embeddings (optional tier) ----------
async function detectEmbedModel() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    const names = (data.models || []).map(m => m.name.split(':')[0]);
    return EMBED_MODELS.find(m => names.includes(m)) || null;
  } catch { return null; }
}

async function embed(texts, model) {
  const vectors = [];
  for (const text of texts) {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    vectors.push(data.embedding || null);
  }
  return vectors;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------- index build ----------
export async function buildIndex({ path: dir = '.', force = false } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  const outDir = path.join(root, INDEX_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const indexFile = path.join(outDir, 'code-index.json');

  let existing = { files: {}, chunks: [] };
  if (!force && fs.existsSync(indexFile)) {
    try { existing = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { /* rebuild */ }
  }

  const embedModel = await detectEmbedModel();
  const sourceFiles = walkSource(root);
  const started = Date.now();

  const newFiles = {};
  let chunks = [];
  let reused = 0, indexed = 0;

  for (const f of sourceFiles) {
    const rel = path.relative(root, f);
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (content.length > 500000) continue;
    const hash = crypto.createHash('md5').update(content).digest('hex');
    newFiles[rel] = hash;

    if (existing.files[rel] === hash) {
      // unchanged — reuse chunks
      chunks.push(...existing.chunks.filter(c => c.file === rel));
      reused++;
      continue;
    }
    indexed++;
    const fileChunks = chunkFile(rel, content);
    for (const c of fileChunks) {
      c.tokens = tokenize(c.text);
      // compact term frequency map
      const tf = {};
      for (const t of c.tokens) tf[t] = (tf[t] || 0) + 1;
      c.tf = tf;
      delete c.tokens;
    }
    chunks.push(...fileChunks);
  }

  // drop chunks from deleted files
  chunks = chunks.filter(c => newFiles[c.file]);

  // embeddings tier (only for chunks missing vectors, if model available)
  let embedded = 0;
  if (embedModel) {
    const need = chunks.filter(c => !c.vec);
    for (let i = 0; i < need.length; i += 10) {
      const batch = need.slice(i, i + 10);
      try {
        const vecs = await embed(batch.map(c => c.text), embedModel);
        batch.forEach((c, j) => { if (vecs[j]) { c.vec = vecs[j]; embedded++; } });
      } catch { break; } // embeddings optional — never fail the build
    }
  }

  // document frequency for TF-IDF
  const df = {};
  for (const c of chunks) for (const t of Object.keys(c.tf || {})) df[t] = (df[t] || 0) + 1;

  const index = {
    version: 2,
    builtAt: new Date().toISOString(),
    root,
    mode: embedModel ? `hybrid (tf-idf + ${embedModel})` : 'tf-idf (offline)',
    files: newFiles,
    df,
    totalChunks: chunks.length,
    chunks,
  };
  fs.writeFileSync(indexFile, JSON.stringify(index));

  return {
    mode: index.mode,
    files: Object.keys(newFiles).length,
    chunks: chunks.length,
    indexed, reused, embedded,
    durationSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    indexFile,
    hint: embedModel ? undefined : 'For true semantic search: `ollama pull nomic-embed-text` then rebuild. TF-IDF mode still gives strong code search.',
  };
}

// ---------- search ----------
export async function searchIndex({ path: dir = '.', query, maxResults = 8, buildIfMissing = true } = {}) {
  if (!query) return { error: 'query is required' };
  const root = path.resolve(dir);
  const indexFile = path.join(root, INDEX_DIR, 'code-index.json');

  if (!fs.existsSync(indexFile)) {
    if (!buildIfMissing) return { error: 'No index — run build_code_index first' };
    const built = await buildIndex({ path: dir });
    if (built.error) return built;
  }

  let index;
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return { error: 'Corrupt index — rebuild with force:true' }; }

  const { chunks, df, totalChunks } = index;
  const qTokens = tokenize(query);
  if (!qTokens.length) return { error: 'Query produced no searchable tokens' };

  // TF-IDF scoring (always available)
  const scored = chunks.map(c => {
    let score = 0;
    const fileTokens = new Set(tokenize(c.file));
    for (const t of qTokens) {
      const tf = (c.tf || {})[t] || 0;
      if (tf) score += (1 + Math.log(tf)) * Math.log(1 + totalChunks / (df[t] || 1));
      // filename relevance: query term matching the file path is a strong signal
      if (fileTokens.has(t)) score += 5;
    }
    // small boost when several distinct query terms co-occur
    const hits = qTokens.filter(t => (c.tf || {})[t]).length;
    score *= 1 + 0.3 * (hits - 1);
    return { c, score };
  });

  // semantic tier: blend cosine similarity when vectors exist
  const embedModel = chunks.some(c => c.vec) ? await detectEmbedModel() : null;
  if (embedModel) {
    try {
      const [qVec] = await embed([query], embedModel);
      if (qVec) {
        const maxLex = Math.max(...scored.map(s => s.score), 1);
        for (const s of scored) {
          if (s.c.vec) s.score = 0.5 * (s.score / maxLex) + 0.5 * cosine(qVec, s.c.vec);
          else s.score = s.score / maxLex * 0.7;
        }
      }
    } catch { /* lexical results still fine */ }
  }

  const top = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => ({
      file: s.c.file,
      lines: `${s.c.startLine}-${s.c.endLine}`,
      score: Number(s.score.toFixed(3)),
      preview: s.c.text.split('\n').slice(0, 8).join('\n').slice(0, 400),
    }));

  return {
    query,
    mode: index.mode,
    results: top,
    count: top.length,
    ...(top.length === 0 ? { hint: 'No matches — try different terms or rebuild the index if files changed' } : {}),
  };
}

export function indexStatus(dir = '.') {
  const indexFile = path.join(path.resolve(dir), INDEX_DIR, 'code-index.json');
  if (!fs.existsSync(indexFile)) return { exists: false, hint: 'Run build_code_index to create it' };
  try {
    const i = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    return { exists: true, mode: i.mode, builtAt: i.builtAt, files: Object.keys(i.files).length, chunks: i.totalChunks, sizeKB: Math.round(fs.statSync(indexFile).size / 1024) };
  } catch { return { exists: true, corrupt: true, hint: 'Rebuild with force:true' }; }
}

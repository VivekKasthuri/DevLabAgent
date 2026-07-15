// src/tools/conflicts.js — endpoint conflict + race condition detection.
// 1. check_endpoint_conflicts: finds multiple handlers/classes mapping the same
//    HTTP route (Express/Nest/Spring/Flask/FastAPI/Go) — a classic source of
//    "why is my change not taking effect" bugs.
// 2. check_race_conditions: heuristic scan for concurrency hazards (shared
//    mutable state in async handlers, check-then-act on files, non-atomic
//    read-modify-write, fire-and-forget promises).
// Both are wired into the agent loop: after any code change, the agent scans
// the changed files and PROMPTS THE USER when it finds a conflict.
import fs from 'fs';
import path from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', 'Pods', '.devlab', 'target', '.gradle']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.py', '.go', '.swift']);
const MAX_FILES = 800;
const MAX_SIZE = 400 * 1024;

function walk(dir, files = []) {
  if (files.length >= MAX_FILES) return files;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of entries) {
    if (files.length >= MAX_FILES) break;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, files);
    } else if (CODE_EXT.has(path.extname(e.name))) {
      try { if (fs.statSync(full).size <= MAX_SIZE) files.push(full); } catch { /* skip */ }
    }
  }
  return files;
}

// ── Endpoint extraction per framework ────────────────────────────────────────
function normalizeRoute(route) {
  return route
    .replace(/\$\{[^}]*\}/g, ':param')       // template literals
    .replace(/\{[^}]*\}/g, ':param')          // spring/flask/go {id}
    .replace(/:[A-Za-z_][\w]*/g, ':param')    // express :id
    .replace(/<[^>]*>/g, ':param')            // flask <int:id>
    .replace(/\/+$/, '') || '/';
}

export function extractEndpoints(content, file) {
  const endpoints = [];
  const lines = content.split('\n');
  const ext = path.extname(file);

  const push = (method, route, lineNo) => {
    if (!route || route.length > 200) return;
    endpoints.push({ method: method.toUpperCase(), route: normalizeRoute(route), raw: route, file, line: lineNo + 1 });
  };

  // Track class-level base paths (Spring @RequestMapping, Nest @Controller)
  let basePath = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (ext === '.java' || ext === '.kt') {
      const cls = line.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/);
      if (cls && !/public\s+\w+\s+\w+\s*\(/.test(line)) basePath = cls[1];
      const m = line.match(/@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(\s*(?:value\s*=\s*)?"([^"]*)"|\(\s*\)|(?=\s|$))/);
      if (m) push(m[1], (basePath + (m[2] || '')) || '/', i);
      continue;
    }

    if (ext === '.py') {
      const fl = line.match(/@(?:\w+\.)?(?:route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/);
      if (fl) {
        const methodM = line.match(/@(?:\w+\.)?(get|post|put|delete|patch)\s*\(/) || line.match(/methods\s*=\s*\[\s*['"](\w+)['"]/);
        push(methodM ? methodM[1] : 'GET', fl[1], i);
      }
      continue;
    }

    if (ext === '.go') {
      const g = line.match(/\.(GET|POST|PUT|DELETE|PATCH|Handle(?:Func)?)\s*\(\s*"([^"]+)"/);
      if (g) push(g[1].startsWith('Handle') ? 'ANY' : g[1], g[2], i);
      continue;
    }

    // JS/TS: Express/Fastify/Koa router + NestJS decorators
    const nestCtrl = line.match(/@Controller\s*\(\s*['"]([^'"]*)['"]/);
    if (nestCtrl) basePath = '/' + nestCtrl[1].replace(/^\//, '');
    const nest = line.match(/@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/);
    if (nest) { push(nest[1], (basePath + '/' + (nest[2] || '')).replace(/\/+/g, '/'), i); continue; }

    const ex = line.match(/\b(?:app|router|server|api|r)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*(['"`])([^'"`]+)\2/);
    if (ex) push(ex[1] === 'all' ? 'ANY' : ex[1], ex[3], i);
  }
  return endpoints;
}

export function checkEndpointConflicts({ path: dir = '.', files: onlyFiles } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  const files = onlyFiles?.length
    ? onlyFiles.map(f => path.resolve(root, f)).filter(f => fs.existsSync(f))
    : walk(root);

  // If specific files given, still scan whole project for the comparison set
  const compareFiles = onlyFiles?.length ? walk(root) : files;

  const all = [];
  for (const f of compareFiles) {
    try { all.push(...extractEndpoints(fs.readFileSync(f, 'utf8'), path.relative(root, f))); } catch { /* skip */ }
  }

  // Group by METHOD+route
  const byKey = new Map();
  for (const ep of all) {
    const key = `${ep.method} ${ep.route}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(ep);
  }

  const conflicts = [];
  for (const [key, eps] of byKey) {
    if (eps.length < 2) continue;
    const uniqueFiles = new Set(eps.map(e => e.file));
    const crossFile = uniqueFiles.size > 1;
    // ANY conflicts with specific methods on the same route too
    conflicts.push({
      endpoint: key,
      count: eps.length,
      severity: crossFile ? 'HIGH' : 'MEDIUM',
      crossFile,
      handlers: eps.map(e => `${e.file}:${e.line}`),
      issue: crossFile
        ? 'Same route mapped in MULTIPLE files/classes — only one handler will win (registration order), changes to the other silently do nothing'
        : 'Same route registered twice in one file — the later registration shadows the earlier one',
    });
  }

  // Also flag ANY-method overlapping a specific method on the same route
  const routes = new Map();
  for (const ep of all) {
    if (!routes.has(ep.route)) routes.set(ep.route, []);
    routes.get(ep.route).push(ep);
  }
  for (const [route, eps] of routes) {
    const anyH = eps.filter(e => e.method === 'ANY');
    const specific = eps.filter(e => e.method !== 'ANY');
    if (anyH.length && specific.length) {
      conflicts.push({
        endpoint: `ANY ${route}`,
        count: anyH.length + specific.length,
        severity: 'MEDIUM',
        crossFile: new Set(eps.map(e => e.file)).size > 1,
        handlers: eps.map(e => `${e.method} ${e.file}:${e.line}`),
        issue: 'A catch-all (app.all / HandleFunc) overlaps specific method handlers on the same route — behaviour depends on registration order',
      });
    }
  }

  const touched = onlyFiles?.length
    ? conflicts.filter(c => c.handlers.some(h => onlyFiles.some(f => h.includes(f.replace(/^\.\//, '')))))
    : conflicts;

  return {
    scannedFiles: compareFiles.length,
    totalEndpoints: all.length,
    conflicts: touched.sort((a, b) => (a.severity === 'HIGH' ? -1 : 1) - (b.severity === 'HIGH' ? -1 : 1)),
    clean: touched.length === 0,
    ...(touched.length ? { userPrompt: `⚠️ ${touched.length} endpoint conflict(s) found — the same route is handled by multiple classes/handlers. Ask the user which handler should own each route before continuing.` } : {}),
  };
}

// ── Race condition heuristics ────────────────────────────────────────────────
const RACE_PATTERNS = [
  {
    id: 'R001', severity: 'HIGH',
    name: 'Check-then-act on filesystem',
    // existsSync followed by write/mkdir in nearby lines — TOCTOU race
    test: (lines, i) => /existsSync\s*\(/.test(lines[i]) &&
      lines.slice(i, i + 6).some(l => /(writeFile|mkdir|appendFile|unlink|rm)\w*\s*\(/.test(l)),
    hint: 'File may change between the exists check and the write (TOCTOU). Use atomic ops: mkdirSync({recursive:true}), writeFile with flag "wx", or handle EEXIST.',
  },
  {
    id: 'R002', severity: 'HIGH',
    name: 'Shared mutable state mutated in async handler',
    // module-level let/var later mutated inside an async function — flagged at mutation site
    test: (lines, i, ctx) => ctx.sharedVars.size > 0 && ctx.inAsync[i] &&
      [...ctx.sharedVars].some(v => new RegExp(`(^|[^.\\w])${v}\\s*(\\+\\+|--|[+\\-*/]?=[^=])`).test(lines[i])),
    hint: 'Module-level variable mutated inside an async/request handler — concurrent requests interleave. Use a per-request scope, a Map keyed by request, or an async mutex.',
  },
  {
    id: 'R003', severity: 'MEDIUM',
    name: 'Non-atomic read-modify-write of a file',
    test: (lines, i) => /readFile(Sync)?\s*\(/.test(lines[i]) &&
      lines.slice(i, i + 12).some(l => /writeFile(Sync)?\s*\(/.test(l)) &&
      lines.slice(Math.max(0, i - 5), i + 12).some(l => /JSON\.parse|JSON\.stringify/.test(l)),
    hint: 'Read → modify → write JSON without locking: two concurrent writers lose updates. Use a write queue, lockfile, or a real store (sqlite).',
  },
  {
    id: 'R004', severity: 'MEDIUM',
    name: 'Fire-and-forget async call',
    // async fn call whose promise is discarded inside a handler (not awaited/returned/caught)
    test: (lines, i, ctx) => ctx.inAsync[i] &&
      /(?<!await\s)(?<!return\s)(?<!void\s)\b\w+\.(save|update|insert|delete|write|send|push|emit)\w*\s*\([^)]*\)\s*;?\s*$/.test(lines[i]) &&
      !/\.(then|catch|finally)\s*\(/.test(lines[i]) && !/await/.test(lines[i]) && !/^\s*(const|let|var|return)\b/.test(lines[i]),
    hint: 'Possible un-awaited async operation in a handler — completion order is nondeterministic and errors are swallowed. Add await or .catch().',
  },
  {
    id: 'R005', severity: 'MEDIUM',
    name: 'Counter increment without atomicity',
    test: (lines, i, ctx) => ctx.inAsync[i] && /\b\w*(count|counter|total|balance|stock|quantity|inventory)\w*\s*(\+\+|--|\+=|-=)/i.test(lines[i]),
    hint: 'Increment/decrement of a counter-like variable in async code — lost updates under concurrency. Use an atomic DB operation ($inc, UPDATE ... SET x=x+1) or a mutex.',
  },
];

function buildAsyncMap(lines) {
  // rough map: which lines are inside an async function / route handler
  const inAsync = new Array(lines.length).fill(false);
  let depth = 0, asyncDepth = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (asyncDepth === -1 && (/\basync\b/.test(l) || /\.(get|post|put|delete|patch|all)\s*\(/.test(l) || /def\s+\w+.*:\s*$/.test(l))) {
      asyncDepth = depth;
    }
    depth += (l.match(/\{/g) || []).length;
    depth -= (l.match(/\}/g) || []).length;
    if (asyncDepth !== -1) {
      inAsync[i] = true;
      if (depth <= asyncDepth) asyncDepth = -1;
    }
  }
  return inAsync;
}

function findSharedVars(lines) {
  // module-level let/var (depth 0) — candidates for shared mutable state
  const vars = new Set();
  let depth = 0;
  for (const l of lines) {
    if (depth === 0) {
      const m = l.match(/^\s*(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m) vars.add(m[1]);
    }
    depth += (l.match(/\{/g) || []).length;
    depth -= (l.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return vars;
}

export function checkRaceConditions({ path: dir = '.', files: onlyFiles } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };

  const files = onlyFiles?.length
    ? onlyFiles.map(f => path.resolve(root, f)).filter(f => fs.existsSync(f) && CODE_EXT.has(path.extname(f)))
    : walk(root).filter(f => !/\btest\b|\.test\.|\.spec\./.test(f));

  const findings = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const ctx = { inAsync: buildAsyncMap(lines), sharedVars: findSharedVars(lines) };
    const rel = path.relative(root, f);

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim() || lines[i].trim().startsWith('//') || lines[i].trim().startsWith('*')) continue;
      for (const p of RACE_PATTERNS) {
        try {
          if (p.test(lines, i, ctx)) {
            findings.push({ id: p.id, severity: p.severity, name: p.name, file: rel, line: i + 1, code: lines[i].trim().slice(0, 120), hint: p.hint });
          }
        } catch { /* pattern error — skip */ }
      }
    }
  }

  const high = findings.filter(f => f.severity === 'HIGH');
  return {
    scannedFiles: files.length,
    findings: findings.slice(0, 50),
    summary: { high: high.length, medium: findings.length - high.length, total: findings.length },
    clean: findings.length === 0,
    ...(high.length ? { userPrompt: `⚠️ ${high.length} HIGH-risk race condition(s) detected. Confirm with the user how concurrent access should be handled before continuing.` } : {}),
  };
}

// ── Combined post-edit guard used by the agent loop ──────────────────────────
export function postEditGuard({ path: dir = '.', files } = {}) {
  const ep = checkEndpointConflicts({ path: dir, files });
  const rc = checkRaceConditions({ path: dir, files });
  const warnings = [];
  if (!ep.error && ep.conflicts?.length) {
    warnings.push(`ENDPOINT CONFLICTS (${ep.conflicts.length}):`);
    for (const c of ep.conflicts.slice(0, 5)) warnings.push(`  - [${c.severity}] ${c.endpoint} handled ${c.count}x: ${c.handlers.join(', ')} — ${c.issue}`);
  }
  if (!rc.error && rc.findings?.length) {
    const high = rc.findings.filter(f => f.severity === 'HIGH');
    if (high.length) {
      warnings.push(`RACE CONDITIONS (${high.length} HIGH):`);
      for (const f of high.slice(0, 5)) warnings.push(`  - [${f.id}] ${f.name} at ${f.file}:${f.line} — ${f.hint}`);
    }
  }
  return { clean: warnings.length === 0, warnings };
}

// src/tools/reviewer.js — Deep multi-platform code review engine
// Combines static analysis patterns + LLM semantic review + concrete fix generation
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, join, extname, basename, relative } from 'path';
import { listFiles, readFile } from './files.js';
import { runCommandSync } from './shell.js';
import { gitDiff } from './git.js';
import YAML from 'yaml';
import { chat } from '../llm.js';
import { printTool, printWarn, printError, printSuccess } from '../ui.js';
import chalk from 'chalk';

// ── Language mapping ───────────────────────────────────────────────────────────
const EXT_TO_LANG = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python',
  '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.dart': 'dart',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.sql': 'sql',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css', '.scss': 'scss',
};

function getLang(filePath) {
  return EXT_TO_LANG[extname(filePath).toLowerCase()] || 'text';
}

// ── Static analysis patterns (per language) ───────────────────────────────────
const STATIC_PATTERNS = {
  javascript: [
    { id: 'JS001', sev: 'high',   cat: 'bug',           name: 'Floating Promise',          re: /(?<!\bawait\b\s+)(?<!\breturn\b\s+)(?<!\w\s*=\s*)(?<!\(\s*)(?:fetch|axios\.|\.then\(|new Promise)\s*\(/gm, tip: 'Unhandled promise — add await or .catch()' },
    { id: 'JS002', sev: 'high',   cat: 'bug',           name: '== instead of ===',         re: /(?<![=!<>])={2}(?!=)(?!\s*=)/g, tip: 'Use === for strict equality to avoid type coercion bugs' },
    { id: 'JS003', sev: 'medium', cat: 'bug',           name: 'Mutation of function arg',  re: /function\s+\w+\s*\([^)]*\)\s*\{[^}]*\b(\w+)\.(push|pop|shift|splice|sort)\s*\(/g, tip: 'Do not mutate function parameters — clone first' },
    { id: 'JS004', sev: 'high',   cat: 'bug',           name: 'var in async loop',         re: /for\s*\(var\s/g, tip: 'Use let/const in loops — var causes closure bugs in async code' },
    { id: 'JS005', sev: 'medium', cat: 'performance',   name: 'JSON.parse in loop',        re: /for\s*[\(\{][^}]+JSON\.parse/g, tip: 'JSON.parse is expensive — move outside loop' },
    { id: 'JS006', sev: 'medium', cat: 'bug',           name: 'Catch without handling',    re: /catch\s*\(\w+\)\s*\{\s*\}/g, tip: 'Empty catch silently swallows errors — log or rethrow' },
    { id: 'JS007', sev: 'low',    cat: 'style',         name: 'console.log left in code',  re: /\bconsole\.(log|warn|error)\s*\(/g, tip: 'Remove debug console statements before committing' },
    { id: 'JS008', sev: 'high',   cat: 'security',      name: 'dangerouslySetInnerHTML',   re: /dangerouslySetInnerHTML/g, tip: 'XSS risk — sanitize content before injecting HTML' },
    { id: 'JS009', sev: 'medium', cat: 'performance',   name: 'Regex recompiled in loop',  re: /for\s*\([^)]+\)[^{]*\{[^}]*new RegExp/g, tip: 'Compile regex outside loop using a const' },
    { id: 'JS010', sev: 'high',   cat: 'bug',           name: 'typeof null === "object"',  re: /typeof\s+\w+\s*===?\s*["']object["'](?!\s*&&)/g, tip: 'typeof null === "object" — always null-check first' },
  ],
  typescript: [
    { id: 'TS001', sev: 'high',   cat: 'type-safety',   name: 'any type usage',            re: /:\s*any\b/g, tip: 'Replace any with proper types or unknown — any bypasses type safety' },
    { id: 'TS002', sev: 'high',   cat: 'type-safety',   name: 'Non-null assertion (!)',     re: /\w!\./g, tip: 'Non-null assertion can cause runtime crashes — add proper null check' },
    { id: 'TS003', sev: 'medium', cat: 'type-safety',   name: 'Type cast with as',         re: /\bas\s+\w+/g, tip: 'Unsafe cast — use type guards or validation instead' },
    { id: 'TS004', sev: 'medium', cat: 'best-practice', name: 'Missing return type',       re: /(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?!:)\s*\{/g, tip: 'Add explicit return type to public functions' },
    { id: 'TS005', sev: 'low',    cat: 'style',         name: '@ts-ignore suppression',    re: /@ts-ignore|@ts-nocheck/g, tip: 'Fix the underlying type error instead of suppressing it' },
    { id: 'TS006', sev: 'high',   cat: 'bug',           name: 'Promise<void> not awaited', re: /(?<!await\s)(?<!return\s)\w+\s*\(\s*\)\s*;(?:\s*\/\/.*)?$\s*(?!\s*\.catch)/gm, tip: 'Check if this returns a Promise that should be awaited' },
    { id: 'TS007', sev: 'medium', cat: 'best-practice', name: 'Enum vs const enum',        re: /^(?:export\s+)?enum\s+/gm, tip: 'Prefer const enum or union types for better tree-shaking' },
  ],
  python: [
    { id: 'PY001', sev: 'high',   cat: 'bug',           name: 'Mutable default arg',       re: /def\s+\w+\s*\([^)]*=\s*(?:\[\]|\{\}|\(\))/g, tip: 'Mutable default argument is shared across calls — use None and initialize inside' },
    { id: 'PY002', sev: 'high',   cat: 'bug',           name: 'Broad except clause',       re: /except\s*:/g, tip: 'Bare except catches SystemExit/KeyboardInterrupt — use except Exception:' },
    { id: 'PY003', sev: 'medium', cat: 'performance',   name: 'String concat in loop',     re: /for\s+\w+.+:\s*\n\s+\w+\s*\+=\s*["']/g, tip: 'String += in loops is O(n²) — use list.append() then "".join()' },
    { id: 'PY004', sev: 'medium', cat: 'bug',           name: 'isinstance vs type()',      re: /type\s*\(\s*\w+\s*\)\s*==\s*/g, tip: 'Use isinstance() — type() ignores inheritance' },
    { id: 'PY005', sev: 'high',   cat: 'security',      name: 'pickle.loads / eval',       re: /pickle\.loads|eval\s*\(/g, tip: 'Dangerous deserialization — never unpickle untrusted data' },
    { id: 'PY006', sev: 'medium', cat: 'best-practice', name: 'Missing type hints',        re: /^def\s+\w+\s*\([^)]*\)\s*:/gm, tip: 'Add type hints for all public functions' },
    { id: 'PY007', sev: 'low',    cat: 'style',         name: 'print() debug statements',  re: /^\s*print\s*\(/gm, tip: 'Replace print() with logging module for production code' },
    { id: 'PY008', sev: 'high',   cat: 'bug',           name: 'Global variable mutation',  re: /global\s+\w+/g, tip: 'Global mutation causes race conditions — pass as parameter or use a class' },
    { id: 'PY009', sev: 'medium', cat: 'performance',   name: 'List comprehension vs map', re: /list\(map\(/g, tip: 'list comprehension is faster and more readable than list(map(...))' },
  ],
  swift: [
    { id: 'SW001', sev: 'high',   cat: 'bug',           name: 'Force unwrap (!)',           re: /\w+!\s*(?:\.|[,)\]])/g, tip: 'Force unwrap crashes if nil — use guard let, if let, or ?? default' },
    { id: 'SW002', sev: 'high',   cat: 'memory',        name: 'Retain cycle (self in closure)', re: /\{\s*(?:in\s+)?self\.\w+(?!\s*=\s*\[weak self\])/g, tip: 'Capture [weak self] or [unowned self] to prevent retain cycles' },
    { id: 'SW003', sev: 'high',   cat: 'concurrency',   name: 'DispatchQueue.main sync',   re: /DispatchQueue\.main\.sync/g, tip: 'Main queue sync from main thread causes deadlock — use async' },
    { id: 'SW004', sev: 'medium', cat: 'best-practice', name: 'try! force try',            re: /\btry!\s/g, tip: 'Force try crashes on error — use do-catch or try?' },
    { id: 'SW005', sev: 'medium', cat: 'performance',   name: 'as! forced cast',           re: /\bas!\s/g, tip: 'Forced cast crashes if type mismatch — use as? and handle nil' },
    { id: 'SW006', sev: 'high',   cat: 'concurrency',   name: 'UI update on background',   re: /(?:URLSession|DispatchQueue\.global)[^}]+(?:self\.)?(?:label|title|text|image|view)\s*=/g, tip: 'All UI updates must be on the main thread — DispatchQueue.main.async { }' },
    { id: 'SW007', sev: 'medium', cat: 'bug',           name: 'Infinite recursion risk',   re: /var\s+\w+\s*:\s*\w+\s*\{\s*get\s*\{\s*return\s+\w+\b/g, tip: 'Computed property calling itself causes infinite recursion' },
    { id: 'SW008', sev: 'low',    cat: 'style',         name: 'print() in production',     re: /\bprint\s*\(/g, tip: 'Replace print() with os_log or Logger for proper log levels' },
    { id: 'SW009', sev: 'high',   cat: 'memory',        name: 'NSTimer strong reference',  re: /Timer\.scheduledTimer|NSTimer\.scheduledTimer/g, tip: 'Timer holds strong reference to target — store weak ref or use block-based timer' },
  ],
  kotlin: [
    { id: 'KT001', sev: 'high',   cat: 'bug',           name: 'Unchecked cast',            re: /\bas\s+\w+(?!\?)/g, tip: 'Unsafe cast — use as? and handle null case' },
    { id: 'KT002', sev: 'high',   cat: 'concurrency',   name: 'UI update off main thread',  re: /(?:Thread\.|Executors\.|Dispatchers\.IO)[^}]+(?:text|visibility|enabled)\s*=/g, tip: 'Update UI on main thread — withContext(Dispatchers.Main) { }' },
    { id: 'KT003', sev: 'high',   cat: 'bug',           name: 'lateinit without isInitialized check', re: /lateinit var\s+\w+(?![\s\S]*?\.isInitialized)/g, tip: 'Check ::property.isInitialized before accessing lateinit var' },
    { id: 'KT004', sev: 'medium', cat: 'performance',   name: 'String interpolation in loop', re: /for\s*\([^)]+\)[^{]*\{[^}]*"\$\{/g, tip: 'StringBuilder is more efficient for repeated string concatenation' },
    { id: 'KT005', sev: 'high',   cat: 'bug',           name: '!! (non-null assertion)',   re: /\w+!!\./g, tip: '!! throws NullPointerException — use safe call ?. or Elvis operator ?:' },
    { id: 'KT006', sev: 'medium', cat: 'best-practice', name: 'runBlocking in production', re: /runBlocking\s*\{/g, tip: 'runBlocking blocks thread — use suspend functions or CoroutineScope.launch' },
    { id: 'KT007', sev: 'high',   cat: 'memory',        name: 'Context stored as field',   re: /(?:private|val|var)\s+\w*[Cc]ontext\s*:\s*Context/g, tip: 'Storing Context creates memory leaks in Android — use ApplicationContext or WeakReference' },
    { id: 'KT008', sev: 'medium', cat: 'bug',           name: 'Catching generic Exception', re: /catch\s*\(\w+\s*:\s*Exception\)/g, tip: 'Catching Exception is too broad — catch specific exceptions' },
  ],
  dart: [
    { id: 'DA001', sev: 'high',   cat: 'bug',           name: 'Missing await on Future',   re: /(?<!\bawait\b\s+)(?<!\breturn\b\s+)\w+\.(then|catchError)\s*\(/g, tip: 'Use await instead of .then() for cleaner error handling' },
    { id: 'DA002', sev: 'high',   cat: 'concurrency',   name: 'setState inside async gap', re: /async[^{]*\{[\s\S]*?setState[\s\S]*?await/g, tip: 'Check if mounted before setState after async gap: if (!mounted) return;' },
    { id: 'DA003', sev: 'high',   cat: 'bug',           name: 'BuildContext across async', re: /async[^{]*\{[\s\S]*?Navigator\.|ScaffoldMessenger\./g, tip: 'Do not use BuildContext after async gap — store in local variable and check mounted' },
    { id: 'DA004', sev: 'medium', cat: 'performance',   name: 'Rebuilding expensive widgets', re: /build\s*\([^)]*\)\s*\{[^}]*(?:MediaQuery\.of|Theme\.of|Provider\.of)/g, tip: 'Cache MediaQuery/Theme results outside build() to prevent unnecessary rebuilds' },
    { id: 'DA005', sev: 'medium', cat: 'memory',        name: 'StreamController not closed', re: /StreamController[^;]+;(?![\s\S]*?\.close\(\))/g, tip: 'Always call streamController.close() in dispose()' },
    { id: 'DA006', sev: 'high',   cat: 'bug',           name: 'dispose() missing super',   re: /void dispose\s*\(\s*\)\s*\{(?![\s\S]*?super\.dispose)/g, tip: 'Always call super.dispose() at end of dispose() method' },
    { id: 'DA007', sev: 'medium', cat: 'best-practice', name: 'Null check with == null',   re: /\w+\s*==\s*null(?!\s*\?)/g, tip: 'Use ?. null-safe operator or if (x != null) pattern' },
    { id: 'DA008', sev: 'high',   cat: 'performance',   name: 'setState with entire rebuild', re: /setState\s*\(\s*\(\s*\)\s*\{[\s\S]{500,}\}\s*\)/g, tip: 'setState rebuilds entire widget — extract into smaller widgets or use provider/riverpod' },
  ],
  go: [
    { id: 'GO001', sev: 'high',   cat: 'bug',           name: 'Ignored error return',      re: /\w+,\s*_\s*:=\s*(?!os\.Exit)/g, tip: 'Never ignore errors — handle or wrap and return them' },
    { id: 'GO002', sev: 'high',   cat: 'concurrency',   name: 'Goroutine without WaitGroup', re: /go\s+func\s*\(/g, tip: 'Track goroutines with sync.WaitGroup to prevent goroutine leaks' },
    { id: 'GO003', sev: 'high',   cat: 'memory',        name: 'Response body not closed',  re: /http\.Get|http\.Post|client\.Do(?![\s\S]*?\.Body\.Close\(\))/g, tip: 'Always defer resp.Body.Close() to prevent resource leaks' },
    { id: 'GO004', sev: 'medium', cat: 'performance',   name: 'Slice append in tight loop', re: /for[^{]*\{[^}]*\w+\s*=\s*append\(\w+/g, tip: 'Pre-allocate slice with make([]T, 0, cap) to avoid repeated allocations' },
    { id: 'GO005', sev: 'high',   cat: 'concurrency',   name: 'Map concurrent read/write', re: /map\[/g, tip: 'Go maps are not safe for concurrent use — use sync.Map or a mutex' },
  ],
  java: [
    { id: 'JA001', sev: 'high',   cat: 'bug',           name: 'NullPointerException risk', re: /\w+\.(?:\w+)\s*\(\s*\)(?!\s*(?:\?|!=\s*null))/g, tip: 'Check for null before method calls or use Optional<T>' },
    { id: 'JA002', sev: 'high',   cat: 'concurrency',   name: 'Non-thread-safe HashMap',   re: /(?:new\s+HashMap|HashMap<)/g, tip: 'HashMap is not thread-safe — use ConcurrentHashMap or synchronize' },
    { id: 'JA003', sev: 'medium', cat: 'performance',   name: 'String concat (+) in loop', re: /for\s*\([^)]+\)[^{]*\{[^}]*\w+\s*\+=\s*["']/g, tip: 'Use StringBuilder for string concatenation in loops' },
    { id: 'JA004', sev: 'high',   cat: 'security',      name: 'SQL String concatenation',  re: /"SELECT[^"]*"\s*\+/g, tip: 'SQL injection risk — use PreparedStatement with parameters' },
  ],
};

// All-language patterns
const UNIVERSAL_PATTERNS = [
  { id: 'UNI001', sev: 'critical', cat: 'security',    name: 'Hardcoded secret',           re: /(?:password|secret|api.?key|token|auth)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/gi },
  { id: 'UNI002', sev: 'high',     cat: 'security',    name: 'Hardcoded IP address',        re: /['"]\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}['"]/g },
  { id: 'UNI003', sev: 'high',     cat: 'security',    name: 'TODO with security note',     re: /TODO.*(?:security|auth|encrypt|sanitize|validate)/gi },
  { id: 'UNI004', sev: 'medium',   cat: 'maintainability', name: 'Function too long (>80 lines)', re: null }, // handled specially
  { id: 'UNI005', sev: 'high',     cat: 'bug',         name: 'Commented-out code block',   re: /(?:\/\/|#|--)\s*(?:if|for|while|function|def|class)\s+/g },
];

function runStaticAnalysis(filePath, content, lang) {
  const findings = [];
  const patterns = [...(STATIC_PATTERNS[lang] || []), ...UNIVERSAL_PATTERNS.filter(p => p.re)];

  for (const p of patterns) {
    if (!p.re) continue;
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split('\n').length;
      const line = content.split('\n')[lineNum - 1]?.trim() || '';
      // Skip if in comments (simplistic check)
      if (line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) continue;
      findings.push({
        id: p.id,
        severity: p.sev,
        category: p.cat,
        name: p.name,
        line: lineNum,
        code: line.slice(0, 120),
        tip: p.tip,
        file: filePath,
      });
      if (findings.filter(f => f.id === p.id).length >= 5) break; // cap per pattern
    }
  }

  // Check function length
  const funcRe = /(?:function\s+\w+|def\s+\w+|func\s+\w+|\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|void\s+\w+\s*\()\s*\{?/g;
  let fm;
  while ((fm = funcRe.exec(content)) !== null) {
    const start = content.slice(0, fm.index).split('\n').length;
    const body = content.slice(fm.index);
    const lines = body.split('\n').length;
    if (lines > 80) {
      findings.push({ id: 'UNI004', severity: 'medium', category: 'maintainability', name: 'Function too long', line: start, code: fm[0].trim().slice(0, 80), tip: 'Functions over 80 lines are hard to test and maintain — extract smaller functions', file: filePath });
    }
  }

  return findings;
}

// ── LLM semantic review ───────────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer with deep expertise in all programming languages and platforms.

Your job: perform a thorough, production-grade code review and return structured JSON.

Review dimensions (cover ALL applicable ones):
1. **bugs** — Logic errors, null/nil crashes, race conditions, off-by-one, infinite loops
2. **security** — Injections, hardcoded secrets, unvalidated input, insecure storage, auth bypass
3. **performance** — N+1 queries, unnecessary re-renders, O(n²) operations, memory leaks, blocking calls
4. **type-safety** — Unsafe casts, missing types, any/dynamic abuse, force unwraps
5. **concurrency** — Thread safety, UI updates off main thread, deadlocks, async/await misuse
6. **memory** — Retain cycles, resource leaks, unclosed streams, large allocations
7. **error-handling** — Swallowed exceptions, missing error propagation, no fallback
8. **maintainability** — God objects, duplicated code, magic numbers, missing docs on public API
9. **best-practices** — Platform idioms, anti-patterns, deprecated APIs
10. **testability** — Untestable code, hidden dependencies, missing abstractions
11. **api/contracts** — REST/GraphQL/OpenAPI contract correctness, schema/code sync, status codes, validation, pagination, auth, resolver N+1 risks

For each issue, you MUST provide:
- The BEST, most complete fix — not just a hint, but actual corrected code
- Why the current code is wrong/risky
- What the fix achieves

Return ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "summary": "2-3 sentence overall assessment",
  "grade": "A|B|C|D|F",
  "findings": [
    {
      "id": "unique-id",
      "severity": "critical|high|medium|low|info",
      "category": "bug|security|performance|type-safety|concurrency|memory|error-handling|maintainability|best-practice|testability|api-contract",
      "line": <number>,
      "endLine": <number>,
      "name": "Short issue name",
      "description": "What is wrong and why it matters",
      "currentCode": "the problematic code snippet",
      "fix": "complete corrected replacement code",
      "explanation": "Why this fix is the best approach",
      "references": ["optional URL or RFC/doc reference"]
    }
  ],
  "positives": ["what the code does well"],
  "suggestions": ["broader architectural suggestions beyond individual findings"]
}`;

export async function reviewFileWithLLM(filePath, content, lang, { contextInfo = '' } = {}) {
  const maxSize = 12000; // token budget
  const truncated = content.length > maxSize;
  const codeToReview = content.slice(0, maxSize);

  const prompt = `Review this ${lang} file: ${basename(filePath)}
${contextInfo ? `Context: ${contextInfo}` : ''}

\`\`\`${lang}
${codeToReview}
${truncated ? '\n// ... (file truncated)' : ''}
\`\`\``;

  const response = await chat({
    messages: [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    fastModel: false, // use best model for reviews
  });

  // Parse JSON from response
  let parsed;
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.content.match(/```json\s*([\s\S]+?)```/) ||
                      response.content.match(/```\s*([\s\S]+?)```/) ||
                      [null, response.content];
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch {
    // Fallback: try to extract JSON object
    const match = response.content.match(/\{[\s\S]+\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }

  return parsed || {
    summary: 'Review completed (parse error — raw response attached)',
    grade: '?',
    findings: [],
    raw: response.content.slice(0, 500),
  };
}

// ── Full file review ──────────────────────────────────────────────────────────

export async function reviewFile(filePath, { llm = true, contextInfo = '' } = {}) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return { error: `File not found: ${filePath}` };

  const result = readFile(abs);
  if (result.error) return result;

  const { content } = result;
  const lang = getLang(abs);
  printTool(`Reviewing [${lang}]: ${filePath}`);

  const staticFindings = runStaticAnalysis(abs, content, lang);

  let llmResult = null;
  if (llm && content.trim().length > 50) {
    try {
      llmResult = await reviewFileWithLLM(abs, content, lang, { contextInfo });
    } catch (e) {
      printWarn(`LLM review failed: ${e.message}`);
    }
  }

  // Merge findings, deduplicate by line proximity
  const allFindings = [
    ...staticFindings.map(f => ({ ...f, source: 'static' })),
    ...(llmResult?.findings || []).map(f => ({ ...f, source: 'llm' })),
  ];

  return {
    file: abs,
    language: lang,
    lines: result.lines,
    grade: llmResult?.grade || gradeFromFindings(staticFindings),
    summary: llmResult?.summary || `Static analysis: ${staticFindings.length} issues found`,
    findings: allFindings,
    findingCount: allFindings.length,
    criticals: allFindings.filter(f => f.severity === 'critical').length,
    highs: allFindings.filter(f => f.severity === 'high').length,
    positives: llmResult?.positives || [],
    suggestions: llmResult?.suggestions || [],
  };
}

function gradeFromFindings(findings) {
  const score = findings.reduce((s, f) => s + ({ critical: 40, high: 20, medium: 10, low: 5, info: 1 }[f.severity] || 0), 0);
  return score === 0 ? 'A' : score < 20 ? 'B' : score < 60 ? 'C' : score < 120 ? 'D' : 'F';
}

function worseGrade(a, b) {
  const order = { A: 0, B: 1, C: 2, D: 3, F: 4 };
  return (order[b] ?? 0) > (order[a] ?? 0) ? b : a;
}

function hasApiBackendSignals(text) {
  return /restcontroller|requestmapping|flask|fastapi|@app\.(get|post|put|delete|patch)|router\.(get|post|put|delete|patch)|graphql|resolver|schema/i.test(text);
}

function extractApiContractFiles(projectPath, listedFiles = []) {
  const files = listedFiles.length > 0
    ? listedFiles
    : [];
  return files.filter(f => {
    const name = basename(f.path).toLowerCase();
    return (
      /openapi|swagger|postman|schema|graphql|\.gql$|\.graphql$|\.proto$/.test(name) ||
      /openapi|swagger|postman|schema|graphql/.test(f.path.toLowerCase())
    );
  });
}

function validateOpenApiContent(filePath, content) {
  const findings = [];
  const lower = content.toLowerCase();
  const hasOpenApiVersion = /^\s*openapi\s*:\s*["']?\d+/m.test(content) || /^\s*swagger\s*:\s*["']?2\./m.test(content);
  const hasInfo = /^\s*info\s*:/m.test(content);
  const hasPaths = /^\s*paths\s*:/m.test(content);
  const hasServers = /^\s*servers\s*:/m.test(content);
  const methodMatches = [...content.matchAll(/^\s{2,}(get|post|put|patch|delete|options|head)\s*:\s*$/gmi)];
  const opIdMatches = [...content.matchAll(/^\s*operationId\s*:\s*.+$/gmi)];
  const responseMatches = [...content.matchAll(/^\s*responses\s*:\s*$/gmi)];

  if (!hasOpenApiVersion) {
    findings.push({ id: 'API001', severity: 'high', category: 'api-contract', name: 'Missing OpenAPI version', description: 'OpenAPI documents must declare the spec version (openapi: 3.x or swagger: 2.0).', file: filePath });
  }
  if (!hasInfo) {
    findings.push({ id: 'API002', severity: 'high', category: 'api-contract', name: 'Missing API info block', description: 'OpenAPI documents should include an info block with title, version, and description.', file: filePath });
  }
  if (!hasPaths) {
    findings.push({ id: 'API003', severity: 'critical', category: 'api-contract', name: 'Missing paths block', description: 'OpenAPI documents without paths do not describe any endpoint contract.', file: filePath });
  }
  if (methodMatches.length > 0 && opIdMatches.length < Math.max(1, Math.floor(methodMatches.length * 0.5))) {
    findings.push({ id: 'API004', severity: 'medium', category: 'api-contract', name: 'Missing operationId coverage', description: 'Most OpenAPI operations should define operationId for client generation and stable reviews.', file: filePath });
  }
  if (methodMatches.length > 0 && responseMatches.length < Math.max(1, Math.floor(methodMatches.length * 0.5))) {
    findings.push({ id: 'API005', severity: 'high', category: 'api-contract', name: 'Missing responses blocks', description: 'Operations should define responses for success and error cases.', file: filePath });
  }
  if (!hasServers) {
    findings.push({ id: 'API006', severity: 'low', category: 'api-contract', name: 'Missing servers block', description: 'Consider adding servers so generated clients and documentation know the API base URL.', file: filePath });
  }
  if (!/security\s*:/m.test(content) && /auth|token|bearer|oauth/i.test(lower)) {
    findings.push({ id: 'API007', severity: 'medium', category: 'api-contract', name: 'Missing security scheme', description: 'The contract references authentication but does not define a security scheme.', file: filePath });
  }
  return findings;
}

function validateGraphqlContent(filePath, content) {
  const findings = [];
  const hasQuery = /type\s+Query\b|extend\s+type\s+Query\b/i.test(content);
  const hasMutation = /type\s+Mutation\b|extend\s+type\s+Mutation\b/i.test(content);
  const hasDescriptions = /"""/.test(content) || /#\s+\w+/.test(content);

  if (!hasQuery) {
    findings.push({ id: 'GQL001', severity: 'high', category: 'api-contract', name: 'Missing Query root', description: 'GraphQL schemas should define a Query root for read operations.', file: filePath });
  }
  if (!hasMutation) {
    findings.push({ id: 'GQL002', severity: 'medium', category: 'api-contract', name: 'Missing Mutation root', description: 'If the API supports writes, expose mutations in the schema.', file: filePath });
  }
  if (!hasDescriptions) {
    findings.push({ id: 'GQL003', severity: 'low', category: 'api-contract', name: 'Undocumented schema', description: 'Add descriptions/comments to GraphQL types and fields for consumer clarity.', file: filePath });
  }
  if (/list\b.*\btype\b|\btype\b.*\blist\b/i.test(content) && !/first|after|cursor|pageInfo/i.test(content)) {
    findings.push({ id: 'GQL004', severity: 'medium', category: 'api-contract', name: 'Pagination not explicit', description: 'List fields should expose cursor-based pagination to avoid unbounded responses.', file: filePath });
  }
  return findings;
}

function normalizeContractPath(pathValue) {
  return String(pathValue || '')
    .trim()
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function canonicalPath(pathValue) {
  return normalizeContractPath(pathValue)
    .replace(/:([^/]+)/g, ':param')
    .replace(/\/+/g, '/');
}

function parsePathSegments(pathValue) {
  return canonicalPath(pathValue).split('/').filter(Boolean);
}

function extractOpenApiOperationsFromObject(obj, filePath) {
  const ops = [];
  const paths = obj?.paths || {};
  for (const [pathName, methods] of Object.entries(paths)) {
    for (const [method, spec] of Object.entries(methods || {})) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(method.toLowerCase())) continue;
      ops.push({
        kind: 'rest',
        source: 'openapi',
        method: method.toUpperCase(),
        path: normalizeContractPath(pathName),
        canonicalPath: canonicalPath(pathName),
        operationId: spec?.operationId || null,
        file: filePath,
      });
    }
  }
  return ops;
}

function parseOpenApiDocument(content, filePath) {
  try {
    const parsed = filePath.toLowerCase().endsWith('.json') ? JSON.parse(content) : YAML.parse(content);
    return extractOpenApiOperationsFromObject(parsed, filePath);
  } catch {
    return [];
  }
}

function extractGraphqlSchemaOperations(content, filePath) {
  const ops = [];
  const rootBlocks = [
    ['Query', /type\s+Query\s*\{([\s\S]*?)\}/i],
    ['Mutation', /type\s+Mutation\s*\{([\s\S]*?)\}/i],
  ];
  for (const [root, re] of rootBlocks) {
    const m = content.match(re);
    if (!m) continue;
    const block = m[1];
    const fields = block.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('"""'))
      .map(line => line.replace(/\s*\([^)]*\)\s*:\s*.+$/, '').replace(/:\s*.+$/, '').trim())
      .filter(Boolean);
    for (const field of fields) {
      ops.push({ kind: 'graphql', root, name: field, file: filePath, source: 'schema' });
    }
  }
  return ops;
}

function extractGraphqlResolverOperations(content, filePath) {
  const ops = [];
  const resolverBlockRe = /(Query|Mutation)\s*:\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = resolverBlockRe.exec(content)) !== null) {
    const root = m[1];
    const block = m[2];
    for (const fn of block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      ops.push({ kind: 'graphql', root, name: fn[1], file: filePath, source: 'resolver' });
    }
  }

  const decoratorMatches = [...content.matchAll(/@(Query|Mutation)\s*\(\s*(?:['"`]([A-Za-z_][A-Za-z0-9_]*)['"`])?/g)];
  for (const match of decoratorMatches) {
    ops.push({ kind: 'graphql', root: match[1], name: match[2] || 'unknown', file: filePath, source: 'decorator' });
  }
  return ops;
}

function joinRoutePath(base, child) {
  const b = normalizeContractPath(base);
  const c = normalizeContractPath(child);
  if (b === '/') return c;
  if (c === '/') return b;
  return normalizeContractPath(`${b}/${c}`);
}

function extractFastApiPrefixes(content) {
  const prefixes = new Map();
  for (const m of content.matchAll(/(\w+)\s*=\s*APIRouter\(\s*([^)]*)\)/g)) {
    const name = m[1];
    const args = m[2];
    const prefixMatch = args.match(/prefix\s*=\s*["'`]([^"'`]+)["'`]/);
    prefixes.set(name, prefixMatch ? prefixMatch[1] : '');
  }
  for (const m of content.matchAll(/\b\w+\.include_router\(\s*(\w+)\s*,\s*prefix\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    const routerName = m[1];
    const mountedPrefix = m[2];
    const existing = prefixes.get(routerName) || '';
    prefixes.set(routerName, joinRoutePath(existing, mountedPrefix));
  }
  return prefixes;
}

function extractGoPrefixes(content) {
  const prefixes = new Map();
  for (const m of content.matchAll(/(\w+)\s*:=\s*(\w+)\.(?:Group|Route)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    const name = m[1];
    const parent = m[2];
    const rawPrefix = m[3];
    const basePrefix = prefixes.get(parent) || '';
    prefixes.set(name, joinRoutePath(basePrefix, rawPrefix));
  }
  return prefixes;
}

function extractRestEndpoints(content, filePath) {
  const endpoints = [];
  const push = (method, pathValue, extra = {}) => {
    if (!pathValue) return;
    endpoints.push({
      kind: 'rest',
      method,
      path: normalizeContractPath(pathValue),
      canonicalPath: canonicalPath(pathValue),
      file: filePath,
      ...extra,
    });
  };

  if (/\.(java|kt)$/.test(filePath.toLowerCase())) {
    const classBase = [...content.matchAll(/@(RequestMapping|Path)\s*\(\s*(?:path\s*=\s*)?["'`]([^"'`]+)["'`]/g)].map(m => m[2]).pop() || '';
    for (const m of content.matchAll(/@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:path\s*=\s*|value\s*=\s*)?(["'`])([^"'`]+)\2?/g)) {
      const ann = m[1];
      const pathValue = `${classBase}${m[3] || ''}`;
      const method = ({
        GetMapping: 'GET',
        PostMapping: 'POST',
        PutMapping: 'PUT',
        PatchMapping: 'PATCH',
        DeleteMapping: 'DELETE',
        RequestMapping: 'ANY',
      })[ann] || 'ANY';
      push(method, pathValue, { source: 'annotation' });
    }
    for (const m of content.matchAll(/@(GET|POST|PUT|PATCH|DELETE)\b[^\n]*\n[^\n]*@?Path\s*\(\s*(["'`])([^"'`]+)\2/g)) {
      push(m[1], `${classBase}${m[3]}`, { source: 'jax-rs' });
    }
  }

  if (/\.(py)$/.test(filePath.toLowerCase())) {
    const fastapiPrefixes = extractFastApiPrefixes(content);
    for (const m of content.matchAll(/@(\w+)\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\3/g)) {
      const routerName = m[1];
      const prefix = fastapiPrefixes.get(routerName) || '';
      push(m[2].toUpperCase(), joinRoutePath(prefix, m[4]), { source: 'decorator', router: routerName });
    }
    for (const m of content.matchAll(/@app\.route\s*\(\s*(["'`])([^"'`]+)\1\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?/g)) {
      const methods = m[3] ? [...m[3].matchAll(/['"`]([A-Z]+)['"`]/g)].map(x => x[1]) : ['ANY'];
      for (const method of methods) push(method, m[2], { source: 'route' });
    }
  }

  if (/\.(js|ts|jsx|tsx)$/.test(filePath.toLowerCase())) {
    for (const m of content.matchAll(/\b(?:app|router|fastify)\.(get|post|put|patch|delete|options|head)\s*\(\s*(["'`])([^"'`]+)\2/g)) {
      push(m[1].toUpperCase(), m[3], { source: 'router' });
    }
    for (const m of content.matchAll(/\b(?:app|router|fastify)\.route\s*\(\s*\{\s*method\s*:\s*(["'`])?(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\1?\s*,\s*(?:url|path)\s*:\s*(["'`])([^"'`]+)\3/gmi)) {
      push(m[2].toUpperCase(), m[4], { source: 'route-object' });
    }
    for (const m of content.matchAll(/@(Get|Post|Put|Patch|Delete|All)\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)) {
      const method = ({ Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', All: 'ANY' })[m[1]] || 'ANY';
      push(method, m[2] || '', { source: 'decorator' });
    }
    for (const m of content.matchAll(/@Controller\s*\(\s*(?:["'`]([^"'`]+)["'`])?\s*\)/g)) {
      const base = m[1] || '';
      if (base) endpoints.push({ kind: 'rest', method: 'BASE', path: normalizeContractPath(base), canonicalPath: canonicalPath(base), file: filePath, source: 'controller' });
    }
  }

  if (/\.(go)$/.test(filePath.toLowerCase())) {
    const goPrefixes = extractGoPrefixes(content);
    for (const m of content.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)\s*\(\s*(["'`])([^"'`]+)\3/g)) {
      const receiver = m[1];
      const prefix = goPrefixes.get(receiver) || '';
      push(m[2].toUpperCase(), joinRoutePath(prefix, m[4]), { source: 'go-router', receiver });
    }
    for (const m of content.matchAll(/\b(\w+)\.HandleFunc\s*\(\s*(["'`])([^"'`]+)\2/gi)) {
      const receiver = m[1];
      const prefix = goPrefixes.get(receiver) || '';
      const methodMatches = [...content.slice(m.index, m.index + 180).matchAll(/Methods\s*\(\s*([^)]+)\)/i)];
      const methods = methodMatches.length
        ? [...methodMatches[0][1].matchAll(/["'`]([A-Z]+)["'`]/g)].map(x => x[1])
        : ['ANY'];
      for (const method of methods) push(method.toUpperCase(), joinRoutePath(prefix, m[3]), { source: 'go-handlefunc', receiver });
    }
  }

  return endpoints;
}

function buildEndpointKey(endpoint) {
  return `${endpoint.method || 'ANY'} ${endpoint.canonicalPath || canonicalPath(endpoint.path)}`;
}

function compareEndpointSurfaces(codeEndpoints, contractEndpoints) {
  const findings = [];
  const codeMap = new Map();
  const contractMap = new Map();

  for (const ep of codeEndpoints) {
    const key = buildEndpointKey(ep);
    if (!codeMap.has(key)) codeMap.set(key, []);
    codeMap.get(key).push(ep);
  }

  for (const ep of contractEndpoints) {
    const key = buildEndpointKey(ep);
    if (!contractMap.has(key)) contractMap.set(key, []);
    contractMap.get(key).push(ep);
  }

  for (const [key, endpoints] of codeMap.entries()) {
    const [method, ...pathParts] = key.split(' ');
    const pathKey = pathParts.join(' ');
    const anyKey = `ANY ${pathKey}`;
    if (contractMap.has(key) || contractMap.has(anyKey)) continue;
    const sample = endpoints[0];
    findings.push({
      id: 'API100',
      severity: 'high',
      category: 'api-contract',
      name: 'Endpoint missing contract',
      description: `Code exposes ${sample.method} ${sample.path} but no matching contract entry was found.`,
      file: sample.file,
      currentCode: `${sample.method} ${sample.path}`,
      fix: `Add the matching contract entry for ${sample.method} ${sample.path} in OpenAPI or GraphQL schema.`,
      explanation: 'Keeping the contract in sync with the implementation prevents undocumented or drifting API behavior.',
    });
  }

  for (const [key, endpoints] of contractMap.entries()) {
    const [method, ...pathParts] = key.split(' ');
    const pathKey = pathParts.join(' ');
    const anyKey = `ANY ${pathKey}`;
    if (codeMap.has(key) || codeMap.has(anyKey)) continue;
    const sample = endpoints[0];
    findings.push({
      id: 'API101',
      severity: 'medium',
      category: 'api-contract',
      name: 'Contract endpoint not implemented',
      description: `Contract declares ${sample.method} ${sample.path} but no matching code route/resolver was found.`,
      file: sample.file,
      currentCode: `${sample.method} ${sample.path}`,
      fix: `Implement ${sample.method} ${sample.path} or remove the stale contract entry.`,
      explanation: 'Stale contract entries confuse consumers and cause broken generated clients or docs.',
    });
  }

  return findings;
}

function compareGraphqlSurfaces(codeOps, schemaOps) {
  const findings = [];
  const codeMap = new Map();
  const schemaMap = new Map();

  for (const op of codeOps) {
    const key = `${op.root}:${op.name}`;
    if (!codeMap.has(key)) codeMap.set(key, []);
    codeMap.get(key).push(op);
  }
  for (const op of schemaOps) {
    const key = `${op.root}:${op.name}`;
    if (!schemaMap.has(key)) schemaMap.set(key, []);
    schemaMap.get(key).push(op);
  }

  for (const [key, ops] of codeMap.entries()) {
    if (schemaMap.has(key)) continue;
    const sample = ops[0];
    findings.push({
      id: 'GQL100',
      severity: 'high',
      category: 'api-contract',
      name: 'GraphQL resolver missing schema field',
      description: `Resolver exposes ${sample.root}.${sample.name} but the schema does not declare that field.`,
      file: sample.file,
      currentCode: `${sample.root}.${sample.name}`,
      fix: `Add ${sample.root}.${sample.name} to the GraphQL schema.`,
      explanation: 'Schema and resolver names must stay aligned or clients will never be able to call the resolver through the API contract.',
    });
  }

  for (const [key, ops] of schemaMap.entries()) {
    if (codeMap.has(key)) continue;
    const sample = ops[0];
    findings.push({
      id: 'GQL101',
      severity: 'medium',
      category: 'api-contract',
      name: 'GraphQL schema field missing resolver',
      description: `Schema declares ${sample.root}.${sample.name} but no matching resolver was found in code.`,
      file: sample.file,
      currentCode: `${sample.root}.${sample.name}`,
      fix: `Implement a resolver for ${sample.root}.${sample.name} or remove the schema field if it is obsolete.`,
      explanation: 'Unimplemented schema fields cause runtime failures or dead API surface.',
    });
  }

  return findings;
}

export async function validateApiContracts(projectPath = '.') {
  const abs = resolve(projectPath);
  const contractListing = await listFiles(abs, '**/*.{yml,yaml,json,graphql,gql,proto}', { maxResults: 200 });
  const sourceListing = await listFiles(abs, '**/*.{js,ts,jsx,tsx,py,java,kt}', { maxResults: 400 });
  const files = (contractListing.files || []).filter(f => f.type === 'file');
  const sourceFiles = (sourceListing.files || []).filter(f => f.type === 'file');
  const contractFiles = extractApiContractFiles(abs, files);
  const findings = [];
  const suggestions = [];
  const restContracts = [];
  const graphqlSchemaOps = [];
  const graphqlResolverOps = [];
  const sourceRestEndpoints = [];

  for (const f of contractFiles) {
    const filePath = join(abs, f.path);
    const result = readFile(filePath);
    if (result.error) continue;
    const content = result.content;
    const name = basename(filePath).toLowerCase();
    if (/\.(graphql|gql)$/.test(name) || /schema/.test(name) && /graphql/i.test(content)) {
      findings.push(...validateGraphqlContent(filePath, content));
      graphqlSchemaOps.push(...extractGraphqlSchemaOperations(content, filePath));
    } else if (/resolver|schema|graphql/i.test(name) || /type\s+(Query|Mutation)\b/i.test(content)) {
      graphqlSchemaOps.push(...extractGraphqlSchemaOperations(content, filePath));
    } else if (/openapi|swagger|postman|api/i.test(name) || /^\s*openapi\s*:/m.test(content) || /^\s*swagger\s*:/m.test(content)) {
      findings.push(...validateOpenApiContent(filePath, content));
      restContracts.push(...parseOpenApiDocument(content, filePath));
    }
  }

  for (const f of sourceFiles) {
    const filePath = join(abs, f.path);
    const result = readFile(filePath);
    if (result.error) continue;
    const content = result.content;
    const endpoints = extractRestEndpoints(content, filePath);
    sourceRestEndpoints.push(...endpoints.filter(ep => ep.method !== 'BASE'));
    graphqlResolverOps.push(...extractGraphqlResolverOperations(content, filePath));
  }

  findings.push(...compareEndpointSurfaces(sourceRestEndpoints, restContracts));
  findings.push(...compareGraphqlSurfaces(graphqlResolverOps, graphqlSchemaOps));

  const projectInfo = await import('./code.js').then(m => m.analyzeProject(abs)).catch(() => null);
  const backendSignals = hasApiBackendSignals([
    projectInfo?.frameworks?.join(' '),
    projectInfo?.readme || '',
    projectInfo?.git || '',
  ].join('\n'));

  if (backendSignals && contractFiles.length === 0) {
    suggestions.push('Add an OpenAPI/Swagger or GraphQL schema contract for the API surface.');
    suggestions.push('Keep REST/GraphQL contracts versioned and review them together with code changes.');
  }

  return {
    projectPath: abs,
    contractFiles: contractFiles.map(f => f.path),
    sourceEndpoints: sourceRestEndpoints,
    contractEndpoints: restContracts,
    graphqlSchemaOps,
    graphqlResolverOps,
    findings,
    suggestions,
  };
}

// ── Project-level review ──────────────────────────────────────────────────────

export async function reviewProject(projectPath = '.', { llm = true, maxFiles = 20, filePattern } = {}) {
  const abs = resolve(projectPath);
  printTool(`Project review: ${abs}`);

  const pattern = filePattern || '**/*.{js,ts,jsx,tsx,py,swift,kt,dart,go,java,rs,rb}';
  const listed = await listFiles(abs, pattern, { maxResults: 200 });
  const sourceFiles = (listed.files || []).filter(f => f.type === 'file').slice(0, maxFiles);

  printTool(`Reviewing ${sourceFiles.length} files...`);
  const fileReviews = [];
  let totalFindings = 0;

  for (const f of sourceFiles) {
    const fabs = join(abs, f.path);
    const review = await reviewFile(fabs, { llm, contextInfo: `Part of project at ${abs}` });
    if (!review.error) {
      fileReviews.push(review);
      totalFindings += review.findingCount;
    }
  }

  const apiContracts = await validateApiContracts(abs);
  const apiContractGrade = gradeFromFindings(apiContracts.findings || []);

  // Sort by risk (grade + findings)
  fileReviews.sort((a, b) => {
    const gradeOrder = { F: 0, D: 1, C: 2, B: 3, A: 4, '?': 5 };
    return (gradeOrder[a.grade] || 5) - (gradeOrder[b.grade] || 5);
  });

  const overallGrade = worseGrade(computeOverallGrade(fileReviews), apiContractGrade);

  return {
    projectPath: abs,
    filesReviewed: fileReviews.length,
    totalFindings,
    overallGrade,
    criticals: fileReviews.reduce((s, r) => s + r.criticals, 0),
    highs: fileReviews.reduce((s, r) => s + r.highs, 0),
    files: fileReviews,
    apiContractGrade,
    apiContractFindings: apiContracts.findings || [],
    apiContractSuggestions: apiContracts.suggestions || [],
    apiContractFiles: apiContracts.contractFiles || [],
  };
}

function computeOverallGrade(reviews) {
  if (!reviews.length) return 'A';
  const scores = reviews.map(r => ({ F: 100, D: 60, C: 30, B: 10, A: 0, '?': 20 }[r.grade] || 20));
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return avg < 5 ? 'A' : avg < 15 ? 'B' : avg < 40 ? 'C' : avg < 70 ? 'D' : 'F';
}

// ── Diff-aware review (only changed code) ────────────────────────────────────

export async function reviewDiff(projectPath = '.', { staged = false, llm = true } = {}) {
  const abs = resolve(projectPath);
  printTool(`Reviewing git diff: ${abs}`);

  const diffResult = await gitDiff(abs, { staged });
  if (diffResult.error) return { error: diffResult.error };

  const { diff } = diffResult;
  if (!diff || diff.trim().length < 10) return { message: 'No changes to review', diff: '' };

  // Parse changed files from diff
  const changedFiles = [];
  const fileRe = /^\+\+\+ b\/(.+)$/gm;
  let m;
  while ((m = fileRe.exec(diff)) !== null) changedFiles.push(m[1]);

  // Review each changed file
  const fileReviews = [];
  for (const f of changedFiles.slice(0, 15)) {
    const fabs = join(abs, f);
    if (!existsSync(fabs)) continue;
    const review = await reviewFile(fabs, { llm, contextInfo: `This file has uncommitted changes being reviewed` });
    if (!review.error) fileReviews.push({ ...review, relativePath: f });
  }

  // Also do a holistic diff review
  let diffReview = null;
  if (llm && diff.length > 100) {
    try {
      const response = await chat({
        messages: [
          { role: 'system', content: REVIEW_SYSTEM_PROMPT },
          { role: 'user', content: `Review this git diff for bugs, security issues, and code quality:\n\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\`` },
        ],
      });
      const jsonMatch = response.content.match(/\{[\s\S]+\}/);
      if (jsonMatch) diffReview = JSON.parse(jsonMatch[0]);
    } catch {}
  }

  const apiContracts = await validateApiContracts(abs);

  return {
    projectPath: abs,
    staged,
    changedFiles,
    fileReviews,
    diffReview,
    diff: diff.slice(0, 3000),
    apiContractFindings: apiContracts.findings || [],
    apiContractSuggestions: apiContracts.suggestions || [],
    apiContractFiles: apiContracts.contractFiles || [],
  };
}

// ── Apply a fix from review ───────────────────────────────────────────────────

export async function applyFix(filePath, finding) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return { error: `File not found: ${filePath}` };
  if (!finding.currentCode || !finding.fix) return { error: 'Finding has no fix to apply' };

  let content = readFileSync(abs, 'utf8');
  if (!content.includes(finding.currentCode)) {
    return { error: 'Could not find the exact code to replace — it may have changed', finding };
  }

  content = content.replace(finding.currentCode, finding.fix);
  writeFileSync(abs, content, 'utf8');
  return { applied: true, file: abs, finding: finding.name };
}

// ── Render review report ──────────────────────────────────────────────────────

export function renderReviewReport(review, { compact = false } = {}) {
  const lines = [];
  const gradeColor = { A: chalk.green, B: chalk.greenBright, C: chalk.yellow, D: chalk.red, F: chalk.bold.red }[review.grade] || chalk.white;
  const sevColor = { critical: chalk.bold.red, high: chalk.red, medium: chalk.yellow, low: chalk.gray, info: chalk.blue };

  lines.push('');
  lines.push(chalk.bold(`📋 Code Review: ${review.file || review.projectPath}`));
  lines.push(`   Grade: ${gradeColor(`  ${review.grade}  `)}  |  Findings: ${review.findingCount}  |  ${chalk.red(review.criticals + ' critical')}  ${chalk.yellow(review.highs + ' high')}`);
  if (review.summary) lines.push(chalk.italic.gray(`   ${review.summary}`));
  lines.push('');

  if (review.findings?.length) {
    lines.push(chalk.bold('Findings:'));
    lines.push('─'.repeat(70));

    for (const f of review.findings) {
      const sev = sevColor[f.severity] || chalk.white;
      lines.push(`\n  ${sev(`[${f.severity.toUpperCase()}]`)} ${chalk.bold(f.name)}  ${chalk.gray(`(${f.category})`)}  ${f.line ? chalk.gray(`line ${f.line}`) : ''}`);
      if (f.description) lines.push(`  ${chalk.white(f.description)}`);
      if (f.code || f.currentCode) {
        lines.push(chalk.gray('  Current:'));
        lines.push(chalk.red(`    ${(f.code || f.currentCode || '').split('\n').join('\n    ')}`));
      }
      if (f.fix) {
        lines.push(chalk.gray('  Fix:'));
        lines.push(chalk.green(`    ${f.fix.split('\n').slice(0, 5).join('\n    ')}`));
      }
      if (f.tip && !f.description) lines.push(chalk.gray(`  → ${f.tip}`));
      if (f.explanation) lines.push(chalk.gray(`  Why: ${f.explanation}`));
    }
  }

  if (review.positives?.length) {
    lines.push('\n' + chalk.bold.green('✓ What this code does well:'));
    for (const p of review.positives) lines.push(chalk.green(`  • ${p}`));
  }

  if (review.suggestions?.length) {
    lines.push('\n' + chalk.bold.cyan('💡 Broader suggestions:'));
    for (const s of review.suggestions) lines.push(chalk.cyan(`  • ${s}`));
  }

  if (review.apiContractFindings?.length) {
    lines.push('\n' + chalk.bold.magenta('🧩 API contract findings:'));
    for (const f of review.apiContractFindings) {
      const sev = sevColor[f.severity] || chalk.white;
      lines.push(`  ${sev(`[${(f.severity || 'info').toUpperCase()}]`)} ${chalk.bold(f.name)}`);
      if (f.description) lines.push(chalk.gray(`    ${f.description}`));
      if (f.file) lines.push(chalk.gray(`    ${f.file}`));
    }
  }

  if (review.apiContractSuggestions?.length) {
    lines.push('\n' + chalk.bold.magenta('🔎 API contract suggestions:'));
    for (const s of review.apiContractSuggestions) lines.push(chalk.magenta(`  • ${s}`));
  }

  lines.push('');
  return lines.join('\n');
}

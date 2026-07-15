// src/tools/code.js — code analysis, security scanning, test generation, project learning
import { readFileSync, existsSync } from 'fs';
import { resolve, extname, relative } from 'path';
import { listFiles, readFile } from './files.js';
import { runCommandSync } from './shell.js';
import { printTool } from '../ui.js';

// ── Security Patterns ─────────────────────────────────────────────────────────
const SEC_PATTERNS = [
  // Secrets
  { id: 'S001', sev: 'CRITICAL', name: 'Hardcoded API Key', re: /['"`](sk-|gsk_|AKIA|ghp_|xox[bp]-)[A-Za-z0-9_\-]{20,}['"`]/g },
  { id: 'S002', sev: 'CRITICAL', name: 'Hardcoded Password', re: /(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{6,}['"`]/gi },
  { id: 'S003', sev: 'HIGH',     name: 'Hardcoded Secret/Token', re: /(?:secret|token|apikey|api_key)\s*[:=]\s*['"`][A-Za-z0-9+\/=_\-]{16,}['"`]/gi },
  // Injection
  { id: 'I001', sev: 'HIGH',     name: 'SQL Injection Risk', re: /(['"`]\s*\+\s*\w+\s*\+\s*['"`].*(?:SELECT|INSERT|UPDATE|DELETE|WHERE))|(?:execute|query)\s*\(\s*[`'"].*\$\{/gi },
  { id: 'I002', sev: 'HIGH',     name: 'Command Injection Risk', re: /(?:exec|execSync|spawn|system)\s*\([^)]*\+[^)]*\)/g },
  { id: 'I003', sev: 'MEDIUM',   name: 'XSS Risk (innerHTML)', re: /innerHTML\s*=\s*[^'"`][^;]+/g },
  { id: 'I004', sev: 'MEDIUM',   name: 'eval() usage', re: /\beval\s*\(/g },
  // Crypto
  { id: 'C001', sev: 'MEDIUM',   name: 'Weak Hash (MD5/SHA1)', re: /\b(?:md5|sha1)\s*\(/gi },
  { id: 'C002', sev: 'MEDIUM',   name: 'Math.random() for crypto', re: /Math\.random\(\)/g },
  // Path traversal
  { id: 'P001', sev: 'HIGH',     name: 'Path Traversal Risk', re: /\.\.\//g },
  // Logging sensitive data
  { id: 'L001', sev: 'LOW',      name: 'Logging Sensitive Data', re: /console\.log\s*\([^)]*(?:password|token|secret|key)[^)]*\)/gi },
  // SSRF
  { id: 'R001', sev: 'MEDIUM',   name: 'Potential SSRF', re: /fetch\s*\(\s*(?:req\.|request\.|params\.|body\.)/g },
  // Prototype pollution
  { id: 'O001', sev: 'MEDIUM',   name: 'Prototype Pollution Risk', re: /__proto__|constructor\[/g },
];

export function scanSecurity(filePath) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) return { error: `File not found: ${filePath}` };
  let content;
  try { content = readFileSync(absPath, 'utf8'); } catch (e) { return { error: e.message }; }

  const findings = [];
  for (const pattern of SEC_PATTERNS) {
    const matches = [...content.matchAll(pattern.re)];
    for (const match of matches) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      const lineText = content.split('\n')[lineNum - 1] || '';
      // P001 false-positive filter: dot-dot-slash inside import/require/URL
      // statements is a module path, not user-controlled path traversal
      if (pattern.id === 'P001' && /(^\s*(import|export)\b|import\s*\(|require\s*\(|new URL\s*\(|from\s+['"])/.test(lineText)) continue;
      findings.push({
        id: pattern.id,
        severity: pattern.sev,
        name: pattern.name,
        line: lineNum,
        match: match[0].slice(0, 100),
        file: filePath,
      });
    }
  }

  const score = findings.reduce((s, f) => {
    return s + ({ CRITICAL: 40, HIGH: 20, MEDIUM: 10, LOW: 5 }[f.severity] || 0);
  }, 0);

  return {
    file: filePath,
    findings,
    findingCount: findings.length,
    riskScore: score,
    grade: score === 0 ? 'A' : score < 10 ? 'B' : score < 30 ? 'C' : score < 60 ? 'D' : 'F',
  };
}

export async function scanSecurityProject(projectPath = '.') {
  printTool(`Security scan: ${projectPath}`);
  const listed = await listFiles(projectPath, '**/*.{js,ts,jsx,tsx,py,go,rb,java,php,cs,sh}', { maxResults: 500 });
  const allFindings = [];
  let filesScanned = 0;

  for (const f of (listed.files || []).slice(0, 200)) {
    if (f.type === 'file') {
      const result = scanSecurity(resolve(projectPath, f.path));
      if (result.findings && result.findings.length > 0) {
        allFindings.push(...result.findings);
      }
      filesScanned++;
    }
  }

  const byFile = {};
  for (const f of allFindings) {
    if (!byFile[f.file]) byFile[f.file] = [];
    byFile[f.file].push(f);
  }

  return {
    projectPath,
    filesScanned,
    totalFindings: allFindings.length,
    criticals: allFindings.filter(f => f.severity === 'CRITICAL').length,
    highs: allFindings.filter(f => f.severity === 'HIGH').length,
    byFile,
  };
}

// ── Dependency scanning ───────────────────────────────────────────────────────
export async function scanDependencies(projectPath = '.') {
  printTool(`Dependency audit: ${projectPath}`);
  const results = {};

  // npm audit
  if (existsSync(resolve(projectPath, 'package.json'))) {
    const r = await runCommandSync('npm audit --json 2>/dev/null', projectPath);
    try { results.npm = JSON.parse(r.stdout); } catch { results.npm = { error: 'parse failed', raw: r.stdout.slice(0, 500) }; }
  }

  // pip audit (if installed)
  if (existsSync(resolve(projectPath, 'requirements.txt'))) {
    const r = await runCommandSync('pip-audit --format=json 2>/dev/null || echo "{}"', projectPath);
    try { results.pip = JSON.parse(r.stdout); } catch { results.pip = { note: 'pip-audit not installed' }; }
  }

  return results;
}

// ── Code analysis ─────────────────────────────────────────────────────────────
export async function analyzeProject(projectPath = '.') {
  printTool(`Analyzing project: ${projectPath}`);
  const absPath = resolve(projectPath);
  const info = { path: absPath, structure: {}, stats: {}, languages: {}, frameworks: [], config: {} };

  // Language detection via file extensions
  const fileList = await listFiles(absPath, '**/*', { maxResults: 1000 });
  const extCounts = {};
  for (const f of fileList.files || []) {
    if (f.type === 'file') {
      const ext = extname(f.path).toLowerCase();
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    }
  }
  info.stats = { fileCount: fileList.count, extensionCounts: extCounts };
  info.languages = detectLanguages(extCounts);

  // Framework detection
  info.frameworks = detectFrameworks(absPath);

  // Key config files
  const configFiles = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'tsconfig.json', 'Dockerfile', 'docker-compose.yml', '.github/workflows'];
  for (const cf of configFiles) {
    if (existsSync(resolve(absPath, cf))) {
      info.config[cf] = true;
    }
  }

  // Git info
  const gitR = await runCommandSync('git log --oneline -5 2>/dev/null && echo "---" && git remote -v 2>/dev/null', absPath);
  info.git = gitR.stdout || 'not a git repo';

  // README summary
  const readmePath = resolve(absPath, 'README.md');
  if (existsSync(readmePath)) {
    const content = readFileSync(readmePath, 'utf8');
    info.readme = content.slice(0, 2000);
  }

  return info;
}

function detectLanguages(extCounts) {
  const langMap = {
    '.js': 'JavaScript', '.ts': 'TypeScript', '.jsx': 'JavaScript(React)', '.tsx': 'TypeScript(React)',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
    '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.c': 'C',
    '.swift': 'Swift', '.r': 'R', '.scala': 'Scala',
  };
  const langs = {};
  for (const [ext, count] of Object.entries(extCounts)) {
    if (langMap[ext]) langs[langMap[ext]] = (langs[langMap[ext]] || 0) + count;
  }
  return langs;
}

function detectFrameworks(absPath) {
  const frameworks = [];
  const checks = [
    ['package.json', pkg => {
      try {
        const p = JSON.parse(readFileSync(resolve(absPath, 'package.json'), 'utf8'));
        const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
        if (deps.react) frameworks.push('React');
        if (deps.next) frameworks.push('Next.js');
        if (deps.vue) frameworks.push('Vue.js');
        if (deps.svelte) frameworks.push('Svelte');
        if (deps.angular) frameworks.push('Angular');
        if (deps.express) frameworks.push('Express');
        if (deps.fastify) frameworks.push('Fastify');
        if (deps.nestjs || deps['@nestjs/core']) frameworks.push('NestJS');
        if (deps.prisma || deps['@prisma/client']) frameworks.push('Prisma');
        if (deps.graphql) frameworks.push('GraphQL');
        if (deps['selenium-webdriver'] || deps.webdriverio || deps['@wdio/cli']) frameworks.push('Selenium');
        if (deps.appium || deps['@wdio/appium-service'] || deps['appium-uiautomator2-driver'] || deps['appium-xcuitest-driver']) frameworks.push('Appium');
      } catch {}
    }],
    ['requirements.txt', () => {
      try {
        const txt = readFileSync(resolve(absPath, 'requirements.txt'), 'utf8');
        if (/django/i.test(txt)) frameworks.push('Django');
        if (/flask/i.test(txt)) frameworks.push('Flask');
        if (/fastapi/i.test(txt)) frameworks.push('FastAPI');
        if (/pytorch|torch/i.test(txt)) frameworks.push('PyTorch');
        if (/tensorflow/i.test(txt)) frameworks.push('TensorFlow');
        if (/langchain/i.test(txt)) frameworks.push('LangChain');
        if (/selenium/i.test(txt)) frameworks.push('Selenium');
        if (/appium/i.test(txt)) frameworks.push('Appium');
      } catch {}
    }],
    ['pyproject.toml', () => {
      try {
        const txt = readFileSync(resolve(absPath, 'pyproject.toml'), 'utf8');
        if (/flask/i.test(txt)) frameworks.push('Flask');
        if (/fastapi/i.test(txt)) frameworks.push('FastAPI');
        if (/django/i.test(txt)) frameworks.push('Django');
        if (/selenium/i.test(txt)) frameworks.push('Selenium');
        if (/appium/i.test(txt)) frameworks.push('Appium');
      } catch {}
    }],
    ['pom.xml', () => {
      try {
        const txt = readFileSync(resolve(absPath, 'pom.xml'), 'utf8');
        if (/spring-boot|spring-webmvc|spring-web|spring-graphql/i.test(txt)) frameworks.push('Spring Boot');
        if (/graphql-java|spring-graphql|apollo/i.test(txt)) frameworks.push('GraphQL');
        if (/jax-rs|jakarta\.ws|resteasy|jersey/i.test(txt)) frameworks.push('REST API');
        if (/selenium/i.test(txt)) frameworks.push('Selenium');
        if (/appium/i.test(txt)) frameworks.push('Appium');
      } catch {}
    }],
    ['build.gradle', () => {
      try {
        const txt = readFileSync(resolve(absPath, 'build.gradle'), 'utf8');
        if (/spring-boot|spring-webmvc|spring-web|spring-graphql/i.test(txt)) frameworks.push('Spring Boot');
        if (/graphql-java|spring-graphql|apollo/i.test(txt)) frameworks.push('GraphQL');
        if (/jax-rs|jakarta\.ws|resteasy|jersey/i.test(txt)) frameworks.push('REST API');
        if (/selenium/i.test(txt)) frameworks.push('Selenium');
        if (/appium/i.test(txt)) frameworks.push('Appium');
      } catch {}
    }],
    ['build.gradle.kts', () => {
      try {
        const txt = readFileSync(resolve(absPath, 'build.gradle.kts'), 'utf8');
        if (/spring-boot|spring-webmvc|spring-web|spring-graphql/i.test(txt)) frameworks.push('Spring Boot');
        if (/graphql-java|spring-graphql|apollo/i.test(txt)) frameworks.push('GraphQL');
        if (/jax-rs|jakarta\.ws|resteasy|jersey/i.test(txt)) frameworks.push('REST API');
        if (/selenium/i.test(txt)) frameworks.push('Selenium');
        if (/appium/i.test(txt)) frameworks.push('Appium');
      } catch {}
    }],
  ];
  for (const [file, checker] of checks) {
    if (existsSync(resolve(absPath, file))) checker();
  }
  return frameworks;
}

// ── Test generation (stubs) ───────────────────────────────────────────────────
export async function generateTestStubs(filePath, { framework = 'auto' } = {}) {
  const result = readFile(filePath);
  if (result.error) return result;

  const ext = extname(filePath);
  const isTS = ext === '.ts' || ext === '.tsx';
  const isPy = ext === '.py';

  // Extract function/class names with simple regex
  const fnRe = isTS || ext === '.js' || ext === '.jsx' || ext === '.tsx'
    ? /(?:export\s+(?:async\s+)?function|const\s+\w+\s*=\s*(?:async\s*)?\(|export\s+class)\s+(\w+)/g
    : /^(?:def|class)\s+(\w+)/gm;

  const names = [...result.content.matchAll(fnRe)].map(m => m[1]).filter(Boolean);

  if (isPy) {
    const fw = framework === 'auto' ? 'pytest' : framework;
    const stubs = names.map(name => `
def test_${name}_basic():
    """Test ${name} basic functionality"""
    # Arrange
    # Act
    # result = ${name}(...)
    # Assert
    # assert result == expected
    raise NotImplementedError("TODO: implement test for ${name}")`).join('\n');
    return { file: filePath, framework: fw, stubs: `import pytest\nfrom ${relative('.', filePath).replace(/\//g, '.').replace(/\.py$/, '')} import *\n${stubs}`, names };
  }

  const fw = framework === 'auto' ? (isTS ? 'vitest' : 'jest') : framework;
  const importLine = isTS ? `import { ${names.join(', ')} } from './${relative('.', filePath).replace(/\.[^.]+$/, '')}';` : `const { ${names.join(', ')} } = require('./${relative('.', filePath).replace(/\.[^.]+$/, '')}');`;
  const tests = names.map(name => `
  describe('${name}', () => {
    it('should work correctly', () => {
      // Arrange
      // Act
      // const result = ${name}(...)
      // Assert
      // expect(result).toBe(expected)
      throw new Error('TODO: implement test for ${name}')
    })
  })`).join('\n');

  return {
    file: filePath,
    framework: fw,
    stubs: `${importLine}\n\ndescribe('${filePath}', () => {${tests}\n})`,
    names,
  };
}

// ── Performance analysis ──────────────────────────────────────────────────────
export function analyzePerformance(filePath) {
  const result = readFile(filePath);
  if (result.error) return result;
  const content = result.content;
  const issues = [];

  // Nested loops
  const nestedLoop = /for\s*\([\s\S]{0,200}for\s*\(/g;
  if (nestedLoop.test(content)) issues.push({ type: 'O(n²)', detail: 'Nested loop detected — may cause quadratic complexity' });

  // N+1 query patterns
  if (/\.forEach[\s\S]{0,100}(?:await|fetch|query|find)/g.test(content)) {
    issues.push({ type: 'N+1', detail: 'Possible N+1 query in loop — consider batching' });
  }

  // Memory leak patterns
  if (/setInterval|setTimeout/.test(content) && !/clearInterval|clearTimeout/.test(content)) {
    issues.push({ type: 'MemoryLeak', detail: 'Timer without cleanup — potential memory leak' });
  }

  // Large array operations
  if (/\.map\([\s\S]{0,200}\)\.filter\(|\.filter\([\s\S]{0,200}\)\.map\(/g.test(content)) {
    issues.push({ type: 'ChainedOps', detail: 'Chained map+filter — consider single .reduce() or .flatMap()' });
  }

  return { file: filePath, performanceIssues: issues, count: issues.length };
}

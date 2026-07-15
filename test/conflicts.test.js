// Endpoint conflict + race condition detection tests — offline-safe
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractEndpoints, checkEndpointConflicts, checkRaceConditions, postEditGuard } from '../src/tools/conflicts.js';

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-conf-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel, content) {
  const fp = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  return fp;
}

describe('extractEndpoints', () => {
  it('parses express routes and normalizes params', () => {
    const eps = extractEndpoints(`app.get('/users/:id', handler);\nrouter.post("/orders", h2);`, 'a.js');
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ method: 'GET', route: '/users/:param' });
    expect(eps[1]).toMatchObject({ method: 'POST', route: '/orders' });
  });

  it('parses Spring mappings with class-level base path', () => {
    const java = `@RequestMapping("/api/users")\npublic class UserController {\n  @GetMapping("/{id}")\n  public User get() {}\n  @PostMapping\n  public User create() {}\n}`;
    const eps = extractEndpoints(java, 'UserController.java');
    expect(eps.map(e => `${e.method} ${e.route}`)).toEqual(['GET /api/users/:param', 'POST /api/users']);
  });

  it('parses NestJS controllers', () => {
    const ts = `@Controller('cats')\nclass C {\n  @Get(':id')\n  find() {}\n}`;
    const eps = extractEndpoints(ts, 'cats.controller.ts');
    expect(eps[0]).toMatchObject({ method: 'GET', route: '/cats/:param' });
  });

  it('parses flask routes', () => {
    const py = `@app.route('/items/<int:item_id>', methods=['DELETE'])\ndef delete_item(item_id): pass`;
    const eps = extractEndpoints(py, 'app.py');
    expect(eps[0]).toMatchObject({ method: 'DELETE', route: '/items/:param' });
  });
});

describe('checkEndpointConflicts', () => {
  it('flags the same route handled in two different files as HIGH', () => {
    write('src/routesA.js', `app.get('/api/users/:id', a);`);
    write('src/routesB.js', `router.get('/api/users/:userId', b);`);
    const res = checkEndpointConflicts({ path: tmp });
    const hit = res.conflicts.find(c => c.endpoint === 'GET /api/users/:param');
    expect(hit).toBeTruthy();
    expect(hit.severity).toBe('HIGH');
    expect(hit.crossFile).toBe(true);
    expect(res.userPrompt).toContain('endpoint conflict');
  });

  it('is clean for distinct routes', () => {
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-conf2-'));
    fs.writeFileSync(path.join(t2, 'r.js'), `app.get('/a', x);\napp.post('/a', y);\napp.get('/b', z);`);
    const res = checkEndpointConflicts({ path: t2 });
    expect(res.clean).toBe(true);
    fs.rmSync(t2, { recursive: true, force: true });
  });

  it('flags catch-all overlapping a specific method', () => {
    const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-conf3-'));
    fs.writeFileSync(path.join(t3, 'r.js'), `app.all('/hooks', h1);\napp.post('/hooks', h2);`);
    const res = checkEndpointConflicts({ path: t3 });
    expect(res.conflicts.some(c => c.endpoint.startsWith('ANY'))).toBe(true);
    fs.rmSync(t3, { recursive: true, force: true });
  });
});

describe('checkRaceConditions', () => {
  it('detects check-then-act TOCTOU', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-race1-'));
    fs.writeFileSync(path.join(t, 'x.js'), `if (!fs.existsSync(dir)) {\n  fs.mkdirSync(dir);\n}`);
    const res = checkRaceConditions({ path: t });
    expect(res.findings.some(f => f.id === 'R001')).toBe(true);
    fs.rmSync(t, { recursive: true, force: true });
  });

  it('detects shared mutable state mutated in async handler', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-race2-'));
    fs.writeFileSync(path.join(t, 'x.js'), `let cache = {};\nlet hits = 0;\napp.get('/x', async (req, res) => {\n  hits += 1;\n  res.json({ hits });\n});`);
    const res = checkRaceConditions({ path: t });
    expect(res.findings.some(f => f.id === 'R002' || f.id === 'R005')).toBe(true);
    expect(res.summary.total).toBeGreaterThan(0);
    fs.rmSync(t, { recursive: true, force: true });
  });

  it('detects non-atomic JSON read-modify-write', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-race3-'));
    fs.writeFileSync(path.join(t, 'x.js'), `const data = JSON.parse(fs.readFileSync(fp, 'utf8'));\ndata.count++;\nfs.writeFileSync(fp, JSON.stringify(data));`);
    const res = checkRaceConditions({ path: t });
    expect(res.findings.some(f => f.id === 'R003')).toBe(true);
    fs.rmSync(t, { recursive: true, force: true });
  });

  it('is clean for safe code', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-race4-'));
    fs.writeFileSync(path.join(t, 'x.js'), `export function add(a, b) {\n  return a + b;\n}`);
    const res = checkRaceConditions({ path: t });
    expect(res.clean).toBe(true);
    fs.rmSync(t, { recursive: true, force: true });
  });
});

describe('postEditGuard', () => {
  it('aggregates warnings and prompts for user decision', () => {
    const res = postEditGuard({ path: tmp });
    expect(res.clean).toBe(false);
    expect(res.warnings.join('\n')).toContain('ENDPOINT CONFLICTS');
  });

  it('is clean on a safe project', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'devlab-guard-'));
    fs.writeFileSync(path.join(t, 'x.js'), `app.get('/one', a);\napp.get('/two', b);`);
    const res = postEditGuard({ path: t });
    expect(res.clean).toBe(true);
    fs.rmSync(t, { recursive: true, force: true });
  });
});

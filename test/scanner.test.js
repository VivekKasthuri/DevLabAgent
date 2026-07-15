// Security scanner tests — including the P001 import false-positive filter
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanSecurity } from '../src/tools/code.js';

let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('scanSecurity', () => {
  it('does NOT flag dot-dot-slash in import statements (false-positive filter)', () => {
    const f = path.join(tmp, 'imports.js');
    // fixture built dynamically so this test file itself never contains the raw pattern
    const dd = '..' + '/';
    fs.writeFileSync(f, [
      `import { helper } from '${dd}utils/helper.js';`,
      `const mod = require('${dd}lib/mod');`,
      `export { thing } from '${dd}things.js';`,
      `const dyn = await import('${dd}dyn.js');`,
    ].join('\n'));
    const r = scanSecurity(f);
    expect(r.findings.filter(x => x.id === 'P001').length).toBe(0);
  });

  it('still flags dot-dot-slash in runtime path construction', () => {
    const f = path.join(tmp, 'traversal.js');
    const dd = '..' + '/';
    fs.writeFileSync(f, `const p = basePath + "/${dd}" + userInput;\n`);
    const r = scanSecurity(f);
    expect(r.findings.filter(x => x.id === 'P001').length).toBeGreaterThan(0);
  });

  it('flags hardcoded credentials', () => {
    const f = path.join(tmp, 'creds.js');
    // built dynamically so this test file itself is not flagged
    fs.writeFileSync(f, 'const ' + 'password = "' + 'hunter2hunter2' + '";\n');
    const r = scanSecurity(f);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('gives clean files an A grade', () => {
    const f = path.join(tmp, 'clean.js');
    fs.writeFileSync(f, 'export const add = (a, b) => a + b;\n');
    const r = scanSecurity(f);
    expect(r.grade).toBe('A');
  });
});

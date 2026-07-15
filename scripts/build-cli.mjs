#!/usr/bin/env node
// scripts/build-cli.mjs — Build standalone devlab binaries using @yao-pkg/pkg
// Usage:
//   node scripts/build-cli.mjs --target mac
//   node scripts/build-cli.mjs --target win
//   node scripts/build-cli.mjs --target linux
//   node scripts/build-cli.mjs --target all

import { execSync } from 'child_process';
import { mkdirSync, cpSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT  = join(ROOT, 'dist', 'cli');

const TARGET_MAP = {
  mac:   ['node20-macos-arm64', 'node20-macos-x64'],
  win:   ['node20-win-x64'],
  linux: ['node20-linux-x64'],
  all:   ['node20-macos-arm64', 'node20-macos-x64', 'node20-win-x64', 'node20-linux-x64'],
};

const OUTPUT_NAME = {
  'node20-macos-arm64': 'devlab-macos-arm64',
  'node20-macos-x64':   'devlab-macos-x64',
  'node20-win-x64':     'devlab-win-x64.exe',
  'node20-linux-x64':   'devlab-linux-x64',
};

const arg = process.argv.find(a => a.startsWith('--target=') || process.argv.indexOf('--target') !== -1 && process.argv[process.argv.indexOf('--target') + 1]);
const target = (process.argv.find((_, i, arr) => arr[i-1] === '--target') || 'all');
const targets = TARGET_MAP[target] || TARGET_MAP.all;

mkdirSync(OUT, { recursive: true });

// pkg needs a CommonJS-compatible entry — create a CJS shim that runs the ESM index
const shimPath = join(ROOT, '_pkg_entry.cjs');
writeFileSync(shimPath, `
// Auto-generated pkg entry shim — do not edit
// pkg cannot load ESM directly; this shim uses dynamic import()
(async () => {
  process.argv[1] = __filename; // make __filename point to the real binary
  await import('./index.js');
})().catch(e => { console.error(e); process.exit(1); });
`);

console.log(`\n  Building DevLab CLI binaries → dist/cli/\n`);

const pkg = join(ROOT, 'node_modules', '.bin', 'pkg');

for (const t of targets) {
  const outFile = join(OUT, OUTPUT_NAME[t]);
  console.log(`  → ${t}  →  ${OUTPUT_NAME[t]}`);
  try {
    execSync(
      `"${pkg}" "${shimPath}" \
        --target "${t}" \
        --output "${outFile}" \
        --config "${join(ROOT, 'package.json')}" \
        --compress GZip`,
      { stdio: 'inherit', cwd: ROOT }
    );
    console.log(`  ✓ ${OUTPUT_NAME[t]}\n`);
  } catch (e) {
    console.error(`  ✗ Failed for ${t}: ${e.message}\n`);
  }
}

// Clean up shim
try { import('fs').then(fs => fs.default.unlinkSync(shimPath)); } catch {}

console.log(`\n  Done! Binaries in: dist/cli/`);
console.log(`  macOS: dist/cli/devlab-macos-arm64`);
console.log(`  Win:   dist/cli/devlab-win-x64.exe`);
console.log(`  Linux: dist/cli/devlab-linux-x64\n`);
console.log(`  Bundle in native app:`);
console.log(`    macOS app: copy binary to DevLab.app/Contents/Resources/devlab`);
console.log(`    Windows app: copy devlab-win-x64.exe to app Resources folder\n`);

// rules.js — per-project development rules / instructions
// Discovers existing instruction files (DevLab, Copilot, Claude, Cursor, AGENTS.md,
// skills) so every project gets ITS OWN rules injected into the system prompt.
// If none exist, the agent prompts the user to share rules and saves them.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import readline from 'readline';

const MAX_RULES_CHARS = 12000; // cap injected rules per project

// Discovery order: DevLab native first, then other agents' formats
const RULE_SOURCES = [
  { path: 'DEVLAB.md', label: 'DevLab rules' },
  { path: '.devlab/rules', label: 'DevLab rules dir', dir: true, ext: '.md' },
  { path: 'AGENTS.md', label: 'AGENTS.md (open standard)' },
  { path: 'CLAUDE.md', label: 'Claude Code rules' },
  { path: '.github/copilot-instructions.md', label: 'Copilot instructions' },
  { path: '.github/instructions', label: 'Copilot instruction files', dir: true, ext: '.instructions.md' },
  { path: '.cursorrules', label: 'Cursor rules (legacy)' },
  { path: '.cursor/rules', label: 'Cursor rules dir', dir: true, ext: '.mdc' },
  { path: '.claude/skills', label: 'Claude skills', dir: true, ext: 'SKILL.md', nested: true },
];

function readCapped(file, cap) {
  try {
    const txt = readFileSync(file, 'utf8').trim();
    return txt.length > cap ? txt.slice(0, cap) + '\n…(truncated)' : txt;
  } catch { return null; }
}

/**
 * loadProjectRules(projectPath) → { found: [{source,file,chars}], content, totalChars }
 * content is ready to append to the system prompt.
 */
export function loadProjectRules(projectPath = '.') {
  const found = [];
  const parts = [];
  let budget = MAX_RULES_CHARS;

  for (const src of RULE_SOURCES) {
    if (budget <= 0) break;
    const full = join(projectPath, src.path);
    if (!existsSync(full)) continue;

    if (src.dir) {
      let files = [];
      try {
        if (src.nested) {
          // .claude/skills/<name>/SKILL.md
          for (const d of readdirSync(full)) {
            const skillFile = join(full, d, 'SKILL.md');
            if (existsSync(skillFile)) files.push(skillFile);
          }
        } else {
          files = readdirSync(full).filter(f => f.endsWith(src.ext)).map(f => join(full, f));
        }
      } catch { continue; }
      for (const f of files.slice(0, 10)) {
        const txt = readCapped(f, Math.min(budget, 3000));
        if (!txt) continue;
        found.push({ source: src.label, file: f, chars: txt.length });
        parts.push(`### ${src.label}: ${basename(f) === 'SKILL.md' ? basename(join(f, '..')) : basename(f)}\n${txt}`);
        budget -= txt.length;
      }
    } else {
      const txt = readCapped(full, budget);
      if (!txt) continue;
      found.push({ source: src.label, file: full, chars: txt.length });
      parts.push(`### ${src.label}\n${txt}`);
      budget -= txt.length;
    }
  }

  return {
    found,
    totalChars: parts.join('').length,
    content: parts.length
      ? `\n\n## PROJECT-SPECIFIC RULES (follow these strictly — they override general defaults)\n${parts.join('\n\n')}`
      : '',
  };
}

const STARTER_TEMPLATE = (projectName) => `# ${projectName} — Development Rules

<!-- DevLab reads this file on every chat in this project. Also compatible layout
     with CLAUDE.md / copilot-instructions.md conventions. -->

## Code style
- (e.g., Use 2-space indentation; prefer async/await over promises)

## Architecture
- (e.g., MVVM — ViewModels never import UIKit/SwiftUI)

## Testing
- (e.g., Every new function needs a unit test; use XCTest / Jest)

## Do NOT
- (e.g., Never commit directly to main; never hardcode API keys)

## Build & release
- (e.g., Build with: xcodebuild -scheme App; release via fastlane)
`;

/**
 * initProjectRules(projectPath, { content }) — create DEVLAB.md
 * If content given, use it; else write a starter template.
 */
export function initProjectRules(projectPath = '.', { content, from } = {}) {
  const target = join(projectPath, 'DEVLAB.md');
  if (existsSync(target)) return { error: 'DEVLAB.md already exists', file: target };

  let body = content;
  if (!body && from && existsSync(join(projectPath, from))) {
    body = readFileSync(join(projectPath, from), 'utf8'); // import from CLAUDE.md etc.
  }
  if (!body) body = STARTER_TEMPLATE(basename(projectPath) || 'Project');

  writeFileSync(target, body, 'utf8');
  return { success: true, file: target, chars: body.length };
}

let promptedProjects = new Set();

/**
 * promptForRulesIfMissing(projectPath) — interactive, TTY only, once per project per session.
 * If no rules found, asks the user to paste rules / point to a file / skip / create starter.
 */
export async function promptForRulesIfMissing(projectPath = '.') {
  const { found } = loadProjectRules(projectPath);
  if (found.length || promptedProjects.has(projectPath) || !process.stdin.isTTY) {
    return { found: found.length, prompted: false };
  }
  promptedProjects.add(projectPath);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, a => res(a.trim())));

  console.log('\n📋 No project rules found (DEVLAB.md / CLAUDE.md / copilot-instructions.md / .cursorrules).');
  console.log('   Project-specific rules make fixes & code style match YOUR conventions.\n');
  console.log('   1) Paste rules now (ends with an empty line)');
  console.log('   2) Create a starter DEVLAB.md template to fill in later');
  console.log('   3) Skip — use general defaults\n');

  const choice = await ask('Choose [1/2/3] (default 3): ');

  let result = { prompted: true, action: 'skipped' };
  if (choice === '1') {
    console.log('Paste your rules (finish with an empty line):');
    const lines = [];
    while (true) {
      const line = await ask('');
      if (!line) break;
      lines.push(line);
    }
    if (lines.length) {
      const r = initProjectRules(projectPath, { content: `# ${basename(projectPath)} — Development Rules\n\n${lines.join('\n')}\n` });
      console.log(`✅ Saved to ${r.file}`);
      result = { prompted: true, action: 'saved', file: r.file };
    }
  } else if (choice === '2') {
    const r = initProjectRules(projectPath);
    console.log(`✅ Starter template created: ${r.file} — edit it anytime.`);
    result = { prompted: true, action: 'template', file: r.file };
  }
  rl.close();
  return result;
}

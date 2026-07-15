// src/tools/shell.js — safe shell command execution
import { execSync, exec } from 'child_process';
import { resolve } from 'path';
import { AUTONOMOUS, SAFETY_MODE } from '../config.js';
import { confirm, printWarn, printTool } from '../ui.js';

// Commands that require explicit confirmation in non-autonomous mode
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bdrop\s+table\b/i,
  /\bformat\b/,
  /\bsudo\s+rm\b/,
  /\btruncate\b/i,
  />\s*\/dev\//,
  /\bkill\s+-9\b/,
  /\bchmod\s+777\b/,
  /\bcurl.*\|\s*(bash|sh)\b/,
  /\bwget.*\|\s*(bash|sh)\b/,
];

// Commands always blocked for safety
const BLOCKED_PATTERNS = [
  /\bdd\s+if=.*of=\/dev\/(s|h)d/,
  /\bmkfs\b/,
  /:\(\)\{.*\|.*:&\};:/,   // fork bomb
];

function isDestructive(command) {
  return DESTRUCTIVE_PATTERNS.some(p => p.test(command));
}

function isBlocked(command) {
  return BLOCKED_PATTERNS.some(p => p.test(command));
}

export async function runCommand(command, { cwd = process.cwd(), timeout = 30000, env = {} } = {}) {
  const absCwd = resolve(cwd);

  if (isBlocked(command)) {
    return { error: `Command blocked for safety: ${command}` };
  }

  if (SAFETY_MODE === 'strict' || (SAFETY_MODE === 'normal' && isDestructive(command))) {
    if (!AUTONOMOUS) {
      printWarn(`Potentially destructive: ${command}`);
      const ok = await confirm(`Run this command in ${absCwd}?`);
      if (!ok) return { cancelled: true, command };
    }
  }

  printTool(`$ ${command}`);

  return new Promise((resolve_) => {
    exec(command, {
      cwd: absCwd,
      timeout,
      maxBuffer: 5_000_000,
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve_({ error: `Command timed out after ${timeout}ms`, command });
        return;
      }
      resolve_({
        command,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 5000),
        exitCode: err ? err.code || 1 : 0,
        success: !err,
      });
    });
  });
}

export async function runCommandSync(command, cwd = process.cwd()) {
  try {
    const output = execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout: output, exitCode: 0, success: true };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status || 1, success: false, error: e.message };
  }
}

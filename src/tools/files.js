// src/tools/files.js — file system operations
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { resolve, relative, extname, basename, dirname, join } from 'path';
import { glob } from 'glob';
import { MAX_FILE_SIZE } from '../config.js';
import { isProtectedPath } from '../security.js';

const TEXT_EXTS = new Set([
  '.js','.ts','.jsx','.tsx','.mjs','.cjs',
  '.py','.rb','.go','.rs','.java','.kt','.swift','.c','.cpp','.h','.cs',
  '.html','.css','.scss','.less','.svelte','.vue',
  '.json','.yaml','.yml','.toml','.xml','.env','.ini','.conf',
  '.md','.txt','.sh','.bash','.zsh','.fish',
  '.sql','.graphql','.gql','.proto',
  '.dockerfile','dockerfile','.gitignore','.npmrc',
]);

function isTextFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const base = basename(filePath).toLowerCase();
  return TEXT_EXTS.has(ext) || TEXT_EXTS.has(base);
}

export function readFile(path) {
  const absPath = resolve(path);
  if (isProtectedPath(absPath)) return { error: `Access denied: ${path} is a protected credentials file.` };
  if (!existsSync(absPath)) return { error: `File not found: ${path}` };
  const stat = statSync(absPath);
  if (stat.size > MAX_FILE_SIZE) return { error: `File too large (${Math.round(stat.size/1024)}KB). Use search_files to find specific sections.` };
  if (!isTextFile(absPath)) return { error: `Binary file skipped: ${path}` };
  try {
    const content = readFileSync(absPath, 'utf8');
    const lines = content.split('\n').length;
    return { path: absPath, content, lines, size: stat.size };
  } catch (e) {
    return { error: e.message };
  }
}

export function writeFile(path, content, { createDirs = true } = {}) {
  const absPath = resolve(path);
  if (isProtectedPath(absPath)) return { error: `Access denied: ${path} is a protected credentials file.` };
  try {
    if (createDirs) mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf8');
    const lines = content.split('\n').length;
    return { path: absPath, written: true, lines, bytes: Buffer.byteLength(content) };
  } catch (e) {
    return { error: e.message };
  }
}

export function deleteFile(path) {
  const absPath = resolve(path);
  if (isProtectedPath(absPath)) return { error: `Access denied: ${path} is a protected credentials file.` };
  if (!existsSync(absPath)) return { error: `File not found: ${path}` };
  try {
    unlinkSync(absPath);
    return { deleted: absPath };
  } catch (e) {
    return { error: e.message };
  }
}

export async function listFiles(path = '.', pattern = '**/*', { maxResults = 200, excludePatterns = [] } = {}) {
  const absPath = resolve(path);
  const defaultIgnore = ['**/node_modules/**','**/.git/**','**/dist/**','**/.next/**','**/__pycache__/**','**/*.min.*','**/coverage/**'];
  try {
    const files = await glob(pattern, {
      cwd: absPath,
      ignore: [...defaultIgnore, ...excludePatterns],
      dot: false,
      stat: true,
      withFileTypes: true,
    });
    const results = files.slice(0, maxResults).map(f => ({
      path: f.fullpath ? relative(absPath, f.fullpath()) : (typeof f === 'string' ? f : f.name),
      type: f.isDirectory?.() ? 'dir' : 'file',
    }));
    return { path: absPath, count: results.length, files: results };
  } catch (e) {
    // fallback: simple readdir
    try {
      const entries = readdirSync(absPath, { withFileTypes: true });
      return {
        path: absPath,
        count: entries.length,
        files: entries.map(e => ({ path: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
      };
    } catch (e2) {
      return { error: e2.message };
    }
  }
}

export async function searchFiles(pattern, { path = '.', filePattern = '**/*', maxResults = 50, ignoreCase = false } = {}) {
  const absPath = resolve(path);
  const { execa } = await import('execa').catch(() => null) || {};
  // Use ripgrep if available, otherwise fallback to manual search
  const results = [];
  const rgArgs = ['-r', '--line-number', '--no-heading', '--color=never'];
  if (ignoreCase) rgArgs.push('-i');
  rgArgs.push('--glob', filePattern, '--', pattern, absPath);

  try {
    const { execSync } = await import('child_process');
    const output = execSync(`rg ${rgArgs.map(a => `'${a.replace(/'/g,"'\\''")}'`).join(' ')} 2>/dev/null || grep -rn${ignoreCase ? 'i' : ''} '${pattern.replace(/'/g,"'\\''")}' '${absPath}' 2>/dev/null`, { encoding: 'utf8', maxBuffer: 2_000_000 });
    const lines = output.split('\n').filter(Boolean).slice(0, maxResults);
    for (const line of lines) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (m) results.push({ file: relative(absPath, m[1]), line: parseInt(m[2]), match: m[3].trim() });
    }
  } catch {}

  return { pattern, path: absPath, matches: results, count: results.length };
}

export function getFileInfo(path) {
  const absPath = resolve(path);
  if (!existsSync(absPath)) return { error: `Not found: ${path}` };
  const stat = statSync(absPath);
  return {
    path: absPath,
    size: stat.size,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    modified: stat.mtime.toISOString(),
    extension: extname(absPath),
  };
}

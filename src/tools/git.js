// src/tools/git.js — git operations via simple-git
import simpleGit from 'simple-git';
import { resolve } from 'path';
import { AUTONOMOUS, SAFETY_MODE } from '../config.js';
import { confirm, printWarn, printTool } from '../ui.js';

function git(cwd = process.cwd()) {
  return simpleGit(resolve(cwd));
}

export async function gitStatus(path = '.') {
  try {
    const g = git(path);
    const status = await g.status();
    const log = await g.log({ maxCount: 5 }).catch(() => ({ all: [] }));
    const branch = await g.branchLocal().catch(() => ({ current: 'unknown', all: [] }));
    const remotes = await g.getRemotes(true).catch(() => []);
    return {
      branch: branch.current,
      branches: branch.all,
      modified: status.modified,
      not_added: status.not_added,
      created: status.created,
      deleted: status.deleted,
      staged: status.staged,
      recentCommits: log.all.map(c => ({ hash: c.hash.slice(0, 7), message: c.message, date: c.date, author: c.author_name })),
      remotes: remotes.map(r => ({ name: r.name, url: r.refs?.fetch || '' })),
      isClean: status.isClean(),
    };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitDiff(path = '.', { staged = false, file = null } = {}) {
  try {
    const g = git(path);
    let diff;
    if (staged) diff = await g.diff(['--cached', ...(file ? [file] : [])]);
    else diff = await g.diff([...(file ? [file] : [])]);
    return { diff: diff.slice(0, 20000), staged, path };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitLog(path = '.', { maxCount = 20, file = null } = {}) {
  try {
    const g = git(path);
    const opts = { maxCount };
    if (file) opts['--'] = [file];
    const log = await g.log(opts);
    return { commits: log.all.map(c => ({ hash: c.hash.slice(0, 7), message: c.message, date: c.date, author: c.author_name })) };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitCommit(message, path = '.', { addAll = true } = {}) {
  if (SAFETY_MODE === 'strict' && !AUTONOMOUS) {
    const ok = await confirm(`Commit: "${message}"?`);
    if (!ok) return { cancelled: true };
  }
  try {
    const g = git(path);
    if (addAll) await g.add('.');
    const result = await g.commit(message);
    printTool(`Committed: ${result.commit}`);
    return { commit: result.commit, summary: result.summary, message };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitCreateBranch(name, path = '.', { checkout = true } = {}) {
  try {
    const g = git(path);
    if (checkout) await g.checkoutLocalBranch(name);
    else await g.branch([name]);
    return { branch: name, checkedOut: checkout };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitCheckout(branch, path = '.') {
  try {
    const g = git(path);
    await g.checkout(branch);
    return { branch, success: true };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitPush(path = '.', { remote = 'origin', branch = 'HEAD', force = false } = {}) {
  if (!AUTONOMOUS) {
    const ok = await confirm(`Push to ${remote}/${branch}?`);
    if (!ok) return { cancelled: true };
  }
  try {
    const g = git(path);
    const args = force ? ['--force'] : [];
    const result = await g.push(remote, branch, args);
    return { pushed: true, remote, branch };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitClone(url, destPath = '.') {
  try {
    const g = simpleGit();
    await g.clone(url, resolve(destPath));
    return { cloned: true, url, path: resolve(destPath) };
  } catch (e) {
    return { error: e.message };
  }
}

export async function gitStash(path = '.', { pop = false, message = '' } = {}) {
  try {
    const g = git(path);
    if (pop) { await g.stash(['pop']); return { popped: true }; }
    await g.stash(['push', '-m', message || 'devlab-stash']);
    return { stashed: true, message };
  } catch (e) {
    return { error: e.message };
  }
}

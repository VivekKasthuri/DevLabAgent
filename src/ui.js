// src/ui.js — terminal UI helpers
import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import readline from 'readline';

marked.use(markedTerminal({
  code: chalk.cyan,
  codespan: chalk.cyan,
  heading: chalk.bold.yellow,
  firstHeading: chalk.bold.underline.yellow,
  strong: chalk.bold,
  em: chalk.italic,
}));

// ── Labels ──────────────────────────────────────────────────────────────────
export const labels = {
  agent:    chalk.bold.blue('[CodeAgent]'),
  tool:     chalk.bold.magenta('[Tool]'),
  memory:   chalk.bold.cyan('[Memory]'),
  error:    chalk.bold.red('[Error]'),
  warn:     chalk.bold.yellow('[Warn]'),
  success:  chalk.bold.green('[✓]'),
  cost:     chalk.bold.gray('[Usage]'),
  voice:    chalk.bold.magentaBright('[Voice]'),
  workflow: chalk.bold.yellowBright('[Workflow]'),
};

// ── Printing ─────────────────────────────────────────────────────────────────
export function printAgent(text)    { process.stdout.write(`\n${labels.agent} `); printMarkdown(text); }
export function printTool(msg)      { console.log(`  ${labels.tool} ${chalk.gray(msg)}`); }
export function printMemory(msg)    { console.log(`  ${labels.memory} ${chalk.cyan(msg)}`); }
export function printError(msg)     { console.error(`${labels.error} ${chalk.red(msg)}`); }
export function printWarn(msg)      { console.warn(`${labels.warn} ${chalk.yellow(msg)}`); }
export function printSuccess(msg)   { console.log(`${labels.success} ${chalk.green(msg)}`); }
export function printCost(msg)      { console.log(`${labels.cost} ${chalk.gray(msg)}`); }
export function printWorkflow(msg)  { console.log(`${labels.workflow} ${chalk.yellowBright(msg)}`); }

export function printMarkdown(text) {
  process.stdout.write(marked(text));
}

export function printDivider() {
  const width = process.stdout.columns || 80;
  console.log(chalk.gray('─'.repeat(width)));
}

export function printHeader() {
  console.clear();
  printDivider();
  console.log(chalk.bold.blue('  ██████╗ ██████╗ ██████╗ ███████╗ █████╗  ██████╗ ███████╗███╗   ██╗████████╗'));
  console.log(chalk.bold.blue('  ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝'));
  console.log(chalk.bold.blue('  ██║     ██║   ██║██║  ██║█████╗  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║'));
  console.log(chalk.bold.blue('  ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║'));
  console.log(chalk.bold.blue('  ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║'));
  console.log(chalk.bold.blue('   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝'));
  console.log(chalk.gray('  The autonomous AI coding agent that fills every gap\n'));
  printDivider();
  console.log(chalk.gray('  Commands: /help  /memory  /cost  /billing  /workflow  /learn  /voice  /mode  /clear  /exit'));
  printDivider();
  console.log();
}

// ── Spinner ──────────────────────────────────────────────────────────────────
let _spinner = null;
export async function withSpinner(text, fn) {
  const { default: ora } = await import('ora');
  _spinner = ora({ text: chalk.gray(text), spinner: 'dots' }).start();
  try {
    const result = await fn();
    _spinner.succeed(chalk.gray(text));
    _spinner = null;
    return result;
  } catch (err) {
    _spinner.fail(chalk.red(text));
    _spinner = null;
    throw err;
  }
}

export function stopSpinner() {
  if (_spinner) { _spinner.stop(); _spinner = null; }
}

// ── Input ────────────────────────────────────────────────────────────────────
export function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.blue('\n▶ '),
    historySize: 1000,
  });
}

export async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${chalk.yellow('?')} ${question} ${chalk.gray('(y/N)')} `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function selectFromList(title, options, { defaultIndex = 0, hint = 'Use ↑ ↓ and Enter', allowCancel = true } = {}) {
  const normalized = (options || []).map((option, index) => {
    if (typeof option === 'string') {
      return { value: option, label: option, description: '' };
    }
    return {
      value: option.value ?? option.name ?? option.label ?? index,
      label: option.label ?? option.name ?? String(option.value ?? index),
      description: option.description || '',
    };
  });

  if (normalized.length === 0) return null;

  const initialIndex = Math.max(0, Math.min(defaultIndex, normalized.length - 1));

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return normalized[initialIndex];
  }

  const previousRawMode = process.stdin.isRaw;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  let currentIndex = initialIndex;
  let resolved = false;

  const render = () => {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    console.log(chalk.bold(`\n${title}`));
    console.log(chalk.gray(hint));
    console.log();
    for (let i = 0; i < normalized.length; i++) {
      const item = normalized[i];
      const selected = i === currentIndex;
      const marker = selected ? chalk.cyan('❯') : ' ';
      const label = selected ? chalk.bold.white(item.label) : chalk.white(item.label);
      const description = item.description ? chalk.gray(` — ${item.description}`) : '';
      console.log(` ${marker} ${label}${description}`);
    }
    if (allowCancel) {
      console.log(chalk.gray('\nPress Esc or Ctrl+C to cancel.'));
    }
  };

  return await new Promise(resolve => {
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.setRawMode) process.stdin.setRawMode(!!previousRawMode);
      process.stdin.pause();
    };

    const finish = (item) => {
      cleanup();
      process.stdout.write('\n');
      resolve(item);
    };

    const onKeypress = (str, key = {}) => {
      if (key.name === 'up') {
        currentIndex = currentIndex > 0 ? currentIndex - 1 : normalized.length - 1;
        render();
        return;
      }
      if (key.name === 'down') {
        currentIndex = currentIndex < normalized.length - 1 ? currentIndex + 1 : 0;
        render();
        return;
      }
      if (key.name === 'return') {
        finish(normalized[currentIndex]);
        return;
      }
      if (allowCancel && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
        finish(null);
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}

// ── Token / cost display ─────────────────────────────────────────────────────
export function formatTokenCost(inputTokens, outputTokens, model) {
  // Groq is free tier — just show tokens
  const total = inputTokens + outputTokens;
  return `${total.toLocaleString()} tokens (in:${inputTokens.toLocaleString()} out:${outputTokens.toLocaleString()}) · model:${model}`;
}

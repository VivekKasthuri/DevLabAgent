#!/usr/bin/env node
// index.js — DevLab CLI entry point
import { Command } from 'commander';
import readline from 'readline';
import { existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ── Bootstrap .env ────────────────────────────────────────────────────────────
const envPath = join(__dirname, '.env');
const envExample = join(__dirname, '.env.example');
if (!existsSync(envPath) && existsSync(envExample)) {
  copyFileSync(envExample, envPath);
  console.log('\x1b[33m[Setup]\x1b[0m Created .env from .env.example');
  console.log('\x1b[33m[Setup]\x1b[0m → Add your FREE Groq API key at https://console.groq.com then re-run\n');
}

// Lazy imports (avoid loading heavy modules before we need them)
async function loadModules() {
  const [
    { Agent }     = await import('./src/agent.js'),
    { printHeader, printAgent, printError, printWarn, printSuccess, printCost,
      printWorkflow, printMemory, printDivider, createReadline, formatTokenCost, labels, selectFromList } = await import('./src/ui.js'),
    mem           = await import('./src/memory.js'),
    { runWorkflow, listWorkflows } = await import('./src/workflow.js'),
    { startVoiceMode } = await import('./src/tools/voice.js'),
    { analyzeProject } = await import('./src/tools/code.js'),
    chalk         = (await import('chalk')).default,
  ] = await Promise.all([
    import('./src/agent.js'),
    import('./src/ui.js'),
    import('./src/memory.js'),
    import('./src/workflow.js'),
    import('./src/tools/voice.js'),
    import('./src/tools/code.js'),
    import('chalk'),
  ]);
  return { Agent, printHeader, printAgent, printError, printWarn, printSuccess, printCost,
           printWorkflow, printMemory, printDivider, createReadline, formatTokenCost, labels, selectFromList, mem, runWorkflow, listWorkflows, startVoiceMode, analyzeProject, chalk };
}

async function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function applyModelOptions(options = {}) {
  const provider = options.provider || options.modelProvider;
  const model = options.model || options.modelName;
  const fastModel = options.fastModel || options.fastModelName;
  const fallbackProvider = options.fallbackProvider;
  const copilotFallbackProvider = options.copilotFallbackProvider;

  if (provider) process.env.MODEL_PROVIDER = provider;
  if (model) process.env.MODEL_NAME = model;
  if (fastModel) process.env.FAST_MODEL_NAME = fastModel;
  if (fallbackProvider) process.env.FALLBACK_PROVIDER = fallbackProvider;
  if (copilotFallbackProvider) process.env.COPILOT_FALLBACK_PROVIDER = copilotFallbackProvider;
}

function normalizeProviderName(provider) {
  return String(provider || '').trim().toLowerCase();
}

async function chooseChatConfiguration(mods, initial = {}, { forcePrompt = false } = {}) {
  const { selectFromList } = mods;
  const { listModelProviders, getProviderModels } = await import('./src/llm.js');

  const initialProvider = normalizeProviderName(initial.provider || process.env.MODEL_PROVIDER);
  const initialModel = initial.model || process.env.MODEL_NAME || '';
  const initialFallback = normalizeProviderName(initial.copilotFallbackProvider || process.env.COPILOT_FALLBACK_PROVIDER);

  let provider = initialProvider;
  let model = initialModel;
  let copilotFallbackProvider = initialFallback;

  if (forcePrompt || !provider) {
    const providerChoices = listModelProviders().map(p => ({
      value: p.name,
      label: p.name,
      description: p.description,
    }));
    const pickedProvider = await selectFromList(
      'Select model provider',
      providerChoices,
      { defaultIndex: Math.max(0, providerChoices.findIndex(p => p.value === provider)) }
    );
    if (!pickedProvider) return null;
    provider = pickedProvider.value;
  }

  if (provider === 'copilot') {
    if (forcePrompt || !copilotFallbackProvider) {
      const fallbackChoices = listModelProviders()
        .filter(p => p.name !== 'copilot')
        .map(p => ({ value: p.name, label: p.name, description: p.description }));
      const pickedFallback = await selectFromList(
        'Select Copilot fallback provider',
        fallbackChoices,
        { defaultIndex: Math.max(0, fallbackChoices.findIndex(p => p.value === copilotFallbackProvider)) }
      );
      if (!pickedFallback) return null;
      copilotFallbackProvider = pickedFallback.value;
    }
  }

  const effectiveProvider = provider === 'copilot' ? (copilotFallbackProvider || 'groq') : provider;
  if (forcePrompt || !model) {
    const modelChoices = getProviderModels(effectiveProvider).map(m => ({
      value: m.value,
      label: m.label,
      description: m.description,
    }));
    const pickedModel = await selectFromList(
      `Select model for ${effectiveProvider}`,
      modelChoices,
      { defaultIndex: Math.max(0, modelChoices.findIndex(m => m.value === model)) }
    );
    if (!pickedModel) return null;
    model = pickedModel.value;
  }

  return { provider, model, copilotFallbackProvider };
}

// ── Slash command handler ─────────────────────────────────────────────────────
async function handleSlashCommand(cmd, agent, mods) {
  const { printSuccess, printError, printDivider, printMemory, printCost, printWorkflow, mem, runWorkflow, listWorkflows, startVoiceMode, chalk, formatTokenCost, labels } = mods;
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');

  switch (command) {
    case '/help':
      console.log(chalk.bold('\nAvailable commands:'));
      console.log('  /help              Show this help');
      console.log('  /memory            Show all saved memories');
      console.log('  /memory <query>    Search memories');
      console.log('  /forget <key>      Delete a memory by key');
      console.log('  /cost              Show token usage for this session');
      console.log('  /stats             Full stats (memory, sessions, tokens)');
      console.log('  /clear             Clear conversation context (memory persists)');
      console.log('  /workflow <name>   Run a workflow');
      console.log('  /workflows         List available workflows');
      console.log('  /learn [path]      Learn and index a project');
      console.log('  /model            Change model/provider with a dropdown');
      console.log('  /develop <ticket>  Build a dev brief from Jira + Confluence');
      console.log('  /mcp               Show loaded MCP servers/tools');
      console.log('  /mcp reload        Reload MCP servers from config');
      console.log('  /voice             Start voice mode');
      console.log('  /mode              Show current safety mode');
      console.log('  /sessions          Show recent sessions');
      console.log('  /exit              Exit');
      console.log();
      break;

    case '/memory':
      if (arg) {
        const results = mem.recall(arg, 10);
        if (results.length === 0) { console.log(chalk.gray('No matching memories')); break; }
        printDivider();
        for (const r of results) {
          console.log(chalk.bold.cyan(r.key), chalk.gray(`[${r.tags || ''}]`));
          console.log(chalk.white(r.value.slice(0, 200)));
          console.log();
        }
        printDivider();
      } else {
        const all = mem.listMemories(30);
        if (all.length === 0) { console.log(chalk.gray('No memories saved yet')); break; }
        printDivider();
        for (const r of all) {
          console.log(chalk.bold.cyan(r.key), chalk.gray(`— ${r.updated_at} [${r.tags || 'no tags'}]`));
          console.log(chalk.white(r.value.slice(0, 150)));
        }
        printDivider();
        console.log(chalk.gray(`Total: ${all.length} memories`));
      }
      break;

    case '/forget':
      if (!arg) { console.log(chalk.yellow('Usage: /forget <key>')); break; }
      mem.deleteMemory(arg);
      printSuccess(`Deleted memory: ${arg}`);
      break;

    case '/cost': {
      const { getTokenStats } = await import('./src/llm.js');
      const s = getTokenStats();
      printCost(formatTokenCost(s.in, s.out, 'session'));
      break;
    }

    case '/billing': {
      const { usageReport, listPlans, setPlan } = await import('./src/billing.js');
      const sub = parts[1];
      if (sub === 'plans') {
        console.log(JSON.stringify(listPlans(), null, 2));
      } else if (sub === 'upgrade' || sub === 'activate') {
        const res = setPlan(parts[2] || 'pro', parts[3] || null);
        console.log(JSON.stringify(res, null, 2));
      } else {
        const r = usageReport();
        console.log(chalk.bold(`\nPlan: ${r.plan} · period ${r.period}`));
        for (const [k, v] of Object.entries(r.usage)) console.log(chalk.gray(`  ${k}: ${v}`));
        console.log(chalk.gray(`  provider cost (est): ${r.estimatedProviderCost}`));
        if (r.overageCharge) console.log(chalk.yellow(`  overage due: ${r.overageCharge}`));
        if (r.upgradeHint) console.log(chalk.yellow(`  ${r.upgradeHint}`));
        console.log(chalk.gray('\n  /billing plans · /billing upgrade <plan> [licenseKey]'));
      }
      break;
    }

    case '/stats': {
      const { getTokenStats } = await import('./src/llm.js');
      const ts = getTokenStats();
      const ms = mem.getMemoryStats();
      console.log(chalk.bold('\nSession stats:'));
      console.log(chalk.gray(`  Tokens:    in=${ts.in.toLocaleString()} out=${ts.out.toLocaleString()} total=${ts.total.toLocaleString()}`));
      console.log(chalk.gray(`  API calls: ${ts.calls}`));
      console.log(chalk.bold('\nMemory stats:'));
      console.log(chalk.gray(`  Memories:  ${ms.memories}`));
      console.log(chalk.gray(`  Projects:  ${ms.projects}`));
      console.log(chalk.gray(`  Sessions:  ${ms.sessions}`));
      console.log(chalk.gray(`  All-time tokens: ${ms.totalTokens.toLocaleString()}`));
      console.log();
      break;
    }

    case '/clear':
      agent.clearContext();
      break;

    case '/workflow':
      if (!arg) { console.log(chalk.yellow('Usage: /workflow <name>')); break; }
      await runWorkflow(arg, {}, { agent, executeTool: (await import('./src/tools/index.js')).executeTool });
      break;

    case '/workflows': {
      const wfs = listWorkflows();
      if (wfs.length === 0) { console.log(chalk.gray('No workflows found')); break; }
      console.log(chalk.bold('\nAvailable workflows:'));
      for (const w of wfs) console.log(`  ${chalk.cyan(w.name.padEnd(25))} ${chalk.gray(w.description)} (${w.steps} steps)`);
      console.log();
      break;
    }

    case '/learn': {
      const path = arg || process.cwd();
      console.log(chalk.cyan(`\nLearning project: ${path}`));
      const { analyzeProject } = await import('./src/tools/code.js');
      const info = await analyzeProject(path);
      const summary = `Project at ${path}: ${Object.keys(info.languages).join(', ')} | ${info.frameworks.join(', ')} | ${info.stats.fileCount} files`;
      mem.upsertProject(path, path.split('/').pop(), Object.keys(info.languages).join(','), info.frameworks.join(','), summary);
      mem.remember(`project:${path}`, JSON.stringify({ languages: info.languages, frameworks: info.frameworks, fileCount: info.stats.fileCount, config: info.config }), ['project'], path);
      printSuccess(`Learned project: ${path}`);
      if (info.readme) console.log(chalk.gray(info.readme.slice(0, 300)));
      break;
    }

    case '/model': {
      const config = await chooseChatConfiguration(mods, agent.options || {}, { forcePrompt: true });
      if (!config) break;
      agent.options.provider = config.provider;
      agent.options.model = config.model;
      agent.options.copilotFallbackProvider = config.copilotFallbackProvider;
      applyModelOptions(config);
      printSuccess(`Model set: ${config.provider}${config.provider === 'copilot' ? ` (fallback: ${config.copilotFallbackProvider})` : ''} · ${config.model}`);
      break;
    }

    case '/develop': {
      const issueKey = parts[1];
      if (!issueKey) { console.log(chalk.yellow('Usage: /develop <JIRA-123>')); break; }
      const { developFromJira } = await import('./src/tools/atlassian.js');
      const result = await developFromJira(issueKey, { createPage: false, commentJira: false });
      if (result.error) { console.log(chalk.red(result.error)); break; }
      console.log(chalk.bold.cyan(`\n${result.issue.key}: ${result.issue.summary}`));
      console.log(chalk.gray(`Status: ${result.issue.status || 'n/a'} | Priority: ${result.issue.priority || 'n/a'}`));
      console.log(chalk.bold('\nTask breakdown:'));
      for (const task of result.tasks || []) console.log(`  • ${task}`);
      console.log();
      break;
    }

    case '/mcp': {
      const sub = (parts[1] || '').toLowerCase();
      const { getMcpStatus, reloadMcpServers } = await import('./src/mcp.js');
      if (sub === 'reload') {
        await reloadMcpServers();
      }
      const status = await getMcpStatus();
      console.log(chalk.bold('\nMCP Status'));
      console.log(chalk.gray(`  config: ${status.configPath}`));
      console.log(chalk.gray(`  servers: ${status.servers.length}`));
      console.log(chalk.gray(`  tools: ${status.tools.length}`));
      if (status.servers.length) {
        console.log(chalk.bold('\nServers:'));
        for (const s of status.servers) console.log(`  - ${chalk.cyan(s)}`);
      }
      if (status.errors?.length) {
        console.log(chalk.bold.red('\nErrors:'));
        for (const e of status.errors) console.log(`  - ${chalk.yellow(e.server)}: ${e.error}`);
      }
      console.log();
      break;
    }

    case '/voice':
      await startVoiceMode(agent);
      break;

    case '/mode': {
      const { SAFETY_MODE, AUTONOMOUS } = await import('./src/config.js');
      console.log(chalk.bold(`\nSafety mode: ${chalk.cyan(SAFETY_MODE)} ${AUTONOMOUS ? chalk.yellow('(autonomous — no confirmations)') : ''}\n`));
      break;
    }

    case '/sessions': {
      const sessions = mem.getRecentSessions(10);
      console.log(chalk.bold('\nRecent sessions:'));
      for (const s of sessions) {
        console.log(`  ${chalk.gray(s.started_at)} ${chalk.cyan(s.project || 'unknown')} — ${chalk.white(s.summary?.slice(0, 60) || 'no summary')}`);
      }
      console.log();
      break;
    }

    case '/exit':
    case '/quit':
      await agent.close();
      process.exit(0);
      break;

    default:
      console.log(chalk.yellow(`Unknown command: ${command}. Type /help for commands.`));
  }
}

// ── REPL ──────────────────────────────────────────────────────────────────────
async function startREPL(options = {}) {
  const mods = await loadModules();
  const { Agent, printHeader, printDivider, createReadline, printError, chalk } = mods;

  printHeader();

  const selected = await chooseChatConfiguration(mods, options, {
    forcePrompt: !options.provider && !options.model,
  });
  if (!selected) {
    console.log(chalk.gray('\nNo model selected. Exiting.\n'));
    process.exit(0);
  }

  applyModelOptions(selected);

  const agent = new Agent({
    project: options.project || process.cwd(),
    provider: selected.provider,
    model: selected.model,
    copilotFallbackProvider: selected.copilotFallbackProvider,
  });
  await agent.init();

  // Ask for project rules on first chat in a project without any
  const { promptForRulesIfMissing } = await import('./src/rules.js');
  await promptForRulesIfMissing(options.project || process.cwd());

  console.log(chalk.gray(`\nSelected: ${selected.provider}${selected.provider === 'copilot' ? ` (fallback: ${selected.copilotFallbackProvider})` : ''} · ${selected.model}\n`));

  const rl = createReadline();
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.startsWith('/')) {
      await handleSlashCommand(input, agent, mods);
      rl.prompt();
      return;
    }

    // Regular message → agent
    try {
      await agent.run(input);
    } catch (err) {
      printError(err.message);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    console.log(chalk.gray('\nGoodbye! Saving session...'));
    await agent.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log(chalk.gray('\nCaught Ctrl+C. Saving session...'));
    await agent.close();
    process.exit(0);
  });
}

// ── CLI setup ─────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name('devlab')
  .description('Autonomous AI coding agent — fills every gap Claude & Cursor miss')
  .version('1.0.0');


// ── Interactive setup wizard ─────────────────────────────────────────────────
async function promptText(question, { secret = false, defaultValue = '' } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` (${secret ? 'saved' : defaultValue})` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

program
  .command('setup')
  .description('Interactive setup wizard — prompts for provider keys, Jira/Confluence, and writes .env')
  .action(async () => {
    const { existsSync, readFileSync, writeFileSync, copyFileSync } = await import('fs');
    const envPath = new URL('./.env', import.meta.url).pathname;

    // Load existing values so re-running keeps what you already entered
    const existing = {};
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) existing[m[1]] = m[2];
      }
      copyFileSync(envPath, envPath + '.bak');
      console.log('Found existing .env — current values kept as defaults (backup: .env.bak)\n');
    }

    console.log('=== DevLab Setup Wizard ===\n');

    // 1. Provider
    console.log('1) Model provider');
    console.log('   groq   — fast + free tier (needs GROQ_API_KEY)');
    console.log('   claude — best quality (needs ANTHROPIC_API_KEY)');
    console.log('   ollama — 100% free local models (no key needed)');
    const provider = (await promptText('Provider [groq/claude/ollama]', { defaultValue: existing.MODEL_PROVIDER || 'groq' })).toLowerCase();

    const vals = { ...existing, MODEL_PROVIDER: provider };

    if (provider === 'groq') {
      vals.GROQ_API_KEY = await promptText('GROQ_API_KEY (console.groq.com/keys)', { secret: true, defaultValue: existing.GROQ_API_KEY || '' });
    } else if (provider === 'claude') {
      vals.ANTHROPIC_API_KEY = await promptText('ANTHROPIC_API_KEY (console.anthropic.com)', { secret: true, defaultValue: existing.ANTHROPIC_API_KEY || '' });
    } else if (provider === 'ollama') {
      vals.OPENAI_COMPAT_BASE_URL = await promptText('Ollama URL', { defaultValue: existing.OPENAI_COMPAT_BASE_URL || 'http://localhost:11434/v1' });
      vals.OPENAI_COMPAT_MODEL = await promptText('Model name', { defaultValue: existing.OPENAI_COMPAT_MODEL || 'DevLab-Model' });
    }

    // 2. Jira / Confluence (optional)
    console.log('\n2) Jira + Confluence integration (Enter to skip)');
    const jiraUrl = await promptText('JIRA_BASE_URL (https://company.atlassian.net)', { defaultValue: existing.JIRA_BASE_URL || '' });
    if (jiraUrl) {
      vals.JIRA_BASE_URL = jiraUrl;
      vals.JIRA_EMAIL = await promptText('JIRA_EMAIL', { defaultValue: existing.JIRA_EMAIL || '' });
      vals.JIRA_API_TOKEN = await promptText('JIRA_API_TOKEN (id.atlassian.com → Security → API tokens)', { secret: true, defaultValue: existing.JIRA_API_TOKEN || '' });
    }

    // 3. Options
    console.log('\n3) Agent behavior');
    const auto = await promptYesNo('Enable autonomous mode (no confirmations)?');
    vals.SAFETY_MODE = auto ? 'autonomous' : (existing.SAFETY_MODE || 'normal');
    vals.UI_PORT = await promptText('Web UI port', { defaultValue: existing.UI_PORT || '4321' });

    // Write .env
    const content = Object.entries(vals)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
    writeFileSync(envPath, content);

    console.log('\n✅ .env written. Verifying setup...\n');

    // Quick verification
    try {
      const { listModelProviders } = await import('./src/llm.js');
      console.log('Providers available:', listModelProviders().map(p => p.name).join(', '));
    } catch (e) { console.log('Provider check skipped:', e.message); }

    console.log('\nNext steps:');
    console.log('  node index.js           # start chatting');
    console.log('  node index.js ui        # web UI at http://localhost:' + (vals.UI_PORT || 4321));
    console.log('  node index.js develop PROJ-123   # implement a Jira ticket');
  });

program
  .command('chat', { isDefault: true })
  .description('Start interactive chat (default)')
  .option('-p, --project <path>', 'Set project path', process.cwd())
  .option('-a, --autonomous', 'Enable autonomous mode (no confirmations)')
  .option('--provider <name>', 'LLM provider (groq, claude, ollama, free, copilot)')
  .option('--model <name>', 'Model name')
  .option('--fast-model <name>', 'Fast model name')
  .option('--fallback-provider <name>', 'Fallback provider used when provider=copilot')
  .option('--copilot-fallback-provider <name>', 'Alias fallback provider for copilot mode')
  .action((opts) => {
    applyModelOptions(opts);
    if (opts.autonomous) process.env.SAFETY_MODE = 'autonomous';
    startREPL({
      ...opts,
      provider: process.env.MODEL_PROVIDER,
      model: process.env.MODEL_NAME,
    });
  });

program
  .command('learn [path]')
  .description('Learn and index a project into persistent memory')
  .action(async (path = '.') => {
    const { analyzeProject } = await import('./src/tools/code.js');
    const { upsertProject, remember } = await import('./src/memory.js');
    const chalk = (await import('chalk')).default;
    console.log(chalk.cyan(`\nLearning: ${path}`));
    const info = await analyzeProject(path);
    const summary = `Languages: ${Object.keys(info.languages).join(', ')} | Frameworks: ${info.frameworks.join(', ')} | Files: ${info.stats.fileCount}`;
    upsertProject(path, path.split('/').pop(), Object.keys(info.languages).join(','), info.frameworks.join(','), summary);
    remember(`project:${path}`, JSON.stringify(info), ['project'], path);
    console.log(chalk.green(`\n✓ Learned: ${path}`));
    console.log(chalk.gray(summary));
  });

program
  .command('workflow <name>')
  .description('Run a predefined workflow by name')
  .option('-p, --params <json>', 'Workflow parameters as JSON', '{}')
  .action(async (name, opts) => {
    const { runWorkflow } = await import('./src/workflow.js');
    const { executeTool } = await import('./src/tools/index.js');
    const params = JSON.parse(opts.params);
    await runWorkflow(name, params, { executeTool });
  });

program
  .command('voice')
  .description('Start voice mode (requires sox: brew install sox)')
  .option('--provider <name>', 'LLM provider (groq, claude, ollama, free, copilot)')
  .option('--model <name>', 'Model name')
  .option('--fallback-provider <name>', 'Fallback provider used when provider=copilot')
  .action(async (opts) => {
    applyModelOptions(opts);
    const { Agent } = await import('./src/agent.js');
    const { startVoiceMode } = await import('./src/tools/voice.js');
    const agent = new Agent();
    await agent.init();
    await startVoiceMode(agent);
    await agent.close();
  });

program
  .command('memory')
  .description('Browse or search persistent memory')
  .argument('[query]', 'Search query')
  .action(async (query) => {
    const { recall, listMemories } = await import('./src/memory.js');
    const chalk = (await import('chalk')).default;
    const results = query ? recall(query, 20) : listMemories(50);
    if (results.length === 0) { console.log(chalk.gray('No memories found')); return; }
    for (const r of results) {
      console.log(chalk.bold.cyan(r.key), chalk.gray(`[${r.tags || ''}] ${r.updated_at}`));
      console.log(chalk.white(r.value.slice(0, 300)));
      console.log();
    }
  });

program
  .command('providers')
  .description('List supported model providers and the current configuration')
  .action(async () => {
    const chalk = (await import('chalk')).default;
    const { listModelProviders } = await import('./src/llm.js');
    const config = await import('./src/config.js');

    console.log(chalk.bold('\nSupported providers:'));
    for (const p of listModelProviders()) {
      console.log(`  ${chalk.cyan(p.name.padEnd(18))} ${chalk.gray(p.description)}`);
    }
    console.log(chalk.bold('\nCurrent config:'));
    console.log(chalk.gray(`  provider: ${config.MODEL_PROVIDER}`));
    console.log(chalk.gray(`  model:    ${config.MODEL_NAME}`));
    console.log(chalk.gray(`  fast:     ${config.FAST_MODEL_NAME}`));
    console.log(chalk.gray(`  claude:   ${config.CLAUDE_MODEL}`));
    console.log(chalk.gray(`  copilot fallback: ${config.COPILOT_FALLBACK_PROVIDER}`));
    console.log();
  });

program
  .command('models')
  .description('List all models available on the connected Ollama/model server')
  .option('--host <url>', 'Ollama base URL (default: $OPENAI_COMPAT_BASE_URL or http://localhost:11434)')
  .option('--set <model>', 'Set the active model in .env / environment')
  .action(async (opts) => {
    const chalk = (await import('chalk')).default;
    const { OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL } = await import('./src/config.js');

    const base = (opts.host || OPENAI_COMPAT_BASE_URL).replace(/\/v1\/?$/, '');

    if (opts.set) {
      // Update .env with the chosen model
      const fs = await import('fs');
      const path = await import('path');
      const envPath = path.resolve(process.cwd(), '.env');
      let contents = '';
      try { contents = fs.readFileSync(envPath, 'utf8'); } catch {}
      if (contents.includes('OLLAMA_MODEL=') || contents.includes('OPENAI_COMPAT_MODEL=')) {
        contents = contents
          .replace(/^OLLAMA_MODEL=.*/m, `OLLAMA_MODEL=${opts.set}`)
          .replace(/^OPENAI_COMPAT_MODEL=.*/m, `OPENAI_COMPAT_MODEL=${opts.set}`);
      } else {
        contents += `\nOLLAMA_MODEL=${opts.set}\n`;
      }
      fs.writeFileSync(envPath, contents);
      console.log(chalk.green(`✓ Active model set to: ${chalk.bold(opts.set)}`));
      console.log(chalk.gray('  Restart DevLab server to apply.'));
      return;
    }

    console.log(chalk.bold(`\nFetching models from ${base}...\n`));
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = data.models || [];

      if (models.length === 0) {
        console.log(chalk.yellow('  No models installed. Run: ollama pull codellama:13b'));
        return;
      }

      console.log(chalk.bold('  Installed models:\n'));
      for (const m of models) {
        const isCurrent = m.name === OPENAI_COMPAT_MODEL;
        const badge = isCurrent ? chalk.green(' ◀ active') : '';
        const sizeGB = m.size ? ` ${(m.size / 1e9).toFixed(1)} GB` : '';
        console.log(`  ${chalk.cyan(m.name.padEnd(30))}${chalk.gray(sizeGB)}${badge}`);
      }

      // Show smart routing table
      const { describeRouting } = await import('./src/ollama-router.js');
      const routing = describeRouting();
      console.log(chalk.bold('\n  Smart routing (devlab-coder auto-picks):\n'));
      for (const r of routing) {
        console.log(`  ${chalk.yellow(r.task.padEnd(32))} → ${chalk.cyan(r.model)}`);
        console.log(chalk.gray(`  ${''.padEnd(32)}   e.g. "${r.examples}"`));
      }

      console.log(chalk.gray('\n  Override: devlab models --set codellama:13b'));
      console.log(chalk.gray('  Pin model: devlab chat --model mistral:7b "review my code"\n'));
    } catch (e) {
      console.log(chalk.red(`  ✗ Could not reach Ollama at ${base}`));
      console.log(chalk.gray(`    ${e.message}`));
      console.log(chalk.gray('    Make sure Ollama is running: ollama serve'));
    }
  });

program
  .command('mcp [action] [name]')
  .description('MCP servers: list (default), add <name>, remove <name>, catalog, suggest')
  .option('-r, --reload', 'Force reload MCP servers from config')
  .action(async (action, name, opts) => {
    const chalk = (await import('chalk')).default;
    const { reloadMcpServers, getMcpStatus, addMcpServer, removeMcpServer, getMcpCatalog, suggestMcpServers, MCP_CATALOG } = await import('./src/mcp.js');

    if (action === 'catalog') {
      console.log(chalk.bold('\nMCP Catalog (one-command install):'));
      for (const c of getMcpCatalog()) {
        const badge = c.installed ? chalk.green(' [installed]') : '';
        console.log(`  ${chalk.cyan(c.name.padEnd(14))} ${c.description}${badge}`);
        if (c.requires.length) console.log(chalk.gray(`  ${''.padEnd(14)} needs: ${c.requires.join(', ')}`));
      }
      console.log(chalk.gray('\n  Install: node index.js mcp add <name>\n'));
      return;
    }

    if (action === 'suggest') {
      const s = suggestMcpServers(process.cwd());
      console.log(chalk.bold('\nSuggested MCP servers for this project:'));
      for (const x of s.suggestions) console.log(`  ${chalk.cyan(x.name.padEnd(12))} ${x.reason}`);
      console.log(chalk.gray(`\n  ${s.install}\n`));
      return;
    }

    if (action === 'add') {
      if (!name) { console.log(chalk.red('Usage: node index.js mcp add <name>  (see: mcp catalog)')); return; }
      const entry = MCP_CATALOG[name];
      const values = {};
      if (entry?.params?.length) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q) => new Promise((res) => rl.question(q, res));
        for (const p of entry.params) {
          const v = (await ask(`${p.prompt}${p.default ? ` (${p.default})` : ''}: `)).trim();
          values[p.key] = v || p.default || '';
        }
        rl.close();
      }
      const r = await addMcpServer(name, { values });
      if (r.success) {
        console.log(chalk.green(`\n✅ '${name}' installed and connected.`));
        if (r.tools?.length) console.log(chalk.gray(`   Tools: ${r.tools.join(', ')}`));
      } else {
        console.log(chalk.yellow(`\n⚠️ ${r.warning || r.error || 'Setup incomplete'}`));
        if (r.errors) for (const e of r.errors) console.log(chalk.gray(`   ${e.server}: ${e.error}`));
      }
      return;
    }

    if (action === 'remove') {
      if (!name) { console.log(chalk.red('Usage: node index.js mcp remove <name>')); return; }
      const r = await removeMcpServer(name);
      console.log(r.success ? chalk.green(`✅ removed '${name}'`) : chalk.red(r.error));
      return;
    }

    if (opts.reload) {
      await reloadMcpServers();
    }
    const status = await getMcpStatus();
    console.log(chalk.bold('\nMCP Status'));
    console.log(chalk.gray(`  config: ${status.configPath}`));
    console.log(chalk.gray(`  servers: ${status.servers.length}`));
    console.log(chalk.gray(`  tools: ${status.tools.length}`));
    if (status.servers.length) {
      console.log(chalk.bold('\nServers:'));
      for (const s of status.servers) console.log(`  - ${chalk.cyan(s)}`);
    }
    if (status.errors?.length) {
      console.log(chalk.bold.red('\nErrors:'));
      for (const e of status.errors) {
        console.log(`  - ${chalk.yellow(e.server)}: ${e.error}`);
      }
    }
    console.log();
  });

program
  .command('scan <path>')
  .description('Run security scan on a file or project')
  .option('-p, --project', 'Scan entire project')
  .action(async (path, opts) => {
    const { scanSecurity, scanSecurityProject } = await import('./src/tools/code.js');
    const chalk = (await import('chalk')).default;
    const result = opts.project ? await scanSecurityProject(path) : scanSecurity(path);
    console.log(JSON.stringify(result, null, 2));
  });

// ── fix ───────────────────────────────────────────────────────────────────────
program
  .command('fix [path]')
  .description('Detect and auto-fix issues in a project (tests, lint, security, deps)')
  .option('-d, --dry-run', 'Show issues without fixing')
  .option('-a, --autonomous', 'No confirmations')
  .option('--provider <name>', 'LLM provider (groq, claude, ollama, free, copilot)')
  .option('--model <name>', 'Model name')
  .option('--fallback-provider <name>', 'Fallback provider used when provider=copilot')
  .action(async (path = '.', opts) => {
    applyModelOptions(opts);
    if (opts.autonomous) process.env.SAFETY_MODE = 'autonomous';
    const chalk = (await import('chalk')).default;
    const { Agent }      = await import('./src/agent.js');
    const { fixProject } = await import('./src/tools/fixer.js');
    const { updateRepoStatus } = await import('./src/repos.js');

    const agent = new Agent({ project: path });
    await agent.init();
    const result = await fixProject(path, agent, { dryRun: opts.dryRun });
    if (!opts.dryRun) {
      updateRepoStatus(path, {
        lastFix: new Date().toISOString(),
        issueCount: result.total || 0,
        fixedCount: result.fixed || 0,
        status: result.fixed === result.total ? 'clean' : 'partial',
      });
    }
    await agent.close();
  });

// ── fix-all ───────────────────────────────────────────────────────────────────
program
  .command('fix-all')
  .description('Fix issues in ALL registered repositories')
  .option('-d, --dry-run', 'Show issues without fixing')
  .option('-a, --autonomous', 'No confirmations (recommended for fix-all)')
  .option('--provider <name>', 'LLM provider (groq, claude, ollama, free, copilot)')
  .option('--model <name>', 'Model name')
  .option('--fallback-provider <name>', 'Fallback provider used when provider=copilot')
  .action(async (opts) => {
    applyModelOptions(opts);
    if (opts.autonomous) process.env.SAFETY_MODE = 'autonomous';
    const chalk = (await import('chalk')).default;
    const { listRepos, updateRepoStatus } = await import('./src/repos.js');
    const { Agent }      = await import('./src/agent.js');
    const { fixProject } = await import('./src/tools/fixer.js');

    const repos = listRepos();
    if (repos.length === 0) {
      console.log(chalk.yellow('\nNo repositories registered.'));
      console.log(chalk.gray('  Add repos with: node index.js repos add <path>'));
      console.log(chalk.gray('  Or auto-discover: node index.js repos discover\n'));
      return;
    }

    console.log(chalk.bold.cyan(`\n🔧 Fixing ${repos.length} repositories\n`));
    const summary = [];

    for (const repo of repos) {
      console.log(chalk.bold(`\n${'─'.repeat(60)}`));
      console.log(chalk.bold.blue(`📁 ${repo.name}  ${chalk.gray(repo.path)}`));
      console.log(chalk.bold(`${'─'.repeat(60)}\n`));

      const agent = new Agent({ project: repo.path });
      await agent.init();

      try {
        const result = await fixProject(repo.path, agent, { dryRun: opts.dryRun });
        updateRepoStatus(repo.path, {
          lastFix: new Date().toISOString(),
          issueCount: result.total || 0,
          fixedCount: result.fixed || 0,
          status: (result.fixed || 0) === (result.total || 0) ? 'clean' : 'partial',
        });
        summary.push({ name: repo.name, path: repo.path, total: result.total || 0, fixed: result.fixed || 0 });
      } catch (err) {
        console.error(chalk.red(`Error fixing ${repo.name}: ${err.message}`));
        summary.push({ name: repo.name, path: repo.path, error: err.message });
      }

      await agent.close();
    }

    // Summary table
    console.log(chalk.bold.cyan(`\n${'═'.repeat(60)}`));
    console.log(chalk.bold.cyan('  Fix-All Summary'));
    console.log(chalk.bold.cyan(`${'═'.repeat(60)}\n`));
    for (const s of summary) {
      if (s.error) {
        console.log(chalk.red(`  ✗ ${s.name.padEnd(25)} ERROR: ${s.error.slice(0, 40)}`));
      } else if (s.total === 0) {
        console.log(chalk.green(`  ✓ ${s.name.padEnd(25)} No issues`));
      } else {
        const color = s.fixed === s.total ? chalk.green : chalk.yellow;
        console.log(color(`  ${s.fixed === s.total ? '✓' : '~'} ${s.name.padEnd(25)} Fixed ${s.fixed}/${s.total} issues`));
      }
    }
    console.log();
  });

// ── repos ─────────────────────────────────────────────────────────────────────
program
  .command('repos')
  .description('Manage repository registry')
  .addCommand(
    new Command('add')
      .argument('<path>', 'Repository path')
      .option('-t, --tags <tags>', 'Comma-separated tags', '')
      .option('-n, --name <name>', 'Custom name')
      .description('Register a repository')
      .action(async (path, opts) => {
        const chalk = (await import('chalk')).default;
        const { addRepo } = await import('./src/repos.js');
        const { Command: Cmd } = await import('commander');
        const added = addRepo(path, { tags: opts.tags.split(',').filter(Boolean), name: opts.name });
        console.log(chalk.green(`✓ Added: ${added}`));
      })
  )
  .addCommand(
    new Command('remove')
      .argument('<path>', 'Repository path')
      .description('Remove a repository from registry')
      .action(async (path) => {
        const chalk = (await import('chalk')).default;
        const { removeRepo } = await import('./src/repos.js');
        removeRepo(path);
        console.log(chalk.yellow(`✓ Removed: ${path}`));
      })
  )
  .addCommand(
    new Command('list')
      .description('List all registered repositories')
      .action(async () => {
        const chalk = (await import('chalk')).default;
        const { listRepos } = await import('./src/repos.js');
        const repos = listRepos();
        if (repos.length === 0) {
          console.log(chalk.gray('\nNo repositories registered.\n  node index.js repos add <path>\n  node index.js repos discover\n'));
          return;
        }
        console.log(chalk.bold(`\n${'─'.repeat(70)}`));
        console.log(chalk.bold(`  ${'Name'.padEnd(20)} ${'Status'.padEnd(10)} ${'Issues'.padEnd(8)} ${'Last Fix'.padEnd(20)} Path`));
        console.log(chalk.bold(`${'─'.repeat(70)}`));
        for (const r of repos) {
          const st = { clean: chalk.green, partial: chalk.yellow, unknown: chalk.gray }[r.status] || chalk.gray;
          const lastFix = r.last_fix ? new Date(r.last_fix).toLocaleDateString() : 'never';
          const issues = r.issue_count ? `${r.fixed_count}/${r.issue_count}` : '-';
          console.log(`  ${chalk.cyan(r.name.slice(0,18).padEnd(20))} ${st((r.status || 'unknown').padEnd(10))} ${issues.padEnd(8)} ${lastFix.padEnd(20)} ${chalk.gray(r.path)}`);
        }
        console.log(chalk.bold(`${'─'.repeat(70)}\n`));
      })
  )
  .addCommand(
    new Command('discover')
      .argument('[root]', 'Root directory to scan', process.env.HOME || '~')
      .option('--depth <n>', 'Max search depth', '3')
      .description('Auto-discover git repos under a directory and register them')
      .action(async (root, opts) => {
        const chalk = (await import('chalk')).default;
        const { discoverRepos, addRepo } = await import('./src/repos.js');
        console.log(chalk.cyan(`\nDiscovering git repos in: ${root}\n`));
        const found = discoverRepos(root, { maxDepth: parseInt(opts.depth) });
        if (found.length === 0) { console.log(chalk.gray('No git repos found')); return; }
        for (const p of found) {
          try { addRepo(p); console.log(chalk.green(`  ✓ ${p}`)); }
          catch (e) { console.log(chalk.gray(`  - ${p} (${e.message})`)); }
        }
        console.log(chalk.bold(`\nDiscovered ${found.length} repos\n`));
      })
  );

// ── analyze-di ────────────────────────────────────────────────────────────────
program
  .command('analyze-di [path]')
  .description('Dependency Injection correctness & architecture layer analysis')
  .option('--no-llm', 'Static analysis only (faster)')
  .option('--max-files <n>', 'Files for LLM analysis', '15')
  .option('-o, --output <file>', 'Save report to markdown file')
  .option('--provider <name>', 'LLM provider (groq, claude, ollama, free, copilot)')
  .option('--model <name>', 'Model name')
  .option('--fallback-provider <name>', 'Fallback provider used when provider=copilot')
  .action(async (path = '.', opts) => {
    applyModelOptions(opts);
    const chalk = (await import('chalk')).default;
    const { analyzeDI, renderDIReport } = await import('./src/tools/di-analyzer.js');
    const { writeFileSync } = await import('fs');

    console.log(chalk.cyan('\n🏗️  Analysing Dependency Injection & Architecture...\n'));
    const result = await analyzeDI(path, { llm: opts.llm !== false, maxFiles: parseInt(opts.maxFiles) });
    console.log(renderDIReport(result));

    if (opts.output) {
      const md = generateDIMarkdownReport(result);
      writeFileSync(opts.output, md, 'utf8');
      console.log(chalk.green(`\n✓ Report saved: ${opts.output}`));
    }
  });

function generateDIMarkdownReport(result) {
  const lines = [
    '# Dependency Injection Architecture Report',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Project:** \`${result.projectPath}\``,
    '',
    '## Summary',
    '',
    `| Property | Value |`,
    `|---|---|`,
    `| Architecture | ${result.architecture} |`,
    `| DI Framework | ${result.diFramework || 'none detected'} |`,
    `| Platform | ${result.platform} |`,
    `| DI Grade | **${result.grade}** |`,
    `| Files Scanned | ${result.filesScanned} |`,
    `| Total Violations | ${result.totalViolations} |`,
    `| Critical | ${result.criticals} |`,
    `| High | ${result.highs} |`,
    '',
  ];

  if (result.expectedLayers?.length) {
    lines.push(`**Expected layer order:** ${result.expectedLayers.join(' → ')}`, '');
  }

  if (result.staticFindings?.length) {
    lines.push('## DI Violations', '');
    for (const f of result.staticFindings.slice(0, 30)) {
      lines.push(`### [${f.severity?.toUpperCase()}] ${f.name}`, '');
      lines.push(`**File:** \`${f.file}\`:${f.line}  |  **Rule:** ${f.id}`, '');
      lines.push(f.description, '');
      if (f.code) lines.push('**Problematic code:**', '```', f.code, '```', '');
      if (f.fix) lines.push('**Best fix:**', '```', f.fix, '```', '');
      lines.push('---', '');
    }
  }

  if (result.layerViolations?.length) {
    lines.push('## Architecture Layer Violations', '');
    for (const v of result.layerViolations) {
      lines.push(`- **[${v.severity.toUpperCase()}]** ${v.rule}`);
      lines.push(`  - File: \`${v.file}\` imports \`${v.import}\``);
    }
    lines.push('');
  }

  for (const lr of (result.llmAnalysis || [])) {
    lines.push(`## LLM Analysis: \`${lr.file}\``, '');
    if (lr.overallAssessment) lines.push(`> ${lr.overallAssessment}`, '');
    lines.push(`**DI Pattern:** ${lr.diPatternDetected}  |  **Conformance:** ${lr.architectureConformance}  |  **Grade:** ${lr.grade}`, '');
    for (const v of (lr.violations || [])) {
      lines.push(`### [${v.severity?.toUpperCase()}] ${v.name} (${v.principle})`, '');
      if (v.description) lines.push(v.description, '');
      if (v.currentCode) lines.push('**Before:**', '```', v.currentCode, '```', '');
      if (v.fix) lines.push('**After (best fix):**', '```', v.fix, '```', '');
      if (v.explanation) lines.push(`**Why:** ${v.explanation}`, '');
    }
    if (lr.strengths?.length) {
      lines.push('**Strengths:**');
      for (const s of lr.strengths) lines.push(`- ${s}`);
      lines.push('');
    }
  }

  if (result.recommendations?.length) {
    lines.push('## Recommendations', '');
    for (const r of result.recommendations) lines.push(`- ${r}`);
  }

  return lines.join('\n');
}


program
  .command('review [path]')
  .description('Deep code review: file, project, or git diff — with concrete fixes')
  .option('-f, --file', 'Review a single file')
  .option('-d, --diff', 'Review only changed files (git diff)')
  .option('-s, --staged', 'Review staged changes only')
  .option('--no-llm', 'Static analysis only (faster, no API call)')
  .option('--max-files <n>', 'Max files for project review', '20')
  .option('--fix', 'Auto-apply all fixable findings after review')
  .option('-o, --output <file>', 'Save report to file (markdown)')
  .option('--provider <name>', 'LLM provider (groq, claude, ollama, free, copilot)')
  .option('--model <name>', 'Model name')
  .option('--fallback-provider <name>', 'Fallback provider used when provider=copilot')
  .action(async (path = '.', opts) => {
    applyModelOptions(opts);
    const chalk = (await import('chalk')).default;
    const { reviewFile, reviewProject, reviewDiff, applyFix, renderReviewReport } = await import('./src/tools/reviewer.js');
    const { existsSync, statSync, writeFileSync } = await import('fs');
    const { resolve } = await import('path');

    const abs = resolve(path);
    const useLLM = opts.llm !== false;

    let result;

    if (opts.diff) {
      console.log(chalk.cyan('\n🔍 Reviewing git diff...\n'));
      result = await reviewDiff(abs, { staged: opts.staged, llm: useLLM });

      if (result.message) { console.log(chalk.gray(result.message)); return; }

      // Print each file review
      for (const fr of (result.fileReviews || [])) {
        console.log(renderReviewReport(fr));
      }

      // Print holistic diff review
      if (result.diffReview) {
        console.log(chalk.bold.cyan('\n📊 Holistic Diff Review:'));
        const dr = result.diffReview;
        if (dr.summary) console.log(chalk.italic(dr.summary));
        for (const f of (dr.findings || [])) {
          const sevColor = { critical: chalk.bold.red, high: chalk.red, medium: chalk.yellow, low: chalk.gray }[f.severity] || chalk.white;
          console.log(`\n  ${sevColor(`[${f.severity?.toUpperCase()}]`)} ${chalk.bold(f.name)}`);
          if (f.description) console.log(chalk.white(`  ${f.description}`));
          if (f.fix) console.log(chalk.green(`  Fix: ${f.fix.slice(0, 200)}`));
        }
      }
      return;
    }

    // Single file
    if (opts.file || (existsSync(abs) && !statSync(abs).isDirectory())) {
      console.log(chalk.cyan(`\n🔍 Reviewing file: ${abs}\n`));
      result = await reviewFile(abs, { llm: useLLM });
      console.log(renderReviewReport(result));

      if (opts.fix && result.findings?.length) {
        console.log(chalk.cyan('\n🔧 Applying fixes...\n'));
        for (const f of result.findings.filter(f => f.fix && f.currentCode)) {
          const r = await applyFix(abs, f);
          if (r.applied) console.log(chalk.green(`  ✓ Fixed: ${f.name}`));
          else console.log(chalk.gray(`  - Skipped: ${f.name} (${r.error})`));
        }
      }
    } else {
      // Project review
      console.log(chalk.cyan(`\n🔍 Reviewing project: ${abs}\n`));
      console.log(chalk.gray(`  Mode: ${useLLM ? 'Static + LLM (thorough)' : 'Static only (fast)'}`));
      console.log(chalk.gray(`  Max files: ${opts.maxFiles}\n`));

      result = await reviewProject(abs, { llm: useLLM, maxFiles: parseInt(opts.maxFiles) });

      // Summary header
      const gradeColor = { A: chalk.green, B: chalk.greenBright, C: chalk.yellow, D: chalk.red, F: chalk.bold.red }[result.overallGrade] || chalk.white;
      console.log(chalk.bold(`\n${'═'.repeat(70)}`));
      console.log(`  Project Grade: ${gradeColor(`  ${result.overallGrade}  `)}  |  Files: ${result.filesReviewed}  |  Findings: ${result.totalFindings}  |  Critical: ${chalk.red(result.criticals)}  High: ${chalk.yellow(result.highs)}`);
      console.log(chalk.bold(`${'═'.repeat(70)}\n`));

      // Per-file summaries (worst first)
      for (const fr of result.files) {
        const gc = { A: chalk.green, B: chalk.greenBright, C: chalk.yellow, D: chalk.red, F: chalk.bold.red }[fr.grade] || chalk.white;
        console.log(renderReviewReport(fr));
      }

      if (opts.fix) {
        console.log(chalk.cyan('\n🔧 Applying all fixable findings...\n'));
        for (const fr of result.files) {
          for (const f of (fr.findings || []).filter(f => f.fix && f.currentCode)) {
            const r = await applyFix(fr.file, f);
            if (r.applied) console.log(chalk.green(`  ✓ ${fr.file}: ${f.name}`));
          }
        }
      }
    }

    // Save markdown report
    if (opts.output) {
      const md = generateMarkdownReport(result);
      writeFileSync(opts.output, md, 'utf8');
      console.log(chalk.green(`\n✓ Report saved: ${opts.output}`));
    }
  });

function generateMarkdownReport(review) {
  const lines = ['# Code Review Report', '', `**Date:** ${new Date().toISOString()}`, ''];
  const r = review;

  if (r.file) {
    lines.push(`## File: \`${r.file}\``, `**Grade:** ${r.grade}  |  **Findings:** ${r.findingCount}  |  **Critical:** ${r.criticals}`, '');
    if (r.summary) lines.push(`> ${r.summary}`, '');
  } else {
    lines.push(`## Project: \`${r.projectPath}\``, `**Overall Grade:** ${r.overallGrade}  |  **Files Reviewed:** ${r.filesReviewed}  |  **Total Findings:** ${r.totalFindings}`, '');
  }

  const findings = r.findings || r.files?.flatMap(f => f.findings?.map(fi => ({ ...fi, file: f.file }))) || [];
  if (findings.length) {
    lines.push('## Findings', '');
    for (const f of findings) {
      lines.push(`### [${f.severity?.toUpperCase()}] ${f.name}`, '');
      if (f.file) lines.push(`**File:** \`${f.file}\`${f.line ? `:${f.line}` : ''}`);
      lines.push(`**Category:** ${f.category}  |  **Severity:** ${f.severity}`, '');
      if (f.description) lines.push(f.description, '');
      if (f.currentCode || f.code) lines.push('**Current code:**', '```', f.currentCode || f.code, '```', '');
      if (f.fix) lines.push('**Best fix:**', '```', f.fix, '```', '');
      if (f.explanation) lines.push(`**Why:** ${f.explanation}`, '');
      lines.push('---', '');
    }
  }

  if (r.suggestions?.length) {
    lines.push('## Architectural Suggestions', '');
    for (const s of r.suggestions) lines.push(`- ${s}`);
    lines.push('');
  }

  if (r.apiContractFindings?.length) {
    lines.push('## API Contract Findings', '');
    for (const f of r.apiContractFindings) {
      lines.push(`### [${f.severity?.toUpperCase()}] ${f.name}`, '');
      if (f.file) lines.push(`**File:** \`${f.file}\``);
      if (f.description) lines.push(f.description, '');
      lines.push('---', '');
    }
  }

  if (r.apiContractSuggestions?.length) {
    lines.push('## API Contract Suggestions', '');
    for (const s of r.apiContractSuggestions) lines.push(`- ${s}`);
    lines.push('');
  }

  return lines.join('\n');
}


program
  .command('mobile [path]')
  .description('Mobile project commands: detect, analyze, test, lint, build, scan, fix')
  .addCommand(
    new Command('detect')
      .argument('[path]', 'Project path', '.')
      .description('Detect mobile platform (Swift/Kotlin/RN/Flutter)')
      .action(async (path) => {
        const chalk = (await import('chalk')).default;
        const { detectMobilePlatform } = await import('./src/tools/mobile.js');
        const result = detectMobilePlatform(path);
        const icon = { swift: '🍎', kotlin: '🤖', 'react-native': '⚛️', flutter: '🦋', unknown: '❓' }[result.platform] || '❓';
        console.log(`\n${icon}  Platform: ${chalk.bold.cyan(result.platform)} (${result.confidence} confidence)`);
        console.log(chalk.gray(JSON.stringify(result, null, 2)));
      })
  )
  .addCommand(
    new Command('analyze')
      .argument('[path]', 'Project path', '.')
      .description('Analyze mobile project structure')
      .action(async (path) => {
        const { analyzeMobileProject } = await import('./src/tools/mobile.js');
        const result = await analyzeMobileProject(path);
        console.log(JSON.stringify(result, null, 2));
      })
  )
  .addCommand(
    new Command('design')
      .argument('[path]', 'Project path', '.')
      .description('Inspect Figma/Sketch design handoff assets for mobile UI implementation')
      .action(async (path) => {
        const { detectDesignAssets } = await import('./src/tools/mobile.js');
        const result = await detectDesignAssets(path);
        console.log(JSON.stringify(result, null, 2));
      })
  )
  .addCommand(
    new Command('ui')
      .argument('<platform>', 'Target platform: swift, kotlin, react-native, or flutter')
      .argument('<url>', 'Figma/Sketch URL or local design export path')
      .option('-o, --output <dir>', 'Output directory', 'generated-ui')
      .option('--write', 'Write generated files to disk')
      .description('Generate platform-specific mobile UI scaffolds from a design source')
      .action(async (platform, url, opts) => {
        const { generateMobileUIFromDesign } = await import('./src/tools/mobile.js');
        const result = await generateMobileUIFromDesign(url, platform, { outputDir: opts.output, write: opts.write === true });
        if (result.error) {
          console.log(result.error);
          return;
        }
        console.log(JSON.stringify(result, null, 2));
      })
  )
  .addCommand(
    new Command('test')
      .argument('[path]', 'Project path', '.')
      .option('-p, --platform <platform>', 'Platform override')
      .description('Run mobile tests')
      .action(async (path, opts) => {
        const { runMobileTests } = await import('./src/tools/mobile.js');
        const result = await runMobileTests(path, opts.platform);
        console.log(result.stdout || result.stderr || JSON.stringify(result));
      })
  )
  .addCommand(
    new Command('lint')
      .argument('[path]', 'Project path', '.')
      .option('-p, --platform <platform>', 'Platform override')
      .option('--fix', 'Auto-fix lint issues')
      .description('Run mobile linter')
      .action(async (path, opts) => {
        const { runMobileLint, fixMobileLint } = await import('./src/tools/mobile.js');
        const result = opts.fix ? await fixMobileLint(path, opts.platform) : await runMobileLint(path, opts.platform);
        console.log(result.stdout || result.note || JSON.stringify(result));
      })
  )
  .addCommand(
    new Command('build')
      .argument('[path]', 'Project path', '.')
      .option('-p, --platform <platform>', 'Platform override')
      .option('--release', 'Release build')
      .description('Build mobile project')
      .action(async (path, opts) => {
        const { buildMobileProject } = await import('./src/tools/mobile.js');
        const result = await buildMobileProject(path, opts.platform, { release: opts.release });
        console.log(result.stdout || result.stderr || JSON.stringify(result));
      })
  )
  .addCommand(
    new Command('scan')
      .argument('[path]', 'Project path', '.')
      .option('-p, --platform <platform>', 'Platform override')
      .description('OWASP Mobile Top-10 security scan')
      .action(async (path, opts) => {
        const chalk = (await import('chalk')).default;
        const { scanMobileSecurity } = await import('./src/tools/mobile.js');
        const result = await scanMobileSecurity(path, opts.platform);
        const gradeColor = { A: chalk.green, B: chalk.green, C: chalk.yellow, D: chalk.red, F: chalk.bold.red }[result.grade] || chalk.white;
        console.log(`\nPlatform: ${chalk.cyan(result.platform)}`);
        console.log(`Grade: ${gradeColor(result.grade)}  |  Risk score: ${result.riskScore}`);
        console.log(`Files scanned: ${result.filesScanned}  |  Findings: ${result.findingCount} (${result.criticals} critical, ${result.highs} high, ${result.mediums} medium)\n`);
        if (result.findings?.length) {
          for (const f of result.findings.slice(0, 20)) {
            const sev = { CRITICAL: chalk.bold.red, HIGH: chalk.red, MEDIUM: chalk.yellow, LOW: chalk.gray }[f.severity] || chalk.white;
            console.log(`  ${sev(`[${f.severity}]`)} ${f.name}`);
            console.log(chalk.gray(`    ${f.file}:${f.line} — ${f.match.slice(0, 80)}`));
          }
        }
      })
  )
  .addCommand(
    new Command('fix')
      .argument('[path]', 'Project path', '.')
      .option('-a, --autonomous', 'No confirmations')
      .description('Detect and fix ALL mobile issues')
      .action(async (path, opts) => {
        if (opts.autonomous) process.env.SAFETY_MODE = 'autonomous';
        const { Agent }      = await import('./src/agent.js');
        const { fixProject } = await import('./src/tools/fixer.js');
        const agent = new Agent({ project: path });
        await agent.init();
        await fixProject(path, agent);
        await agent.close();
      })
  );

program
  .command('automation [path]')
  .description('Automation project commands: detect, analyze, test')
  .addCommand(
    new Command('detect')
      .argument('[path]', 'Project path', '.')
      .description('Detect Selenium/Appium automation projects')
      .action(async (path) => {
        const chalk = (await import('chalk')).default;
        const { detectAutomationPlatform } = await import('./src/tools/automation.js');
        const result = detectAutomationPlatform(path);
        const icon = { selenium: '🧪', appium: '📱', unknown: '❓' }[result.platform] || '❓';
        console.log(`\n${icon}  Platform: ${chalk.bold.cyan(result.platform)} (${result.confidence} confidence)`);
        console.log(chalk.gray(JSON.stringify(result, null, 2)));
      })
  )
  .addCommand(
    new Command('analyze')
      .argument('[path]', 'Project path', '.')
      .description('Analyze Selenium/Appium project structure')
      .action(async (path) => {
        const { analyzeAutomationProject } = await import('./src/tools/automation.js');
        const result = await analyzeAutomationProject(path);
        console.log(JSON.stringify(result, null, 2));
      })
  )
  .addCommand(
    new Command('test')
      .argument('[path]', 'Project path', '.')
      .option('-p, --platform <platform>', 'Platform override: selenium, appium, or auto', 'auto')
      .description('Run Selenium/Appium tests')
      .action(async (path, opts) => {
        const { runAutomationTests } = await import('./src/tools/automation.js');
        const result = await runAutomationTests(path, opts.platform);
        console.log(result.stdout || result.stderr || result.error || JSON.stringify(result));
      })
  );


// ── Jira / Confluence ─────────────────────────────────────────────────────────
program
  .command('jira [action] [args...]')
  .description('Work with Jira issues (search, get, create, comment, transitions)')
  .option('--max-results <n>', 'Search result limit', '10')
  .option('--project <key>', 'Project key for create')
  .option('--type <name>', 'Issue type for create', 'Task')
  .option('--summary <text>', 'Issue summary for create')
  .option('--description <text>', 'Issue description for create')
  .option('--priority <name>', 'Priority for create')
  .option('--labels <csv>', 'Comma-separated labels for create')
  .option('--comment <text>', 'Comment text for add-comment')
  .action(async (action = 'search', args = [], opts) => {
    const chalk = (await import('chalk')).default;
    const atl = await import('./src/tools/atlassian.js');

    switch (String(action).toLowerCase()) {
      case 'search': {
        const jql = args.join(' ') || opts.jql;
        if (!jql) return console.log(chalk.yellow('Usage: devlab jira search "project = ABC ORDER BY updated DESC"'));
        const result = await atl.searchJiraIssues(jql, { maxResults: parseInt(opts.maxResults, 10) });
        if (result.error) return console.log(chalk.red(result.error));
        console.log(chalk.bold.cyan(`\nJira search: ${result.jql}`));
        console.log(chalk.gray(`Total: ${result.total}\n`));
        for (const issue of result.issues || []) {
          console.log(`  ${chalk.cyan(issue.key)} ${chalk.white(issue.summary || '')}`);
          console.log(`    ${chalk.gray(issue.status || 'unknown')} ${issue.priority ? `| ${issue.priority}` : ''} ${issue.assignee ? `| ${issue.assignee}` : ''}`);
        }
        break;
      }
      case 'get': {
        const key = args[0];
        if (!key) return console.log(chalk.yellow('Usage: devlab jira get ABC-123'));
        const issue = await atl.getJiraIssue(key);
        if (issue.error) return console.log(chalk.red(issue.error));
        console.log(JSON.stringify(issue, null, 2));
        break;
      }
      case 'create': {
        if (!opts.project || !opts.summary) {
          return console.log(chalk.yellow('Usage: devlab jira create --project ABC --summary "..." [--type Bug]'));
        }
        const issue = await atl.createJiraIssue({
          projectKey: opts.project,
          issueType: opts.type,
          summary: opts.summary,
          description: opts.description,
          priority: opts.priority,
          labels: opts.labels,
        });
        console.log(JSON.stringify(issue, null, 2));
        break;
      }
      case 'comment': {
        const key = args[0];
        const text = opts.comment || args.slice(1).join(' ');
        if (!key || !text) return console.log(chalk.yellow('Usage: devlab jira comment ABC-123 --comment "text"'));
        const result = await atl.addJiraComment(key, text);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'transitions': {
        const key = args[0];
        if (!key) return console.log(chalk.yellow('Usage: devlab jira transitions ABC-123'));
        const result = await atl.getJiraTransitions(key);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'transition': {
        const key = args[0];
        const transitionId = args[1];
        if (!key || !transitionId) return console.log(chalk.yellow('Usage: devlab jira transition ABC-123 31'));
        const result = await atl.transitionJiraIssue(key, transitionId);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default:
        console.log(chalk.yellow('Actions: search, get, create, comment, transitions, transition'));
    }
  });

program
  .command('confluence [action] [args...]')
  .description('Work with Confluence pages (search, get, create, update, children)')
  .option('--limit <n>', 'Search result limit', '10')
  .option('--space <key>', 'Space key for create')
  .option('--title <text>', 'Page title for create/update')
  .option('--body <xhtml>', 'Page body storage XHTML for create/update')
  .option('--parent <id>', 'Parent page ID for create')
  .option('--id <id>', 'Page ID for get/update/children')
  .option('--version <n>', 'Current version number for update')
  .action(async (action = 'search', args = [], opts) => {
    const chalk = (await import('chalk')).default;
    const atl = await import('./src/tools/atlassian.js');

    switch (String(action).toLowerCase()) {
      case 'search': {
        const cql = args.join(' ') || opts.cql;
        if (!cql) return console.log(chalk.yellow('Usage: devlab confluence search "space = DOCS ORDER BY lastmodified DESC"'));
        const result = await atl.searchConfluencePages(cql, { limit: parseInt(opts.limit, 10) });
        if (result.error) return console.log(chalk.red(result.error));
        console.log(chalk.bold.cyan(`\nConfluence search: ${result.cql}`));
        console.log(chalk.gray(`Total: ${result.size}\n`));
        for (const page of result.results || []) {
          console.log(`  ${chalk.cyan(page.id)} ${chalk.white(page.title || '')}`);
          console.log(`    ${chalk.gray(page.space || 'unknown')} ${page.version ? `| v${page.version}` : ''}`);
        }
        break;
      }
      case 'get': {
        const id = opts.id || args[0];
        if (!id) return console.log(chalk.yellow('Usage: devlab confluence get 123456'));
        const page = await atl.getConfluencePage(id);
        if (page.error) return console.log(chalk.red(page.error));
        console.log(JSON.stringify(page, null, 2));
        break;
      }
      case 'create': {
        if (!opts.space || !opts.title || !opts.body) {
          return console.log(chalk.yellow('Usage: devlab confluence create --space DOCS --title "..." --body "<p>...</p>"'));
        }
        const page = await atl.createConfluencePage({
          spaceKey: opts.space,
          title: opts.title,
          body: opts.body,
          parentPageId: opts.parent,
        });
        console.log(JSON.stringify(page, null, 2));
        break;
      }
      case 'update': {
        if (!opts.id || !opts.title || !opts.body || !opts.version) {
          return console.log(chalk.yellow('Usage: devlab confluence update --id 123456 --version 4 --title "..." --body "<p>...</p>"'));
        }
        const page = await atl.updateConfluencePage({
          pageId: opts.id,
          title: opts.title,
          body: opts.body,
          currentVersion: parseInt(opts.version, 10),
        });
        console.log(JSON.stringify(page, null, 2));
        break;
      }
      case 'children': {
        const id = opts.id || args[0];
        if (!id) return console.log(chalk.yellow('Usage: devlab confluence children 123456'));
        const page = await atl.getConfluenceChildPages(id, { limit: parseInt(opts.limit, 10) });
        console.log(JSON.stringify(page, null, 2));
        break;
      }
      case 'recent': {
        const page = await atl.getRecentConfluencePages();
        console.log(JSON.stringify(page, null, 2));
        break;
      }
      default:
        console.log(chalk.yellow('Actions: search, get, create, update, children, recent'));
    }
  });

program
  .command('develop <issueKey>')
  .description('Create a Jira-driven development brief, task breakdown, technical design, and optional Confluence page')
  .option('--space <key>', 'Confluence space key for the brief')
  .option('--parent <id>', 'Parent Confluence page ID')
  .option('--title <text>', 'Confluence page title')
  .option('--no-page', 'Do not create a Confluence page')
  .option('--no-comment-jira', 'Do not comment the Jira issue')
  .option('--skip-page-confirmation', 'Do not ask before creating the Confluence page')
  .option('--ci', 'Run CI gate before creating the Confluence page')
  .option('--repo <path>', 'Project path to run CI against', process.cwd())
  .option('--ci-output <file>', 'Save CI markdown report to a file')
  .action(async (issueKey, opts) => {
    const chalk = (await import('chalk')).default;
    const { developFromJira } = await import('./src/tools/atlassian.js');
    const { writeFileSync } = await import('fs');

    if (opts.ci) {
      const { runCI, renderCIReport, generateCIMarkdown } = await import('./src/tools/ci.js');
      console.log(chalk.cyan(`\n🔎 Running CI gate for ${opts.repo}...\n`));
      const ciReport = await runCI(opts.repo, { coverage: true, maxFiles: 15 });
      console.log(renderCIReport(ciReport));
      if (opts.ciOutput) {
        writeFileSync(opts.ciOutput, generateCIMarkdown(ciReport), 'utf8');
        console.log(chalk.green(`\n✓ CI report saved: ${opts.ciOutput}`));
      }
      if (!ciReport.summary.passed) {
        console.log(chalk.red('\nCI failed — fix the issues before raising the PR.\n'));
        process.exitCode = 1;
        return;
      }
    }

    let createPage = opts.page !== false;
    if (createPage && !opts.skipPageConfirmation) {
      createPage = await promptYesNo(`Create a Confluence page for ${issueKey}?`);
      if (!createPage) {
        console.log(chalk.gray('Confluence page creation skipped by user.'));
      }
    }

    const result = await developFromJira(issueKey, {
      spaceKey: opts.space,
      parentPageId: opts.parent,
      pageTitle: opts.title,
      createPage,
      commentJira: createPage && opts.commentJira !== false,
    });

    if (result.error) {
      console.log(chalk.red(`\n${result.error}\n`));
      process.exitCode = 1;
      return;
    }

    console.log(chalk.bold.cyan(`\n${result.issue.key}: ${result.issue.summary}`));
    console.log(chalk.gray(`Status: ${result.issue.status || 'n/a'} | Priority: ${result.issue.priority || 'n/a'}`));
    console.log(chalk.bold('\nTask breakdown:'));
    for (const task of result.tasks || []) console.log(`  • ${task}`);

    if (result.page) {
      console.log(chalk.green(`\nConfluence page created: ${result.page.id || 'yes'}`));
    } else if (opts.page === false) {
      console.log(chalk.gray('\nConfluence page creation skipped.'));
    }
  });

program
  .command('ci [path]')
  .description('Run the pre-PR CI gate: tests, security, dependencies, and DI checks')
  .option('-o, --output <file>', 'Save markdown report to file')
  .option('--max-files <n>', 'Max files for DI analysis', '15')
  .action(async (path = '.', opts) => {
    const chalk = (await import('chalk')).default;
    const { writeFileSync } = await import('fs');
    const { runCI, renderCIReport, generateCIMarkdown } = await import('./src/tools/ci.js');

    console.log(chalk.cyan(`\n🔎 Running CI gate for ${path}...\n`));
    const report = await runCI(path, { coverage: true, maxFiles: parseInt(opts.maxFiles, 10) });
    console.log(renderCIReport(report));

    if (opts.output) {
      writeFileSync(opts.output, generateCIMarkdown(report), 'utf8');
      console.log(chalk.green(`\n✓ CI report saved: ${opts.output}`));
    }

    if (!report.summary.passed) process.exitCode = 1;
  });

// ── test ──────────────────────────────────────────────────────────────────────
program
  .command('test [path]')
  .description('Run tests, show coverage & find untested files (all platforms)')
  .option('-c, --coverage', 'Collect and show coverage report')
  .option('-f, --filter <pattern>', 'Run only tests matching pattern')
  .option('--framework <name>', 'Force a specific framework (jest/vitest/pytest/etc)')
  .option('--bail', 'Stop after first failure')
  .option('-v, --verbose', 'Verbose test output')
  .option('--gaps', 'Show untested file gaps only (no test run)')
  .option('-o, --output <file>', 'Save markdown report to file')
  .action(async (path = '.', opts) => {
    const chalk = (await import('chalk')).default;
    const { runTests, findTestGaps, detectTestFramework, renderTestReport, generateTestMarkdown } = await import('./src/tools/tester.js');
    const { writeFileSync } = await import('fs');

    if (opts.gaps) {
      console.log(chalk.cyan('\n🔍  Scanning for untested files...\n'));
      const gaps = findTestGaps(path);
      const coverColor = gaps.coverageRatio >= 80 ? chalk.green : gaps.coverageRatio >= 50 ? chalk.yellow : chalk.red;
      console.log(`  Language     : ${chalk.bold(gaps.lang)}`);
      console.log(`  Source files : ${gaps.srcFiles}`);
      console.log(`  Test files   : ${gaps.testFiles}`);
      console.log(`  Ratio        : ${coverColor(gaps.coverageRatio + '%')}`);
      if (gaps.untestedFiles.length === 0) {
        console.log(chalk.green('\n  ✓ All source files have test coverage!\n'));
      } else {
        console.log(chalk.yellow(`\n  Files without tests (${gaps.untestedFiles.length}):`));
        gaps.untestedFiles.forEach(f => console.log(chalk.gray(`    • ${f}`)));
        console.log('');
      }
      return;
    }

    const detected = detectTestFramework(path);
    if (opts.framework) {
      console.log(chalk.cyan(`\n🧪  Running tests with: ${opts.framework}\n`));
    } else if (detected.length > 0) {
      console.log(chalk.cyan(`\n🧪  Detected: ${detected.map(f => f.name).join(', ')}\n`));
    } else {
      console.log(chalk.yellow('\n⚠️  No test framework detected. Analysing project...\n'));
    }

    const result = await runTests(path, {
      coverage:  opts.coverage  || false,
      filter:    opts.filter    || null,
      framework: opts.framework || null,
      bail:      opts.bail      || false,
      verbose:   opts.verbose   || false,
    });

    console.log(renderTestReport(result));

    if (opts.output) {
      const md = generateTestMarkdown(result);
      writeFileSync(opts.output, md, 'utf8');
      console.log(chalk.green(`\n✓ Report saved: ${opts.output}`));
    }

    const anyFailed = (result.results || []).some(r => !r.success);
    if (anyFailed) process.exitCode = 1;
  });


// ── UI command ────────────────────────────────────────────────────────────────
program
  .command('ui [path]')
  .description('Launch the Cursor-like web IDE for a project')
  .option('-p, --port <port>', 'Port to listen on (default: 4321)')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (projectPath = '.', opts) => {
    if (opts.port) process.env.UI_PORT = opts.port;
    const { startUI } = await import('./ui/server.js');
    const server = await startUI(projectPath);
    const port = process.env.UI_PORT || 4321;
    if (opts.open !== false) {
      const { exec } = await import('child_process');
      const url = `http://localhost:${port}`;
      const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${open} ${url}`);
    }
    // Keep process alive
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
  });

// ── serve command — one command to start everything ──────────────────────────
program
  .command('serve [path]')
  .description('Start DevLab server (web UI + model API + agent WebSocket) — alias for production hosting')
  .option('-p, --port <port>', 'Port to listen on (default: 4321)')
  .option('--host <host>', 'Host to bind (default: 0.0.0.0 for remote access)')
  .option('--no-open', 'Do not open browser')
  .option('--model-server', 'Also start Ollama model server if not running')
  .action(async (projectPath = '.', opts) => {
    const chalk = (await import('chalk')).default;
    const port = opts.port || process.env.UI_PORT || '4321';
    const host = opts.host || process.env.DEVLAB_HOST || '0.0.0.0';
    process.env.UI_PORT = port;
    process.env.DEVLAB_HOST = host;

    // Optionally ensure Ollama is running (cross-platform)
    if (opts.modelServer) {
      const { spawn } = await import('child_process');
      const isWin = process.platform === 'win32';
      const ollamaProc = spawn('ollama', ['serve'], {
        detached: true, stdio: 'ignore', shell: isWin,
      });
      ollamaProc.unref();
      console.log(chalk.gray('[model] Ollama started'));
      await new Promise(r => setTimeout(r, 1500));
    }

    const { startUI } = await import('./ui/server.js');
    const server = await startUI(projectPath);

    const localUrl  = `http://localhost:${port}`;
    const remoteUrl = `http://<server-ip>:${port}`;

    console.log(chalk.bold.cyan('\n  DevLab Server Ready\n'));
    console.log(chalk.white(`  Web UI       : ${chalk.underline(localUrl)}`));
    console.log(chalk.white(`  Remote access: ${chalk.underline(remoteUrl)}`));
    console.log(chalk.gray( `  Model API    : ${localUrl}/v1/chat/completions  (OpenAI-compatible)`));
    console.log(chalk.gray( `  Models list  : ${localUrl}/v1/models`));
    console.log(chalk.gray( `  WebSocket    : ws://localhost:${port}/ws`));
    console.log(chalk.gray( `  Auth         : set DEVLAB_API_KEY env var to enable Bearer auth`));
    console.log(chalk.gray( `\n  Provider      : ${process.env.MODEL_PROVIDER || 'groq (default)'}`));
    console.log(chalk.gray( `  Model         : ${process.env.MODEL_NAME || 'auto'}`));
    if (process.env.OPENAI_COMPAT_BASE_URL) {
      console.log(chalk.gray(`  Local model   : ${process.env.OPENAI_COMPAT_BASE_URL}`));
    }
    console.log();

    if (opts.open !== false) {
      const { exec } = await import('child_process');
      if (process.platform === 'darwin') exec(`open ${localUrl}`);
      else if (process.platform === 'win32') exec(`cmd /c start ${localUrl}`);
      else exec(`xdg-open ${localUrl}`);
    }

    process.on('SIGINT',  () => { console.log(chalk.gray('\nShutting down...')); server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
  });

program
  .command('check [path]')
  .description('Detect issues in a project without fixing (alias for fix --dry-run)')
  .action(async (path = '.') => {
    const chalk = (await import('chalk')).default;
    const { detectIssues } = await import('./src/tools/fixer.js');
    const { updateRepoStatus } = await import('./src/repos.js');
    const result = await detectIssues(path);
    updateRepoStatus(path, { lastScan: new Date().toISOString(), issueCount: result.issueCount });

    if (result.issueCount === 0) {
      console.log(chalk.green('\n✓ No issues found!\n'));
      return;
    }
    console.log(chalk.yellow(`\nFound ${result.issueCount} issues in ${path}:\n`));
    result.issues.forEach((iss, i) => {
      const sev = { critical: chalk.red, high: chalk.yellow, medium: chalk.cyan, low: chalk.gray }[iss.severity] || chalk.white;
      console.log(`  ${i + 1}. ${sev(`[${iss.severity.toUpperCase()}]`)} ${iss.type}: ${iss.message}`);
      if (iss.detail) console.log(chalk.gray(`     ${iss.detail.split('\n')[0].slice(0, 80)}`));
    });
    console.log(chalk.gray(`\n  Run "node index.js fix ${path}" to auto-fix\n`));
  });

program.parse();

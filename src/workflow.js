// src/workflow.js — YAML-defined automated workflow engine
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join, basename } from 'path';
import { parse as parseYAML } from 'yaml';
import { WORKFLOWS_DIR } from './config.js';
import { printWorkflow, printError, printSuccess, printTool } from './ui.js';

function loadWorkflow(nameOrPath) {
  // Try exact path first
  if (existsSync(nameOrPath)) {
    return parseYAML(readFileSync(nameOrPath, 'utf8'));
  }

  // Try workflows directory
  const candidates = [
    join(WORKFLOWS_DIR, `${nameOrPath}.yaml`),
    join(WORKFLOWS_DIR, `${nameOrPath}.yml`),
    join(WORKFLOWS_DIR, 'examples', `${nameOrPath}.yaml`),
    join(WORKFLOWS_DIR, 'examples', `${nameOrPath}.yml`),
    join(process.cwd(), '.devlab', 'workflows', `${nameOrPath}.yaml`),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return parseYAML(readFileSync(c, 'utf8'));
  }

  throw new Error(`Workflow not found: ${nameOrPath}`);
}

export function listWorkflows() {
  const results = [];
  const dirs = [
    WORKFLOWS_DIR,
    join(WORKFLOWS_DIR, 'examples'),
    join(process.cwd(), '.devlab', 'workflows'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const f of files) {
        try {
          const wf = parseYAML(readFileSync(join(dir, f), 'utf8'));
          results.push({ name: basename(f, '.yaml').replace('.yml', ''), description: wf.description || '', steps: (wf.steps || []).length, path: join(dir, f) });
        } catch {}
      }
    } catch {}
  }
  return results;
}

/**
 * Run a workflow. Each step is either:
 *   - { type: 'agent', prompt: '...' }   → send prompt to agent
 *   - { type: 'tool', name: '...', args: {} }  → call tool directly
 *   - { type: 'shell', command: '...' }  → run shell command
 *   - { type: 'condition', if: '...', then: [...], else: [...] } → branching
 */
export async function runWorkflow(nameOrPath, params = {}, { agent, executeTool } = {}) {
  const wf = loadWorkflow(nameOrPath);
  printWorkflow(`Starting: ${wf.name || nameOrPath}`);
  if (wf.description) printWorkflow(wf.description);

  const steps = wf.steps || [];
  const context = { ...params, results: [] };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    printWorkflow(`Step ${i + 1}/${steps.length}: ${step.name || step.type}`);

    let result;
    try {
      result = await executeStep(step, context, { agent, executeTool });
      context.results.push({ step: step.name || step.type, result });

      if (step.save_as) context[step.save_as] = result;
      if (step.on_success) printSuccess(step.on_success);
    } catch (err) {
      printError(`Step failed: ${err.message}`);
      if (step.on_error === 'continue') continue;
      if (step.on_error === 'skip') { context.results.push({ step: step.name || step.type, skipped: true }); continue; }
      throw err;
    }
  }

  printWorkflow(`Completed: ${wf.name || nameOrPath}`);
  return context.results;
}

async function executeStep(step, context, { agent, executeTool }) {
  const interpolate = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{(\w+)\}\}/g, (_, k) => context[k] ?? `{{${k}}}`);
  };

  switch (step.type) {
    case 'agent': {
      if (!agent) throw new Error('Agent not provided to workflow');
      const prompt = interpolate(step.prompt);
      return agent.run(prompt);
    }

    case 'tool': {
      if (!executeTool) throw new Error('executeTool not provided');
      const args = Object.fromEntries(Object.entries(step.args || {}).map(([k, v]) => [k, interpolate(v)]));
      return executeTool(step.name, args);
    }

    case 'shell': {
      const { runCommand } = await import('./tools/shell.js');
      return runCommand(interpolate(step.command), { cwd: interpolate(step.cwd || '.') });
    }

    case 'condition': {
      const condition = interpolate(step.if);
      const passed = evalCondition(condition, context);
      const branchSteps = passed ? (step.then || []) : (step.else || []);
      const results = [];
      for (const s of branchSteps) {
        results.push(await executeStep(s, context, { agent, executeTool }));
      }
      return results;
    }

    case 'parallel': {
      return Promise.all((step.steps || []).map(s => executeStep(s, context, { agent, executeTool })));
    }

    case 'loop': {
      const items = context[step.over] || [];
      const results = [];
      for (const item of items) {
        const loopCtx = { ...context, [step.as || 'item']: item };
        for (const s of (step.steps || [])) {
          results.push(await executeStep(s, loopCtx, { agent, executeTool }));
        }
      }
      return results;
    }

    case 'wait': {
      const ms = (step.seconds || 1) * 1000;
      await new Promise(r => setTimeout(r, ms));
      return { waited: step.seconds };
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function evalCondition(condition, context) {
  try {
    // Simple safe evaluation — only check context values
    if (condition.includes('==')) {
      const [left, right] = condition.split('==').map(s => s.trim());
      return String(context[left] ?? left) === String(context[right] ?? right).replace(/['"]/g, '');
    }
    if (condition.includes('!=')) {
      const [left, right] = condition.split('!=').map(s => s.trim());
      return String(context[left] ?? left) !== String(context[right] ?? right).replace(/['"]/g, '');
    }
    return !!context[condition];
  } catch { return false; }
}

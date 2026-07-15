// Subagents — spawn lightweight child agents with isolated context and
// role-scoped tools. The parent delegates a focused task ("explore the codebase",
// "run and fix tests") and receives only a compact summary back, keeping the
// parent's context window clean. This mirrors Claude Code's subagent architecture.
import { routeChat, roleTier } from './router.js';
import { printTool, printMemory } from './ui.js';
import { sanitizeForLLM, auditLog } from './security.js';
import chalk from 'chalk';

// Role definitions: system prompt + allowed tools. Restricting tools makes
// subagents faster (smaller tool schema), safer, and more focused.
const ROLES = {
  explorer: {
    description: 'Read-only codebase exploration and research. CANNOT modify files.',
    prompt: `You are a codebase exploration subagent. Investigate the codebase to answer the task precisely.
Rules: You are READ-ONLY — never attempt to modify anything. Be thorough but efficient.
End with a structured report: key findings, relevant file paths (with line context where useful), and direct answers to the task.`,
    tools: ['read_file', 'list_files', 'search_files', 'semantic_search', 'git_status', 'git_diff', 'analyze_project', 'detect_build_system', 'detect_architecture', 'knowledge_base', 'project_rules'],
  },
  coder: {
    description: 'Focused implementation of a specific, well-defined code change.',
    prompt: `You are a coding subagent. Implement EXACTLY the change described in the task — nothing more.
Rules: Make minimal, surgical edits. After changing code, verify it compiles/parses if a build tool is available.
End with a report: files changed (with a one-line description each), and any follow-ups the parent agent should know.`,
    tools: ['read_file', 'write_file', 'list_files', 'search_files', 'run_command', 'build_project', 'detect_build_system', 'git_status', 'git_diff', 'knowledge_base'],
  },
  tester: {
    description: 'Run tests/builds, diagnose failures, optionally fix them.',
    prompt: `You are a testing subagent. Run the tests/builds relevant to the task, diagnose any failures, and fix them if the task asks you to.
End with a report: what was run, pass/fail per check, root cause of failures, and fixes applied (if any).`,
    tools: ['read_file', 'write_file', 'list_files', 'search_files', 'run_command', 'build_project', 'detect_build_system', 'run_ci', 'pr_baseline', 'generate_tests'],
  },
  reviewer: {
    description: 'Review code/diffs for bugs, security, and quality. Read-only.',
    prompt: `You are a code review subagent. Review the code/diff described in the task with high signal-to-noise: only real bugs, security issues, and significant quality problems — no style nitpicks.
Rules: READ-ONLY — report issues, do not fix them.
End with a report: issues found (severity, file, line, why it matters, suggested fix), or a clean bill of health.`,
    tools: ['read_file', 'list_files', 'search_files', 'git_status', 'git_diff', 'scan_security', 'analyze_performance', 'score_rubric', 'analyze_di', 'detect_layer_violations'],
  },
  general: {
    description: 'Full-capability subagent for complex multi-step subtasks.',
    prompt: `You are a general-purpose subagent. Complete the task autonomously and end with a concise report of what you did, what you found, and anything the parent agent must know.`,
    tools: null, // null = all tools
  },
};

const SUBAGENT_MAX_ITERATIONS = 15;
const RESULT_CAP = 4000; // chars returned to the parent

export function listRoles() {
  return Object.entries(ROLES).map(([name, r]) => ({ role: name, description: r.description, tools: r.tools ? r.tools.length : 'all' }));
}

export async function runSubagent({ task, role = 'general', path: project = process.cwd(), maxIterations, provider, model, context } = {}) {
  if (!task) return { error: 'task is required' };
  const roleDef = ROLES[role] || ROLES.general;
  const limit = Math.min(maxIterations || SUBAGENT_MAX_ITERATIONS, 25);

  // Lazy import to avoid circular dependency (tools/index.js imports this module)
  const { getToolDefinitions, executeTool } = await import('./tools/index.js');
  let tools = await getToolDefinitions();
  if (roleDef.tools) {
    const allowed = new Set(roleDef.tools);
    tools = tools.filter(t => allowed.has(t.function.name));
  } else {
    // even 'general' subagents must not recurse into more subagents
    tools = tools.filter(t => t.function.name !== 'delegate_task');
  }

  const system = {
    role: 'system',
    content: `${roleDef.prompt}\n\nWorking directory: ${project}${context ? `\n\nContext from parent agent:\n${context}` : ''}\n\nYou have ${limit} steps maximum — be efficient. Your final message is your report to the parent agent; make it complete and self-contained.`,
  };
  const messages = [system, { role: 'user', content: task }];

  printMemory(`Subagent [${role}] started: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);

  const toolsUsed = [];
  let report = '';
  let iterations = 0;
  const started = Date.now();

  while (iterations < limit) {
    iterations++;
    let response;
    try {
      response = await routeChat({ messages, tools, stream: false, provider, model, taskText: task, escalate: roleTier(role) === 'complex' });
    } catch (err) {
      // one retry with brief backoff, then fail gracefully
      await new Promise(r => setTimeout(r, 1500));
      try {
        response = await routeChat({ messages, tools, stream: false, provider, model, taskText: task, escalate: roleTier(role) === 'complex' });
      } catch (err2) {
        return { role, error: `Subagent LLM failure: ${err2.message}`, toolsUsed, iterations };
      }
    }

    const { content, toolCalls } = response;
    if (!toolCalls || toolCalls.length === 0) {
      report = content || '(subagent returned no report)';
      break;
    }

    messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* tolerate */ }
      printTool(chalk.dim(`  └ [${role}] ${name} ${JSON.stringify(args).slice(0, 60)}`));
      toolsUsed.push(name);

      let result;
      try {
        result = await executeTool(name, args, { project, cwd: project });
      } catch (e) {
        result = { error: e.message };
      }
      auditLog({ type: 'subagent-tool', role, tool: name, project, args: JSON.stringify(args).slice(0, 300), ok: !result?.error });

      let text = typeof result === 'string' ? result : JSON.stringify(result);
      if (text.length > 6000) text = text.slice(0, 4500) + `\n…[truncated ${text.length - 6000} chars]…\n` + text.slice(-1500);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: sanitizeForLLM(name, text) });
    }
  }

  if (!report) report = 'Subagent hit its iteration limit before producing a final report. Partial work may exist — check tool activity.';
  if (report.length > RESULT_CAP) report = report.slice(0, RESULT_CAP) + '\n…(report truncated)';

  const durationS = ((Date.now() - started) / 1000).toFixed(1);
  printMemory(`Subagent [${role}] finished in ${durationS}s (${iterations} steps, ${toolsUsed.length} tool calls)`);

  return {
    role,
    task: task.slice(0, 200),
    report,
    iterations,
    toolsUsed: [...new Set(toolsUsed)],
    durationSeconds: Number(durationS),
  };
}

// Run multiple subagents sequentially (parallel LLM calls can hit rate limits;
// sequential is predictable and still isolates context per task).
export async function runSubagents(tasks = [], shared = {}) {
  const results = [];
  for (const t of tasks) {
    results.push(await runSubagent({ ...shared, ...t }));
  }
  return { count: results.length, results };
}

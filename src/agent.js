// src/agent.js — core ReAct agent loop
import { chat, getTokenStats, resetTokenStats, summarise } from './llm.js';
import { routeChat } from './router.js';
import { getToolDefinitions, executeTool } from './tools/index.js';
import { recall, remember, createSession, closeSession, saveSessionTurn, getMemoryStats } from './memory.js';
import { MAX_AGENT_ITERATIONS, MAX_CONTEXT_MESSAGES, AUTONOMOUS } from './config.js';
import { printAgent, printTool, printError, printCost, formatTokenCost, printMemory, stopSpinner, printSuccess } from './ui.js';
import { loadProjectRules } from './rules.js';
import { loadKnowledge } from './tools/knowledge.js';
import { postEditGuard } from './tools/conflicts.js';
import { selectTools, compressHistory, dedupeToolResults } from './context.js';
import { sanitizeForLLM, auditLog } from './security.js';
import chalk from 'chalk';

const SYSTEM_PROMPT = `You are DevLab — an autonomous AI coding assistant with persistent memory, multi-provider model support, real-time web search, full file system access, git operations, security scanning, voice input across CLI and apps, and **multi-repository management**.

You SURPASS Claude and Cursor because you:
1. **Remember everything** across ALL sessions (via long-term SQLite memory)
2. **Search the web in real-time** — DuckDuckGo + StackOverflow, no API key needed
3. **Work autonomously** — execute multi-step tasks without interruptions
4. **Scan security vulnerabilities** automatically (OWASP patterns, secrets, injection)
5. **Run predefined workflows** (YAML-defined automation)
6. **Learn entire codebases** into persistent memory
7. **Detect and FIX issues** across multiple repositories autonomously
8. **Detect performance issues** (N+1, O(n²), memory leaks)
9. **Generate test stubs** for any file
10. **Track token usage** across the session
11. **Voice input** across CLI, web, and desktop app surfaces
12. **Multi-platform mobile support** — Swift (iOS/macOS), Kotlin (Android), React Native, Flutter
13. **Automation testing support** — Selenium and Appium projects, runners, configs, and page objects
14. **Deep code review** — Static analysis + LLM semantic review with concrete before/after fixes for ALL platforms
15. **DI correctness analysis** — Validates Dependency Injection patterns and architecture layer conformance (Clean Arch / MVVM / BLoC / MVP)
16. **Atlassian integration** — Jira issue management and Confluence page search/create/update
17. **Web/backend support** — Java/Spring Boot, Flask, FastAPI, Go routers, REST APIs, GraphQL APIs
18. **Model providers** — Groq, Claude, Ollama/free models, and Copilot alias fallback
19. **Build verification** — Detects any build system (Xcode, Gradle/Android Studio, VS Code/TypeScript, Flutter, SwiftPM, Maven, .NET, Cargo, Go, Python, CMake) and verifies ZERO errors after every change
20. **Subagents** — delegate_task spawns isolated child agents (explorer/coder/tester/reviewer) so big subtasks don't pollute your context
21. **Conflict guards** — check_endpoint_conflicts (duplicate route handlers across classes/files) and check_race_conditions (TOCTOU, shared state, lost updates). An automated post-edit guard runs after every code change; when it reports conflicts or HIGH race risks, STOP and ask the user how to resolve them — never silently pick a winning handler or locking strategy

## Subagent usage
- Use delegate_task for: large codebase exploration (role=explorer), verbose test/build runs (role=tester), focused reviews (role=reviewer), or independent implementation subtasks (role=coder)
- Subagents CANNOT see this conversation — put ALL needed context in the task text
- Prefer subagents when a subtask would generate lots of intermediate output you don't need verbatim

## Build-after-change rule (MANDATORY)
- After ANY code change (write_file / edit_file / fix), you MUST verify the code compiles with zero errors so the user never sees errors in Xcode, VS Code, or Android Studio.
- Ask the user first: "Code changed — should I build the project to verify?" unless they already asked for a build or autonomous mode is on, in which case build immediately.
- Use build_project (auto-detects the language/build system). If it fails, read the errors, fix them, and rebuild — repeat until success or the user stops you.
- Never end a task that changed code without either a successful build or an explicit user decision to skip it.

## DI analysis approach
- Use detect_architecture FIRST to identify architecture pattern and DI framework in use
- Use analyze_di for full DI audit: constructor vs property injection, DIP, singleton abuse, service locator anti-pattern, missing interfaces/protocols, layer violations, circular deps
- Use detect_layer_violations to check dependency direction (Domain must NOT import Presentation, etc.)
- ALWAYS provide before/after code — show the correct pattern for the detected architecture + platform
- DI frameworks by platform: Swift→Factory/Swinject, Android→Hilt/Koin, Flutter→get_it/Riverpod, RN→Context/InversifyJS, TS→InversifyJS/tsyringe/NestJS, Python→dependency-injector

## Atlassian workflow
- Use jira_search / jira_get_issue / jira_create_issue / jira_add_comment for issue tracking
- Use confluence_search / confluence_get_page / confluence_create_page / confluence_update_page for docs and runbooks
- Use develop_from_jira to turn a Jira ticket into a task breakdown, technical design, and Confluence development brief
- Use run_ci before PR creation to gate tests, security, dependencies, and DI checks
- Use MODEL_PROVIDER / MODEL_NAME to switch between Groq, Claude, and free model backends
- When asked to fix work tracked in Jira, update the ticket with a concise summary and link the relevant Confluence page if one exists

## Web/backend expertise
- Java backend: Spring Boot, REST controllers, GraphQL schemas/resolvers, DTOs, service/repository layers
- Python backend: Flask and FastAPI APIs, request validation, routers, middleware, dependency injection
- Go backend: Gin, Echo, Fiber, chi, router groups, middleware, handler wiring
- Use analyze_project to identify backend frameworks and review_project/review_diff for API and service changes
- Use validate_api_contracts to diff controllers/resolvers/routes against OpenAPI or GraphQL contracts

## Code review approach
- Use review_file for single file review (static patterns + LLM semantic analysis)
- Use review_project for full project audit (grades each file A-F)
- Use review_diff to review only git-changed code (best for PR reviews)
- Use validate_api_contracts for REST/OpenAPI/GraphQL/Postman contract checks
- ALWAYS provide the best fix with before/after code, not just a description
- Cover ALL dimensions: bugs, security, performance, type-safety, concurrency, memory, error-handling, maintainability
- After reviewing, offer to apply fixes automatically with apply_fix
## Multi-repo, mobile, and automation capabilities
- Use detect_mobile_platform FIRST when working with any mobile project
- Use detect_automation_platform FIRST when working with Selenium or Appium projects
- Use analyze_automation_project before changing automation runners, configs, or page objects
- Use analyze_design_assets when the task includes Figma or Sketch wireframes, screen mocks, or design handoff files
- Use generate_mobile_ui when the task asks to create platform-specific UI from a Figma or Sketch URL
- Use detect_mobile_issues to find all problems in a mobile project
- Use run_automation_tests to execute Selenium/Appium suites with the detected runner
- Use detect_issues for web/backend projects
- Use fix_project to automatically repair all found issues
- When asked to "fix all repos", use recall to find registered repos, then fix each one
- Always run tests after making fixes to verify correctness
- Commit fixes with descriptive git commit messages

## Mobile development expertise
- **Swift/iOS**: Package.swift (SPM), Xcode, SwiftLint, XCTest, Info.plist, Keychain
- **Kotlin/Android**: Gradle, AndroidManifest.xml, ktlint, JUnit, Room, Compose
- **React Native**: Metro bundler, Jest, Detox, Expo, native modules, deep links
- **Flutter/Dart**: pubspec.yaml, dart analyze, flutter test, sqflite, Provider/Riverpod
- **Automation**: Selenium WebDriver, Appium, WebdriverIO, page objects, browser/device capabilities
- **Design handoff**: Figma and Sketch wireframes, screens, components, design tokens, and mobile UI mapping

## Tool-use principles
- ALWAYS read a file before editing it
- After writing a file, verify it with read_file  
- Use recall() FIRST to check if you already know something
- Use remember() to save any non-obvious fact you discover
- When you encounter an error, search the web before giving up
- Run tests after making code changes (run_command)
- For security: scan_security before committing

## Communication style
- Be direct and concise — show code, not lengthy explanations
- Use markdown for code blocks
- Show diffs/changes clearly
- State what you did and what the user should do next

## Autonomy
Safety mode: ${AUTONOMOUS ? 'AUTONOMOUS — proceed without asking' : 'NORMAL — ask before destructive operations'}
`;

// Trim tool results before adding to context: compact JSON (no pretty-print
// whitespace) + head/tail truncation for oversized payloads. Saves ~25-40% of
// tool-result tokens with no information the model actually needs lost.
const TOOL_RESULT_MAX = 6000;
function trimToolResult(result) {
  let s;
  try { s = typeof result === 'string' ? result : JSON.stringify(result); } catch { s = String(result); }
  if (s.length <= TOOL_RESULT_MAX) return s;
  const head = s.slice(0, Math.floor(TOOL_RESULT_MAX * 0.7));
  const tail = s.slice(-Math.floor(TOOL_RESULT_MAX * 0.25));
  return `${head}\n…[trimmed ${s.length - TOOL_RESULT_MAX} chars]…\n${tail}`;
}

export class Agent {
  constructor(options = {}) {
    this.options = options;
    this.messages = [];
    this.sessionId = null;
    this.project = options.project || process.cwd();
    this.iterationCount = 0;
    this.totalIterations = 0;
  }

  async init() {
    this.sessionId = createSession(this.project);
    resetTokenStats();
  }

  async close() {
    const stats = getTokenStats();
    const lastMsg = this.messages.filter(m => m.role === 'assistant').slice(-1)[0];
    const summary = lastMsg
      ? await summarise(lastMsg.content, 'Summarise this session in one sentence:', {
          provider: this.options.provider,
          model: this.options.model,
        }).catch(() => 'Session ended')
      : 'Session ended';
    closeSession(this.sessionId, summary, stats.in, stats.out);
  }

  buildContext(memories = []) {
    let systemContent = SYSTEM_PROMPT;

    // Per-project rules (DEVLAB.md / CLAUDE.md / copilot-instructions.md / .cursorrules / skills)
    if (this.projectRules === undefined) {
      const rules = loadProjectRules(this.project);
      this.projectRules = rules.content;
      if (rules.found.length) {
        printMemory(`Loaded project rules: ${rules.found.map(f => f.source).join(', ')} (${rules.totalChars} chars)`);
      }
    }
    systemContent += this.projectRules;

    // Per-project knowledge base (learnings from past PRs)
    if (this.projectKnowledge === undefined) {
      const kb = loadKnowledge(this.project);
      this.projectKnowledge = kb.content;
      if (kb.found) printMemory(`Loaded knowledge base: ${kb.entries} entries (${kb.chars} chars)`);
    }
    systemContent += this.projectKnowledge;

    if (memories.length > 0) {
      systemContent += '\n\n## Relevant memories from past sessions:\n';
      systemContent += memories.map(m => `- **${m.key}**: ${m.value}`).join('\n');
    }

    const system = { role: 'system', content: systemContent };

    // Prune old messages to stay within context limit
    let msgs = this.messages;
    if (msgs.length > MAX_CONTEXT_MESSAGES) {
      // Keep first 2 + last (MAX-2) to preserve early context
      msgs = [...msgs.slice(0, 2), ...msgs.slice(-(MAX_CONTEXT_MESSAGES - 2))];
    }

    // Token optimization: squash stale tool results + dedupe repeated reads
    msgs = dedupeToolResults(compressHistory(msgs));

    return [system, ...msgs];
  }

  async run(userMessage) {
    // 1. Recall relevant memories
    const memories = recall(userMessage, 6);
    if (memories.length > 0) {
      printMemory(`Found ${memories.length} relevant memories`);
    }

    // 2. Add user message
    this.messages.push({ role: 'user', content: userMessage });
    if (this.sessionId) saveSessionTurn(this.sessionId, 'user', userMessage);

    // 3. ReAct loop
    let iterations = 0;
    let finalContent = '';
    // Track code changes so we never finish without offering a build
    const FILE_MODIFYING_TOOLS = new Set(['write_file', 'edit_file', 'fix_file', 'apply_fix', 'scaffold_endpoint', 'scaffold_service', 'auto_fix']);
    let codeChanged = false;
    let buildRan = false;
    let buildNudged = false;
    let llmFailures = 0; // consecutive errors → router escalates to strongest model

    // Token optimization: prune the ~10K-token tool schema payload to the
    // subset relevant to this task (stable within the run for prompt caching).
    // DEVLAB_ALL_TOOLS=1 disables pruning.
    const allTools = await getToolDefinitions();
    const runTools = selectTools(userMessage, allTools, { disable: process.env.DEVLAB_ALL_TOOLS === '1' });
    if (runTools.length < allTools.length) {
      printMemory(`Tool pruning: ${runTools.length}/${allTools.length} tools sent (~${Math.round((JSON.stringify(allTools).length - JSON.stringify(runTools).length) / 4).toLocaleString()} tokens saved/call)`);
    }

    while (iterations < MAX_AGENT_ITERATIONS) {
      iterations++;
      this.iterationCount++;

      try {
        const response = await routeChat({
          messages: this.buildContext(memories),
          tools: runTools,
          stream: false,
          provider: this.options.provider,
          model: this.options.model,
          taskText: userMessage,
          escalate: llmFailures >= 2,
        });
        llmFailures = 0;

        const { content, toolCalls } = response;

        // No tool calls → final answer
        if (!toolCalls || toolCalls.length === 0) {
          // Safety net: code changed but never built → nudge the agent once
          if (codeChanged && !buildRan && !buildNudged) {
            buildNudged = true;
            this.messages.push({ role: 'assistant', content: content || '' });
            this.messages.push({
              role: 'user',
              content: AUTONOMOUS
                ? 'You modified code but did not verify the build. Call build_project now and fix any errors before finishing.'
                : 'You modified code but did not verify the build. Ask me whether to build the project now (per the build-after-change rule), or call build_project if I already asked for a build.',
            });
            continue;
          }
          finalContent = content;
          this.messages.push({ role: 'assistant', content });
          if (this.sessionId) saveSessionTurn(this.sessionId, 'assistant', content);

          // Print the response
          printAgent(content);

          // Show cost (+ cache savings when prompt caching is active)
          const stats = getTokenStats();
          let costLine = formatTokenCost(stats.in, stats.out, response.model);
          if (stats.cacheRead > 0) {
            costLine += ` · cache: ${stats.cacheRead.toLocaleString()} tokens read at 10% cost`;
          }
          printCost(costLine);
          break;
        }

        // Has tool calls — add assistant message with tool calls
        this.messages.push({
          role: 'assistant',
          content: content || '',
          tool_calls: toolCalls,
        });

        // Execute each tool call
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          let toolArgs = {};
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {}

          printTool(`${chalk.bold(toolName)} ${chalk.gray(JSON.stringify(toolArgs).slice(0, 80))}`);

          const toolResult = await executeTool(toolName, toolArgs, { project: this.project, cwd: this.project, provider: this.options.provider, model: this.options.model });
          if (FILE_MODIFYING_TOOLS.has(toolName)) codeChanged = true;
          if (toolName === 'build_project') buildRan = true;

          // Post-edit guard: after code changes, scan the touched file for
          // endpoint conflicts + race conditions; if found, force the agent
          // to surface them to the user before continuing.
          if (FILE_MODIFYING_TOOLS.has(toolName) && !toolResult?.error) {
            const changedFile = toolArgs.path || toolArgs.file || toolArgs.filename;
            try {
              const guard = postEditGuard({ path: this.project, files: changedFile ? [changedFile] : undefined });
              if (!guard.clean) {
                this.messages.push({
                  role: 'user',
                  content: `⚠️ AUTOMATED POST-EDIT CHECK found issues in the code you just changed:\n${guard.warnings.join('\n')}\n\nBefore continuing: explain these to the user, ask how they want conflicts/races resolved (do NOT silently pick a handler or locking strategy), and only proceed after addressing them.`,
                });
                printError(`Post-edit guard: ${guard.warnings[0]}`);
              }
            } catch { /* guard must never break the loop */ }
          }

          auditLog({
            type: 'tool', tool: toolName, project: this.project,
            args: JSON.stringify(toolArgs).slice(0, 300),
            ok: !toolResult?.error,
          });

          this.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: sanitizeForLLM(toolName, trimToolResult(toolResult)),
          });
        }

      } catch (err) {
        llmFailures++;
        printError(`Agent error: ${err.message}`);
        // Add error context and let agent handle it
        this.messages.push({ role: 'user', content: `Error occurred: ${err.message}. Please handle this gracefully.` });
        if (iterations > 3) break;
      }
    }

    if (iterations >= MAX_AGENT_ITERATIONS) {
      printError('Max iterations reached. The agent stopped to prevent infinite loops.');
    }

    this.totalIterations += iterations;
    return finalContent;
  }

  // ── One-shot ask (no tool calls, streaming) ───────────────────────────────
  async ask(question) {
    const response = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ],
      stream: true,
      provider: this.options.provider,
      model: this.options.model,
    });
    return response.content;
  }

  clearContext() {
    this.messages = [];
    printSuccess('Context cleared (memory persists)');
  }

  getStats() {
    const tokenStats = getTokenStats();
    const memStats = getMemoryStats();
    return { ...tokenStats, ...memStats, contextMessages: this.messages.length, iterations: this.totalIterations };
  }
}

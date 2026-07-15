// ui/server.js — Express + WebSocket server for the Cursor-like web UI
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'fs';
import { resolve, relative, join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

const require = createRequire(import.meta.url);
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.UI_PORT || 4321;

export async function startUI(projectPath = '.', opts = {}) {
  let abs = resolve(projectPath);
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ── Enterprise auth ─────────────────────────────────────────────────────────
  // Two independent mechanisms, either grants access:
  //  1. Native OIDC SSO (DEVLAB_OIDC_ISSUER + DEVLAB_OIDC_CLIENT_ID): browser
  //     users sign in at /auth/login via your IdP (Okta/Azure AD/Keycloak/...);
  //     sessions are HMAC-signed cookies. Fully on-prem — only your IdP is called.
  //  2. API key (DEVLAB_API_KEY): "Authorization: Bearer <key>" or ?api_key= —
  //     for CI, scripts, and the IDE extension.
  // Neither set = open (local single-user default).
  const { ssoEnabled, installSSO, sessionFromRequest } = await import('../src/sso.js');
  const API_KEY = process.env.DEVLAB_API_KEY || '';
  const SSO = ssoEnabled();
  if (SSO) installSSO(app);
  const authOk = (req) => {
    if (!API_KEY && !SSO) return true;
    if (API_KEY) {
      const h = req.headers?.authorization || '';
      if (h === `Bearer ${API_KEY}`) return true;
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('api_key') === API_KEY) return true;
    }
    if (SSO) {
      const session = sessionFromRequest(req);
      if (session) { req.ssoUser = session.email; return true; }
    }
    return false;
  };
  if (API_KEY || SSO) {
    app.use((req, res, next) => {
      if (req.path.startsWith('/auth/')) return next();
      if (req.path === '/' || req.path.startsWith('/public') || !req.path.startsWith('/api') && !req.path.startsWith('/v1')) return next();
      if (authOk(req)) {
        req.user = req.ssoUser || req.headers['x-auth-request-email'] || 'api-key';
        return next();
      }
      if (SSO && (req.headers.accept || '').includes('text/html')) return res.redirect('/auth/login');
      res.status(401).json({ error: SSO ? 'Unauthorized: sign in at /auth/login or send a Bearer key' : 'Unauthorized: set Authorization: Bearer <DEVLAB_API_KEY>' });
    });
  }

  app.use(express.static(join(__dirname, 'public')));

  // ── Workspace switch (native apps open arbitrary project folders) ──────────
  app.post('/api/workspace', (req, res) => {
    const wsPath = req.body?.path;
    if (!wsPath) return res.status(400).json({ error: 'path required' });
    const next = resolve(wsPath);
    try {
      if (!statSync(next).isDirectory()) throw new Error('not a directory');
    } catch {
      return res.status(400).json({ error: `Not a directory: ${wsPath}` });
    }
    abs = next;
    res.json({ ok: true, path: abs });
  });

  app.get('/api/workspace', (_req, res) => res.json({ path: abs }));

  // ── File tree ───────────────────────────────────────────────────────────────
  app.get('/api/files', (req, res) => {
    const base = resolve(abs, req.query.path || '.');
    try {
      const tree = buildTree(base, abs, 0, 3);
      res.json({ files: tree, base: relative(abs, base) || '.' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── File read/write ─────────────────────────────────────────────────────────
  app.get('/api/file', (req, res) => {
    const file = resolve(abs, req.query.path);
    if (!file.startsWith(abs)) return res.status(403).json({ error: 'Forbidden' });
    try {
      const content = readFileSync(file, 'utf8');
      const ext = extname(file).toLowerCase().replace('.', '');
      res.json({ content, ext, path: relative(abs, file) });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.post('/api/file', (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const file = resolve(abs, filePath);
    if (!file.startsWith(abs)) return res.status(403).json({ error: 'Forbidden' });
    try {
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, content, 'utf8');
      res.json({ ok: true, path: relative(abs, file) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Git status ──────────────────────────────────────────────────────────────
  app.get('/api/git', async (req, res) => {
    try {
      const { gitStatus } = await import('../src/tools/git.js');
      const result = await gitStatus(abs);
      res.json(result);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // ── Project info ────────────────────────────────────────────────────────────
  app.get('/api/project', (req, res) => {
    const name = basename(abs);
    const pkg = existsSync(join(abs, 'package.json'))
      ? JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'))
      : null;
    res.json({ name: pkg?.name || name, path: abs, type: pkg ? 'node' : 'unknown' });
  });

  // ── Providers / models list ─────────────────────────────────────────────────
  app.get('/api/providers', async (req, res) => {
    try {
      const { listModelProviders, getProviderModels, listOllamaModels } = await import('../src/llm.js');
      const providers = listModelProviders();
      const liveOllama = await listOllamaModels();
      const data = providers.map(p => {
        const staticModels = getProviderModels(p.name);
        // For ollama provider, merge live models (live takes precedence if available)
        if (p.name === 'ollama' && liveOllama.length > 0) {
          return { ...p, models: liveOllama, live: true };
        }
        return { ...p, models: staticModels };
      });
      res.json(data);
    } catch (e) {
      res.json([]);
    }
  });

  // ── DevLab branded mode — what clients see in the UI ─────────────────────────
  // Single public model identity; internal router selects CODE/REVIEW/FAST.
  app.get('/api/devlab/modes', async (req, res) => {
    try {
      res.json([
        {
          id:          'devlab-coder',
          label:       'DevLab Coder',
          description: 'Single model identity — internally routes by complexity (code/review/fast)',
          icon:        '✦',
          model:       null,
        },
      ]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Ollama live model list — fetches from running Ollama server ──────────────
  app.get('/api/ollama/models', async (req, res) => {
    try {
      const { OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL } = await import('../src/config.js');
      const ollamaBase = OPENAI_COMPAT_BASE_URL.replace(/\/v1\/?$/, '');
      const response = await fetch(`${ollamaBase}/api/tags`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const data = await response.json();
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
        current: m.name === OPENAI_COMPAT_MODEL,
      }));
      res.json({ models, ollamaBase });
    } catch (e) {
      res.status(503).json({ error: 'Ollama not reachable', detail: e.message, models: [] });
    }
  });

  // ── Inline (tab-complete) code completion — used by the VS Code extension ──
  app.post('/api/complete', async (req, res) => {
    try {
      const { getInlineCompletion } = await import('../src/inline.js');
      const { prefix, suffix, language, filename, provider, model, useIndex } = req.body || {};
      const result = await getInlineCompletion({
        prefix, suffix, language, filename, provider, model, useIndex,
        projectPath: abs,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message, completion: '' });
    }
  });

  // ── Dashboard — usage, quality, KB, activity ────────────────────────────────
  app.get('/api/dashboard', async (req, res) => {
    try {
      const { collectDashboard } = await import('../src/dashboard.js');
      res.json(await collectDashboard(abs));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── OpenAI-compatible API — plug DevLab into ANY IDE/tool ──────────────────
  // JetBrains AI Assistant, Zed, Neovim (avante/codecompanion), Continue.dev,
  // aider — anything that speaks the OpenAI protocol can use DevLab as its
  // backend and get smart routing, privacy mode, and self-refine for free.
  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const { routeChat } = await import('../src/router.js');
      const { messages, model, tools } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
      }
      const resp = await routeChat({
        messages,
        tools: tools || [],
        // "devlab" / "auto" → smart routing; anything else pins that model
        model: model && !/^(devlab|auto)/i.test(model) ? model : undefined,
      });
      res.json({
        id: `chatcmpl-devlab-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: resp.model || model || 'devlab-auto',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: resp.content || '',
            ...(resp.toolCalls?.length ? { tool_calls: resp.toolCalls } : {}),
          },
          finish_reason: resp.toolCalls?.length ? 'tool_calls' : 'stop',
        }],
        usage: {
          prompt_tokens: resp.inputTokens || 0,
          completion_tokens: resp.outputTokens || 0,
          total_tokens: (resp.inputTokens || 0) + (resp.outputTokens || 0),
        },
        devlab: { routedProvider: resp.routedProvider, routedTier: resp.routedTier, refined: resp.refined || 0 },
      });
    } catch (e) {
      res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    }
  });

  app.get('/v1/models', async (req, res) => {
    try {
      const { listModelProviders } = await import('../src/llm.js');
      const models = [{ id: 'devlab-auto', object: 'model', owned_by: 'devlab' }];
      for (const p of listModelProviders()) models.push({ id: `devlab/${p.name}`, object: 'model', owned_by: 'devlab' });
      res.json({ object: 'list', data: models });
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });

  // ── HTTP server ─────────────────────────────────────────────────────────────
  const server = createServer(app);

  // ── WebSocket ───────────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    if (!authOk(req)) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    let agent = null;
    let busy = false;

    ws.send(JSON.stringify({ type: 'connected', project: abs }));

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'chat') {
        if (busy) {
          ws.send(JSON.stringify({ type: 'error', text: 'Agent is busy. Wait for the current response.' }));
          return;
        }

        busy = true;

        if (!agent) {
          try {
            const { Agent } = await import('../src/agent.js');
            agent = new Agent({
              project: abs,
              provider: msg.provider || undefined,
              model: msg.model || undefined,
            });
            await agent.init();
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', text: `Failed to create agent: ${e.message}` }));
            busy = false;
            return;
          }
        } else {
          // Update provider/model if changed
          if (msg.provider) agent.options.provider = msg.provider;
          if (msg.model) agent.options.model = msg.model;
        }

        try {
          // Intercept printAgent, printTool etc by patching stdout/emit
          const capturedTools = [];
          const origPrintTool = globalThis.__uiCaptureTool;

          globalThis.__uiEmit = (event) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(event));
          };

          ws.send(JSON.stringify({ type: 'thinking', text: '...' }));

          // Monkey-patch console.log temporarily to capture tool output
          const origLog = console.log;
          const toolLogs = [];

          // Run agent
          const result = await runAgentWithEvents(agent, msg.text, (event) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(event));
          });

          ws.send(JSON.stringify({
            type: 'done',
            text: result || '',
            tokens: (await import('../src/llm.js').then(m => m.getTokenStats()))
          }));

        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', text: e.message }));
        } finally {
          busy = false;
          globalThis.__uiEmit = null;
        }
      }

      if (msg.type === 'clear') {
        if (agent) {
          agent.clearContext();
        }
        ws.send(JSON.stringify({ type: 'cleared' }));
      }

      if (msg.type === 'new_session') {
        if (agent) {
          try { await agent.close(); } catch {}
        }
        agent = null;
        busy = false;                       // unblock even if a run was in flight
        globalThis.__uiEmit = null;
        ws.send(JSON.stringify({ type: 'session_cleared' }));
      }
    });

    ws.on('close', async () => {
      if (agent) {
        try { await agent.close(); } catch {}
      }
      globalThis.__uiEmit = null;
    });
  });

  server.listen(PORT, async () => {
    const chalk = (await import('chalk')).default;
    console.log(`\n${chalk.bold.cyan('DevLab UI')} ${chalk.gray('running at')} ${chalk.underline(`http://localhost:${PORT}`)}`);
    console.log(chalk.gray(`  Project: ${abs}`));
    console.log(chalk.gray(`  Press Ctrl+C to stop\n`));
  });

  return server;
}

// ── Agent runner that emits WebSocket events ──────────────────────────────────
async function runAgentWithEvents(agent, userMessage, emit) {
  const { recall, saveSessionTurn } = await import('../src/memory.js');
  const { chat } = await import('../src/llm.js');
  const { getToolDefinitions, executeTool } = await import('../src/tools/index.js');
  const { MAX_AGENT_ITERATIONS, NO_LOG } = await import('../src/config.js');

  // When NO_LOG=1 (server-side privacy mode): skip memory recall and DB writes.
  // Client source code in prompts is processed in-memory only — never persisted.
  const memories = NO_LOG ? [] : recall(userMessage, 6);
  if (memories.length) {
    emit({ type: 'status', text: `Found ${memories.length} relevant memories` });
  }

  agent.messages.push({ role: 'user', content: userMessage });
  if (agent.sessionId && !NO_LOG) saveSessionTurn(agent.sessionId, 'user', userMessage);

  let iterations = 0;
  let finalContent = '';

  while (iterations < MAX_AGENT_ITERATIONS) {
    iterations++;
    agent.iterationCount++;

    try {
      const response = await chat({
        messages: agent.buildContext(memories),
        tools: await getToolDefinitions(),
        stream: false,
        provider: agent.options.provider,
        model: agent.options.model,
      });

      const { content, toolCalls } = response;

      if (!toolCalls || toolCalls.length === 0) {
        finalContent = content;
        agent.messages.push({ role: 'assistant', content });
        if (agent.sessionId && !NO_LOG) saveSessionTurn(agent.sessionId, 'assistant', content);
        emit({ type: 'token', text: content });
        break;
      }

      agent.messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(toolCall.function.arguments); } catch {}

        emit({ type: 'tool_call', name: toolName, args: toolArgs });

        const toolResult = await executeTool(toolName, toolArgs, {
          project: agent.project,
          cwd: agent.project,
        });

        const resultStr = JSON.stringify(toolResult, null, 2).slice(0, 15000);
        emit({ type: 'tool_result', name: toolName, result: toolResult, resultStr });

        agent.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: resultStr,
        });
      }
    } catch (err) {
      emit({ type: 'error', text: err.message });
      agent.messages.push({ role: 'user', content: `Error: ${err.message}. Handle gracefully.` });
      if (iterations > 3) break;
    }
  }

  agent.totalIterations += iterations;
  return finalContent;
}

// ── File tree builder ─────────────────────────────────────────────────────────
function buildTree(dir, root, depth, maxDepth) {
  if (depth > maxDepth) return [];
  const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.next', 'dist', 'build', '.cache', 'coverage', '.gradle', 'Pods', '.dart_tool']);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries.sort((a, b) => {
    // Directories first
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  })) {
    if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    const rel = relative(root, fullPath);
    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        path: rel,
        type: 'dir',
        children: buildTree(fullPath, root, depth + 1, maxDepth),
      });
    } else {
      items.push({
        name: entry.name,
        path: rel,
        type: 'file',
        ext: extname(entry.name).replace('.', ''),
      });
    }
  }
  return items;
}

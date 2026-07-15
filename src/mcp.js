// src/mcp.js — MCP (Model Context Protocol) integration
// Transports: stdio (local child process) and Streamable HTTP (remote URL).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { AGENT_DIR } from './config.js';
import { getPrivacyMode } from './privacy.js';

const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:\d+)?(\/|$)/i;

const MCP_CONFIG_PATH = process.env.MCP_SERVERS_CONFIG || join(AGENT_DIR, 'mcp-servers.json');
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS || 20_000);

let cache = {
  loadedAt: 0,
  configMtimeHint: '',
  tools: [],
  toolMap: new Map(),
  servers: new Map(),
  errors: [],
};

function sanitizeName(input) {
  return String(input || '').replace(/[^a-zA-Z0-9_]/g, '_');
}

function withTimeout(promise, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

function readConfig() {
  if (!existsSync(MCP_CONFIG_PATH)) {
    return { servers: {} };
  }
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { servers: {} };
    if (!parsed.servers || typeof parsed.servers !== 'object') return { servers: {} };
    return parsed;
  } catch {
    return { servers: {} };
  }
}

class MCPStdioClient {
  constructor(name, serverConfig = {}) {
    this.name = name;
    this.serverConfig = serverConfig;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.started = false;
  }

  async start() {
    if (this.started) return;
    const command = this.serverConfig.command;
    const args = Array.isArray(this.serverConfig.args) ? this.serverConfig.args : [];
    if (!command) throw new Error(`MCP server "${this.name}" missing "command"`);

    this.proc = spawn(command, args, {
      cwd: this.serverConfig.cwd || process.cwd(),
      env: { ...process.env, ...(this.serverConfig.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.proc.on('error', (err) => {
      this._rejectAll(err);
    });
    this.proc.on('exit', (code, signal) => {
      const err = new Error(`MCP server "${this.name}" exited (code=${code}, signal=${signal})`);
      this._rejectAll(err);
      this.started = false;
    });

    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', () => {
      // Intentionally ignored; stderr is server-specific logs.
    });

    this.started = true;

    await withTimeout(this.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'devlab', version: '1.0.0' },
      capabilities: {},
    }), `initialize:${this.name}`);

    this.notify('notifications/initialized', {});
  }

  _rejectAll(err) {
    for (const [, pending] of this.pending.entries()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerText = this.buf.slice(0, headerEnd).toString('utf8');
      const m = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }

      const len = Number(m[1]);
      const total = headerEnd + 4 + len;
      if (this.buf.length < total) return;

      const bodyBuf = this.buf.slice(headerEnd + 4, total);
      this.buf = this.buf.slice(total);

      let msg;
      try {
        msg = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || 'MCP error'));
      else pending.resolve(msg.result);
    }
  }

  _writeMessage(payload) {
    if (!this.proc || !this.proc.stdin) {
      throw new Error(`MCP server "${this.name}" is not running`);
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._writeMessage(payload);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    const payload = { jsonrpc: '2.0', method, params };
    this._writeMessage(payload);
  }

  async listTools() {
    await this.start();
    const res = await withTimeout(this.request('tools/list', {}), `tools/list:${this.name}`);
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name, args = {}) {
    await this.start();
    const res = await withTimeout(this.request('tools/call', { name, arguments: args }), `tools/call:${this.name}:${name}`);
    return res;
  }
}

/**
 * Remote MCP client — Streamable HTTP transport (MCP spec 2025-03-26).
 * Config: { url, headers? }. Handles both application/json and
 * text/event-stream (SSE) response bodies, and Mcp-Session-Id sessions.
 */
class MCPHttpClient {
  constructor(name, serverConfig = {}) {
    this.name = name;
    this.url = serverConfig.url;
    this.headers = serverConfig.headers || {};
    this.sessionId = null;
    this.nextId = 1;
    this.started = false;
  }

  async _post(payload, { expectResponse = true } = {}) {
    const res = await withTimeout(fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(payload),
    }), `http:${this.name}:${payload.method || 'notify'}`);

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!expectResponse) return null;
    if (!res.ok) throw new Error(`MCP server "${this.name}" HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      // Parse SSE stream; resolve on the JSON-RPC response matching our id.
      const text = await res.text();
      for (const block of text.split('\n\n')) {
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id === payload.id) {
            if (msg.error) throw new Error(msg.error.message || 'MCP error');
            return msg.result;
          }
        } catch (err) {
          if (err.message && !err.message.includes('JSON')) throw err;
        }
      }
      throw new Error(`MCP server "${this.name}" SSE stream ended without a response`);
    }

    const msg = await res.json();
    if (msg.error) throw new Error(msg.error.message || 'MCP error');
    return msg.result;
  }

  async start() {
    if (this.started) return;
    if (!this.url) throw new Error(`MCP server "${this.name}" missing "url"`);
    // Privacy: local-only mode blocks remote MCP URLs (localhost is fine).
    if (getPrivacyMode() === 'local-only' && !LOCAL_URL_RE.test(this.url)) {
      throw new Error(`Privacy mode is local-only: remote MCP server "${this.name}" (${this.url}) is blocked`);
    }
    await this._post({
      jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'devlab', version: '1.0.0' },
        capabilities: {},
      },
    });
    await this._post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, { expectResponse: false });
    this.started = true;
  }

  async listTools() {
    await this.start();
    const res = await this._post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} });
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name, args = {}) {
    await this.start();
    return this._post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
  }
}

function createMcpClient(name, serverConfig = {}) {
  if (serverConfig.url) return new MCPHttpClient(name, serverConfig);
  return new MCPStdioClient(name, serverConfig);
}

function getConfigHint(cfg) {
  try {
    return JSON.stringify(cfg);
  } catch {
    return String(Date.now());
  }
}

export async function reloadMcpServers() {
  const cfg = readConfig();
  cache = {
    loadedAt: Date.now(),
    configMtimeHint: getConfigHint(cfg),
    tools: [],
    toolMap: new Map(),
    servers: new Map(),
    errors: [],
  };

  const entries = Object.entries(cfg.servers || {});
  for (const [serverName, serverConfig] of entries) {
    if (!serverConfig || serverConfig.disabled) continue;
    try {
      const client = createMcpClient(serverName, serverConfig);
      cache.servers.set(serverName, client);
      const tools = await client.listTools();

      for (const tool of tools) {
        const originalName = tool?.name;
        if (!originalName) continue;
        const wrappedName = `mcp_${sanitizeName(serverName)}__${sanitizeName(originalName)}`;
        const wrappedDef = {
          type: 'function',
          function: {
            name: wrappedName,
            description: `[MCP:${serverName}] ${tool.description || originalName}`,
            parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
              ? tool.inputSchema
              : { type: 'object', properties: {}, required: [] },
          },
        };
        cache.tools.push(wrappedDef);
        cache.toolMap.set(wrappedName, {
          serverName,
          originalName,
          inputSchema: wrappedDef.function.parameters,
        });
      }
    } catch (err) {
      cache.errors.push({ server: serverName, error: err.message });
    }
  }

  return {
    configPath: MCP_CONFIG_PATH,
    serversConfigured: entries.length,
    serversLoaded: cache.servers.size,
    toolsLoaded: cache.tools.length,
    tools: cache.tools.map(t => t.function.name),
    errors: cache.errors,
  };
}

export async function getMcpToolDefinitions() {
  const cfg = readConfig();
  const hint = getConfigHint(cfg);
  if (!cache.loadedAt || cache.configMtimeHint !== hint) {
    await reloadMcpServers();
  }
  return cache.tools;
}

export function isMcpTool(name) {
  return cache.toolMap.has(name);
}

export async function executeMcpTool(name, args = {}) {
  const meta = cache.toolMap.get(name);
  if (!meta) {
    await getMcpToolDefinitions();
  }
  const resolved = cache.toolMap.get(name);
  if (!resolved) {
    return { error: `Unknown MCP tool: ${name}` };
  }
  const client = cache.servers.get(resolved.serverName);
  if (!client) {
    return { error: `MCP server not available: ${resolved.serverName}` };
  }
  try {
    return await client.callTool(resolved.originalName, args || {});
  } catch (err) {
    return { error: err.message, tool: name, server: resolved.serverName };
  }
}

export async function getMcpStatus() {
  await getMcpToolDefinitions();
  return {
    configPath: MCP_CONFIG_PATH,
    loadedAt: cache.loadedAt,
    servers: [...cache.servers.keys()],
    tools: cache.tools.map(t => t.function.name),
    errors: cache.errors,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Zero-config MCP: built-in catalog, one-command add/remove, project suggestions
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_CATALOG = {
  filesystem: {
    description: 'Read/write files in allowed directories',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{dir}'],
    params: [{ key: 'dir', prompt: 'Directory to allow access to', default: process.env.HOME }],
  },
  github: {
    description: 'GitHub repos, issues, PRs',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '{token}' },
    params: [{ key: 'token', prompt: 'GitHub PAT (github.com/settings/tokens)', secret: true }],
  },
  gitlab: {
    description: 'GitLab projects and MRs',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: '{token}' },
    params: [{ key: 'token', prompt: 'GitLab PAT', secret: true }],
  },
  postgres: {
    description: 'Query PostgreSQL databases',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '{url}'],
    params: [{ key: 'url', prompt: 'Connection URL (postgresql://user:pass@host/db)' }],
  },
  sqlite: {
    description: 'Query SQLite databases',
    command: 'npx', args: ['-y', 'mcp-server-sqlite-npx', '{db}'],
    params: [{ key: 'db', prompt: 'Path to .db file' }],
  },
  puppeteer: {
    description: 'Browser automation and scraping',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  fetch: {
    description: 'Fetch and convert web pages',
    command: 'npx', args: ['-y', '@mokei/mcp-fetch'],
  },
  memory: {
    description: 'Knowledge-graph memory server',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  slack: {
    description: 'Slack channels and messages',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '{token}', SLACK_TEAM_ID: '{team}' },
    params: [
      { key: 'token', prompt: 'Slack bot token (xoxb-…)', secret: true },
      { key: 'team', prompt: 'Slack team ID' },
    ],
  },
  'brave-search': {
    description: 'Brave web search API',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '{key}' },
    params: [{ key: 'key', prompt: 'Brave API key (brave.com/search/api)', secret: true }],
  },
  sentry: {
    description: 'Sentry error reports',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-sentry'],
    env: { SENTRY_AUTH_TOKEN: '{token}' },
    params: [{ key: 'token', prompt: 'Sentry auth token', secret: true }],
  },
};

function writeConfig(config) {
  const { writeFileSync, mkdirSync } = require_fs();
  mkdirSync(join(MCP_CONFIG_PATH, '..'), { recursive: true });
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// lazy fs to keep top imports unchanged
function require_fs() {
  return { writeFileSync: writeFileSyncRef, mkdirSync: mkdirSyncRef };
}
import { writeFileSync as writeFileSyncRef, mkdirSync as mkdirSyncRef } from 'fs';

/**
 * Add an MCP server with zero JSON editing.
 * - name in catalog → params filled from `values` {key:value}
 * - custom local → pass {command, args, env}
 * - custom remote → pass {url, headers} (Streamable HTTP transport)
 */
export async function addMcpServer(name, { values = {}, command, args, env, url, headers } = {}) {
  const config = readConfig();
  config.servers = config.servers || {};

  const entry = MCP_CATALOG[name];
  if (entry) {
    const missing = (entry.params || []).filter(p => !values[p.key]);
    if (missing.length) {
      return {
        needsInput: true,
        server: name,
        message: `Need ${missing.length} value(s) to set up '${name}'`,
        required: missing.map(p => ({ key: p.key, prompt: p.prompt, secret: !!p.secret, default: p.default })),
      };
    }
    const fill = (s) => String(s).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? `{${k}}`);
    config.servers[name] = {
      command: entry.command,
      args: (entry.args || []).map(fill),
      ...(entry.env ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, fill(v)])) } : {}),
    };
  } else if (url) {
    config.servers[name] = { url, ...(headers ? { headers } : {}) };
  } else {
    if (!command) {
      return {
        error: `'${name}' is not in the catalog and no command or url given.`,
        catalog: Object.entries(MCP_CATALOG).map(([n, c]) => `${n} — ${c.description}`),
      };
    }
    config.servers[name] = { command, ...(args ? { args } : {}), ...(env ? { env } : {}) };
  }

  writeConfig(config);
  const status = await reloadMcpServers();
  const connected = !status.errors?.some(e => e.server === name);
  return {
    success: connected,
    server: name,
    configPath: MCP_CONFIG_PATH,
    tools: (status.tools || []).filter(t => t.startsWith(`mcp_${sanitizeName(name)}__`)),
    ...(connected ? {} : { warning: 'Added to config but failed to connect', errors: status.errors }),
  };
}

export async function removeMcpServer(name) {
  const config = readConfig();
  if (!config.servers?.[name]) return { error: `Server '${name}' not found in config` };
  delete config.servers[name];
  writeConfig(config);
  await reloadMcpServers();
  return { success: true, removed: name };
}

/** Suggest MCP servers based on what's in the project */
export function suggestMcpServers(projectPath = '.') {
  const has = (f) => existsSync(join(projectPath, f));
  const configured = Object.keys(readConfig().servers || {});
  const suggestions = [];
  const suggest = (name, reason) => {
    if (!configured.includes(name)) suggestions.push({ name, reason, ...{ description: MCP_CATALOG[name]?.description } });
  };

  if (has('.git')) suggest('github', 'Git repository detected — manage issues/PRs from chat');
  if (has('docker-compose.yml') || has('docker-compose.yaml')) {
    try {
      const dc = readFileSync(join(projectPath, has('docker-compose.yml') ? 'docker-compose.yml' : 'docker-compose.yaml'), 'utf8');
      if (/postgres/i.test(dc)) suggest('postgres', 'PostgreSQL found in docker-compose');
    } catch {}
  }
  if (has('prisma/schema.prisma')) suggest('postgres', 'Prisma schema detected');
  const sqliteFile = ['db.sqlite', 'database.db', 'data.db'].find(has);
  if (sqliteFile) suggest('sqlite', `SQLite file found: ${sqliteFile}`);
  suggest('memory', 'Persistent knowledge graph across sessions');
  suggest('puppeteer', 'Browser automation for testing web UIs');

  return { configured, suggestions, install: "Use mcp_add_server or `node index.js mcp add <name>`" };
}

export function getMcpCatalog() {
  const configured = Object.keys(readConfig().servers || {});
  return Object.entries(MCP_CATALOG).map(([name, c]) => ({
    name,
    description: c.description,
    requires: (c.params || []).map(p => p.prompt),
    installed: configured.includes(name),
  }));
}

// Remote MCP (Streamable HTTP transport) — DevLab works with local AND hosted MCP servers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server, port, mcp;
const tmp = mkdtempSync(join(tmpdir(), 'devlab-mcp-'));

// Minimal Streamable HTTP MCP server: initialize, tools/list, tools/call
function startMockServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let msg = {};
        try { msg = JSON.parse(body); } catch {}
        if (!('id' in msg)) { res.writeHead(202).end(); return; } // notification
        let result;
        if (msg.method === 'initialize') {
          result = { protocolVersion: '2025-03-26', serverInfo: { name: 'mock' }, capabilities: {} };
          res.setHeader('Mcp-Session-Id', 'sess-123');
        } else if (msg.method === 'tools/list') {
          result = { tools: [{ name: 'echo', description: 'Echo back input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
        } else if (msg.method === 'tools/call') {
          result = { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text}` }] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

beforeAll(async () => {
  process.env.MCP_SERVERS_CONFIG = join(tmp, 'mcp-servers.json');
  await startMockServer();
  mcp = await import('../src/mcp.js');
});

afterAll(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MCP_SERVERS_CONFIG;
  delete process.env.DEVLAB_PRIVACY;
});

describe('remote MCP servers (Streamable HTTP)', () => {
  it('adds a remote server by url and discovers its tools', async () => {
    const res = await mcp.addMcpServer('mock-remote', { url: `http://127.0.0.1:${port}/mcp` });
    expect(res.success).toBe(true);
    expect(res.tools).toContain('mcp_mock_remote__echo');
  });

  it('executes a remote tool over HTTP', async () => {
    const out = await mcp.executeMcpTool('mcp_mock_remote__echo', { text: 'hello' });
    expect(JSON.stringify(out)).toContain('echo: hello');
  });

  it('supports headers for auth in the config entry', async () => {
    const res = await mcp.addMcpServer('mock-auth', {
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.success).toBe(true);
    await mcp.removeMcpServer('mock-auth');
  });

  it('blocks non-local remote MCP urls in local-only privacy mode', async () => {
    process.env.DEVLAB_PRIVACY = 'local-only';
    const res = await mcp.addMcpServer('cloud-remote', { url: 'https://mcp.example.com/mcp' });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.errors || res.warning)).toMatch(/local-only|blocked|Privacy/i);
    delete process.env.DEVLAB_PRIVACY;
    await mcp.removeMcpServer('cloud-remote');
  });

  it('localhost urls are still allowed in local-only privacy mode', async () => {
    process.env.DEVLAB_PRIVACY = 'local-only';
    const status = await mcp.reloadMcpServers();
    expect(status.errors.some((e) => e.server === 'mock-remote')).toBe(false);
    delete process.env.DEVLAB_PRIVACY;
  });
});

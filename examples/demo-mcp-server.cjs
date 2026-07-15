#!/usr/bin/env node
// demo-mcp-server.js — minimal MCP stdio server (zero dependencies)
// Exposes two tools: say_hello and system_info

const tools = [
  {
    name: 'say_hello',
    description: 'Greet someone by name',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'system_info',
    description: 'Get OS, node version, and uptime of this machine',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'demo-server', version: '1.0.0' },
    }};
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    let text;
    if (name === 'say_hello') text = `👋 Hello, ${args.name}! Greetings from your custom MCP server.`;
    else if (name === 'system_info') {
      const os = require('os');
      text = JSON.stringify({ platform: os.platform(), arch: os.arch(), node: process.version, uptimeMin: Math.round(os.uptime()/60) });
    }
    else return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
  }
  if (method === 'notifications/initialized' || id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

// stdio transport: Content-Length framed JSON-RPC
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const s = buf.toString('utf8');
    const m = s.match(/Content-Length: (\d+)\r\n\r\n/);
    if (!m) break;
    const headerEnd = m.index + m[0].length;
    const len = parseInt(m[1], 10);
    if (buf.length < headerEnd + len) break;
    const body = buf.slice(headerEnd, headerEnd + len).toString('utf8');
    buf = buf.slice(headerEnd + len);
    try {
      const resp = handle(JSON.parse(body));
      if (resp) {
        const out = JSON.stringify(resp);
        process.stdout.write(`Content-Length: ${Buffer.byteLength(out)}\r\n\r\n${out}`);
      }
    } catch (e) { /* ignore malformed */ }
  }
});

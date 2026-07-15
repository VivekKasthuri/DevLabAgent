/* ── app.js — DevLab web UI ─────────────────────────────────────────────── */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const State = {
  ws: null,
  wsReady: false,
  openFiles: new Map(),     // path → { content, model, modified }
  activeFile: null,
  provider: null,
  model: null,
  thinking: false,
  thinkingEl: null,
  thinkingTimer: null,
  requestStartedAt: 0,
  streaming: false,
  providers: [],
  currentCtxTarget: null,
};

// ── Monaco ────────────────────────────────────────────────────────────────────
let monacoEditor = null;

require(['vs/editor/editor.main'], () => {
  monaco.editor.defineTheme('devlab', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
      { token: 'string', foreground: 'ce9178' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'keyword', foreground: 'c586c0' },
      { token: 'type', foreground: '4ec9b0' },
    ],
    colors: {
      'editor.background': '#0f0f0f',
      'editor.lineHighlightBackground': '#1a1a1a',
      'editorLineNumber.foreground': '#404040',
      'editorLineNumber.activeForeground': '#7a7a7a',
      'editor.selectionBackground': '#264f78',
      'editorCursor.foreground': '#a78bfa',
      'editorWidget.background': '#161616',
      'editorSuggestWidget.background': '#161616',
      'editorSuggestWidget.border': '#2e2e2e',
      'input.background': '#242424',
      'focusBorder': '#a78bfa',
    }
  });

  monacoEditor = monaco.editor.create(document.getElementById('editor-mount'), {
    theme: 'devlab',
    automaticLayout: true,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontLigatures: true,
    lineHeight: 20,
    minimap: { enabled: true, renderCharacters: false, scale: 1 },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
    formatOnPaste: true,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    padding: { top: 10, bottom: 10 },
    renderLineHighlight: 'gutter',
    wordWrap: 'off',
  });

  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);
  monacoEditor.onDidChangeModelContent(() => {
    if (State.activeFile) {
      const f = State.openFiles.get(State.activeFile);
      if (f) { f.modified = true; f.content = monacoEditor.getValue(); }
      renderTabs();
    }
  });

  showEmptyEditor();
  init();
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadProjectInfo();
  await loadDevLabModes();
  connectWS();
  loadFileTree();
  bindEvents();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  State.ws = ws;

  ws.addEventListener('open', () => {
    State.wsReady = true;
    setStatus('Connected');
    termLine('WebSocket connected', 'ok');
    // Keep alive
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 15000);
  });

  ws.addEventListener('close', () => {
    State.wsReady = false;
    setStatus('Disconnected — reconnecting…');
    setTimeout(connectWS, 2500);
  });

  ws.addEventListener('error', () => {
    setStatus('Connection error');
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWSMessage(msg);
  });
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'pong': break;

    case 'connected':
      termLine(`Agent session ready`, 'ok');
      break;

    case 'thinking':
      showThinking();
      setStatus('Agent is thinking…');
      break;

    case 'status':
      setStatus(msg.text);
      termLine(msg.text, 'dim');
      break;

    case 'token':
      hideThinking();
      appendAgentMessage(msg.text);
      break;

    case 'tool_call':
      termLine(`⚙ ${msg.name}(${JSON.stringify(msg.args).slice(0, 80)})`, 'tool');
      appendToolCallBubble(msg.name, msg.args);
      break;

    case 'tool_result':
      termLine(`  ↳ done: ${msg.name}`, 'dim');
      updateToolCallBubble(msg.name, msg.resultStr);
      break;

    case 'done':
      hideThinking();
      State.thinking = false;
      finishAgentMessage();
      setBusy(false);
      const toks = msg.tokens;
      setStatus(toks ? `Done · ${toks.total || 0} tokens` : 'Done');
      break;

    case 'cleared':
      notify('Context cleared', 'ok');
      break;

    case 'session_cleared':
      clearChatMessages();
      notify('New session started', 'ok');
      break;

    case 'error':
      hideThinking();
      State.thinking = false;
      finishAgentMessage();
      setBusy(false);
      appendErrorMessage(msg.text);
      setStatus(`Error: ${msg.text}`);
      break;
  }
}

// ── Chat UI ───────────────────────────────────────────────────────────────────
function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || State.thinking || !State.wsReady) return;

  appendUserMessage(text);
  input.value = '';
  autoResize(input);
  setBusy(true);
  State.thinking = true;
  State.streaming = false;
  State.requestStartedAt = Date.now();
  currentAgentMsg = null;
  setStatus('Sending…');

  State.ws.send(JSON.stringify({
    type: 'chat',
    text,
    provider: State.provider,
    model: State.model,
  }));
}

function appendUserMessage(text) {
  const el = createMsgEl('user', 'You', text);
  chatMessages().appendChild(el);
  scrollChat();
}

let currentAgentMsg = null;

function appendAgentMessage(text) {
  if (!currentAgentMsg) {
    currentAgentMsg = createMsgEl('agent', 'DevLab', '');
    chatMessages().appendChild(currentAgentMsg);
    currentAgentMsg.classList.add('streaming');
    currentAgentMsg.querySelector('.msg-body')?.classList.add('streaming-cursor');
  }
  State.streaming = true;
  const body = currentAgentMsg.querySelector('.msg-body');
  body.textContent = text;
  scrollChat();
}

function appendErrorMessage(text) {
  currentAgentMsg = null;
  const el = createMsgEl('agent', 'Error', text);
  el.querySelector('.msg-body').style.borderColor = 'var(--red)';
  el.querySelector('.msg-body').style.color = 'var(--red)';
  chatMessages().appendChild(el);
  scrollChat();
}

let lastToolName = null;
let lastToolEl = null;

function appendToolCallBubble(name, args) {
  const details = document.createElement('details');
  details.className = 'msg-tool';
  details.innerHTML = `<summary>⚙ ${name}</summary><div class="tool-result">Waiting…</div>`;
  chatMessages().appendChild(details);
  lastToolName = name;
  lastToolEl = details;
  scrollChat();
}

function updateToolCallBubble(name, result) {
  if (lastToolEl && lastToolName === name) {
    lastToolEl.querySelector('.tool-result').textContent = result.slice(0, 600) + (result.length > 600 ? '…' : '');
  }
}

function createMsgEl(role, label, text) {
  if (role === 'agent') currentAgentMsg = null;
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="msg-role">${label}</div><div class="msg-body">${escapeHtml(text)}</div>`;
  return div;
}

function showThinking() {
  if (State.thinkingEl) return;
  const el = document.createElement('div');
  el.className = 'thinking-indicator';
  el.innerHTML = `<span class="thinking-text">Agent is thinking…</span><div class="thinking-dots"><span></span><span></span><span></span></div>`;
  State.thinkingEl = el;
  chatMessages().appendChild(el);
  if (State.thinkingTimer) clearInterval(State.thinkingTimer);
  State.thinkingTimer = setInterval(() => {
    if (!State.thinkingEl || !State.requestStartedAt) return;
    const secs = Math.max(0, Math.floor((Date.now() - State.requestStartedAt) / 1000));
    const t = State.thinkingEl.querySelector('.thinking-text');
    if (t) t.textContent = `Agent is thinking… ${secs}s`;
  }, 1000);
  scrollChat();
}

function hideThinking() {
  if (State.thinkingEl) {
    State.thinkingEl.remove();
    State.thinkingEl = null;
  }
  if (State.thinkingTimer) {
    clearInterval(State.thinkingTimer);
    State.thinkingTimer = null;
  }
}

function clearChatMessages() {
  const el = chatMessages();
  el.innerHTML = '';
  currentAgentMsg = null;
  State.thinkingEl = null;
}

function chatMessages() { return document.getElementById('chat-messages'); }
function scrollChat() {
  const el = chatMessages();
  requestAnimationFrame(() => el.scrollTop = el.scrollHeight);
}

// ── File tree ─────────────────────────────────────────────────────────────────
async function loadFileTree(path = '.') {
  try {
    const data = await api('/api/files?path=' + encodeURIComponent(path));
    renderTree(data.files, document.getElementById('file-tree'), 0);
  } catch (e) {
    termLine('Failed to load file tree: ' + e.message, 'err');
  }
}

function renderTree(items, container, depth) {
  container.innerHTML = '';
  for (const item of items) {
    if (item.type === 'dir') {
      const wrap = document.createElement('div');
      const row = document.createElement('div');
      row.className = 'tree-item dir';
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.innerHTML = `<span class="icon">▸</span><span class="name">${esc(item.name)}</span>`;
      row.dataset.path = item.path;
      const children = document.createElement('div');
      children.className = 'tree-folder-children';
      if (item.children?.length) renderTree(item.children, children, depth + 1);
      row.addEventListener('click', () => {
        const open = children.classList.toggle('open');
        row.querySelector('.icon').textContent = open ? '▾' : '▸';
      });
      row.addEventListener('contextmenu', e => showCtx(e, item));
      wrap.appendChild(row);
      wrap.appendChild(children);
      container.appendChild(wrap);
    } else {
      const row = document.createElement('div');
      row.className = 'tree-item file';
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.innerHTML = `<span class="icon">${fileIcon(item.ext)}</span><span class="name">${esc(item.name)}</span>`;
      row.dataset.path = item.path;
      row.addEventListener('click', () => openFile(item.path));
      row.addEventListener('contextmenu', e => showCtx(e, item));
      container.appendChild(row);
    }
  }
}

// ── Editor / files ────────────────────────────────────────────────────────────
async function openFile(path) {
  if (State.openFiles.has(path)) {
    activateTab(path);
    return;
  }
  try {
    const data = await api('/api/file?path=' + encodeURIComponent(path));
    const monacoModel = monaco.editor.createModel(
      data.content,
      extToLang(data.ext),
      monaco.Uri.file(path)
    );
    State.openFiles.set(path, { content: data.content, model: monacoModel, modified: false, ext: data.ext });
    renderTabs();
    activateTab(path);
    // Highlight in tree
    document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'));
    document.querySelectorAll(`.tree-item[data-path="${CSS.escape(path)}"]`).forEach(el => el.classList.add('active'));
  } catch (e) {
    notify('Cannot open file: ' + e.message, 'err');
  }
}

function activateTab(path) {
  State.activeFile = path;
  const f = State.openFiles.get(path);
  if (!f) return;
  monacoEditor.setModel(f.model);
  hideEmptyEditor();
  renderTabs();
  updateBreadcrumb(path);
}

function closeTab(path, e) {
  if (e) e.stopPropagation();
  const f = State.openFiles.get(path);
  if (f?.model) f.model.dispose();
  State.openFiles.delete(path);
  if (State.activeFile === path) {
    const next = [...State.openFiles.keys()].pop();
    if (next) activateTab(next);
    else { State.activeFile = null; showEmptyEditor(); updateBreadcrumb(''); }
  }
  renderTabs();
}

function renderTabs() {
  const bar = document.getElementById('tabs');
  bar.innerHTML = '';
  for (const [path, f] of State.openFiles) {
    const name = path.split('/').pop();
    const tab = document.createElement('div');
    tab.className = `tab${State.activeFile === path ? ' active' : ''}${f.modified ? ' modified' : ''}`;
    tab.innerHTML = `
      ${f.modified ? '<span class="tab-dot"></span>' : ''}
      <span>${esc(name)}</span>
      <span class="tab-close" data-close="${esc(path)}">✕</span>
    `;
    tab.addEventListener('click', () => activateTab(path));
    tab.querySelector('.tab-close').addEventListener('click', e => closeTab(path, e));
    bar.appendChild(tab);
  }
}

async function saveCurrentFile() {
  if (!State.activeFile) return;
  const f = State.openFiles.get(State.activeFile);
  if (!f) return;
  const content = monacoEditor.getValue();
  try {
    await api('/api/file', { method: 'POST', body: JSON.stringify({ path: State.activeFile, content }) });
    f.modified = false; f.content = content;
    renderTabs();
    notify(`Saved ${State.activeFile.split('/').pop()}`, 'ok');
  } catch (e) {
    notify('Save failed: ' + e.message, 'err');
  }
}

function showEmptyEditor() {
  const el = document.getElementById('editor-mount');
  if (monacoEditor) monacoEditor.setModel(null);
  el.innerHTML = `<div class="empty-editor">
    <div class="big-icon">💻</div>
    <p>Open a file from the explorer</p>
    <p style="font-size:11px;color:var(--text-dim)">or ask the AI to create one</p>
  </div>`;
}

function hideEmptyEditor() {
  const el = document.getElementById('editor-mount');
  const empty = el.querySelector('.empty-editor');
  if (empty) el.innerHTML = '';
}

// ── DevLab Modes (branded picker) ────────────────────────────────────────────
async function loadDevLabModes() {
  // Model selection is internal — UI shows only the DevLab Coder identity.
  State.devlabMode = 'devlab-coder';
  State.model = null;
  State.provider = 'ollama';
}
      State.provider = 'ollama';
}

// Keep loadProviders for admin/dashboard use — not shown in main UI
async function loadProviders() {
  try {
    const providers = await api('/api/providers');
    State.providers = providers;
  } catch { /* offline */ }
}

function populateModels(provider) {
  // No-op in client-facing UI — model selection is handled by loadDevLabModes
}

// ── Project info ──────────────────────────────────────────────────────────────
async function loadProjectInfo() {
  try {
    const data = await api('/api/project');
    document.getElementById('project-name').textContent = data.name;
    document.title = `DevLab — ${data.name}`;
  } catch {}
}

// ── Terminal / output ─────────────────────────────────────────────────────────
function termLine(text, cls = '') {
  const body = document.getElementById('terminal-body');
  const el = document.createElement('div');
  el.className = `term-line ${cls}`;
  el.textContent = text;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  // Auto-expand
  if (cls !== 'dim') document.getElementById('terminal-strip').classList.remove('collapsed');
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  // Send button + Enter
  document.getElementById('btn-send').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.getElementById('chat-input').addEventListener('input', function () { autoResize(this); });

  // Toolbar buttons
  document.getElementById('btn-save').addEventListener('click', saveCurrentFile);
  document.getElementById('btn-format').addEventListener('click', () => monacoEditor?.getAction('editor.action.formatDocument')?.run());
  document.getElementById('btn-new-chat').addEventListener('click', () => {
    State.ws?.send(JSON.stringify({ type: 'new_session' }));
  });
  document.getElementById('btn-clear-chat').addEventListener('click', () => {
    State.ws?.send(JSON.stringify({ type: 'clear' }));
    clearChatMessages();
  });
  document.getElementById('btn-refresh-tree').addEventListener('click', () => loadFileTree());
  document.getElementById('btn-new-file').addEventListener('click', newFilePrompt);
  document.getElementById('btn-clear-term').addEventListener('click', () => {
    document.getElementById('terminal-body').innerHTML = '';
  });
  document.getElementById('btn-toggle-term').addEventListener('click', () => {
    document.getElementById('terminal-strip').classList.toggle('collapsed');
  });
  document.getElementById('terminal-header').addEventListener('click', (e) => {
    if (e.target.closest('.icon-btn')) return;
    document.getElementById('terminal-strip').classList.toggle('collapsed');
  });

  // Git button
  document.getElementById('btn-git').addEventListener('click', async () => {
    try {
      const data = await api('/api/git');
      termLine('── Git Status ──', 'tool');
      if (data.error) termLine(data.error, 'err');
      else termLine(JSON.stringify(data, null, 2), 'dim');
    } catch (e) { termLine('Git error: ' + e.message, 'err'); }
  });

  // Run button
  document.getElementById('btn-run').addEventListener('click', () => {
    sendChatMsg('Run the project and show me the output or any errors.');
  });

  // Context menu
  document.addEventListener('click', () => hideCtx());
  document.getElementById('ctx-menu').addEventListener('click', e => {
    const action = e.target.dataset.action;
    const item = State.currentCtxTarget;
    if (!item) return;
    if (action === 'open' && item.type === 'file') openFile(item.path);
    if (action === 'copy-path') navigator.clipboard?.writeText(item.path).then(() => notify('Copied!', 'ok'));
    if (action === 'delete') {
      if (confirm(`Delete ${item.path}?`)) {
        sendChatMsg(`Delete the file at path "${item.path}"`);
      }
    }
    hideCtx();
  });

  // Resize handles
  makeResizable('resize-sidebar', 'sidebar', 'x');
  makeResizable('resize-chat', 'chat-panel', 'x', true);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendChatMsg(text) {
  document.getElementById('chat-input').value = text;
  sendChat();
}

function setBusy(busy) {
  const btn = document.getElementById('btn-send');
  const input = document.getElementById('chat-input');
  const modeSel = null; // model selection removed from UI
  btn.disabled = busy;
  btn.classList.toggle('busy', busy);
  input.disabled = busy;
  if (modeSel) modeSel.disabled = busy;
  if (busy) {
    btn.setAttribute('aria-busy', 'true');
    setStatus('Waiting for response…');
  } else {
    btn.removeAttribute('aria-busy');
    State.requestStartedAt = 0;
  }
  if (!busy) currentAgentMsg = null;
}

function finishAgentMessage() {
  if (!currentAgentMsg) return;
  currentAgentMsg.classList.remove('streaming');
  currentAgentMsg.querySelector('.msg-body')?.classList.remove('streaming-cursor');
  State.streaming = false;
}

function setStatus(text) {
  document.getElementById('chat-status').textContent = text;
}

function updateBreadcrumb(path) {
  document.getElementById('breadcrumb').textContent = path || 'No file open';
}

function notify(text, type = 'ok') {
  const el = document.createElement('div');
  el.className = `notif ${type}`;
  el.textContent = text;
  document.getElementById('notifications').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function newFilePrompt() {
  const name = prompt('File path (relative to project root):');
  if (!name) return;
  openFile(name);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
const esc = escapeHtml;

function makeResizable(handleId, targetId, axis, reverseDir = false) {
  const handle = document.getElementById(handleId);
  const target = document.getElementById(targetId);
  if (!handle || !target) return;
  let startPos, startSize;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    startPos = axis === 'x' ? e.clientX : e.clientY;
    startSize = axis === 'x' ? target.offsetWidth : target.offsetHeight;
    const move = (e) => {
      const delta = (axis === 'x' ? e.clientX : e.clientY) - startPos;
      const newSize = reverseDir ? startSize - delta : startSize + delta;
      const prop = axis === 'x' ? 'width' : 'height';
      const minMax = axis === 'x' ? [140, 520] : [60, 300];
      if (newSize >= minMax[0] && newSize <= minMax[1]) {
        target.style[prop] = newSize + 'px';
        monacoEditor?.layout();
      }
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

function showCtx(e, item) {
  e.preventDefault();
  e.stopPropagation();
  State.currentCtxTarget = item;
  const menu = document.getElementById('ctx-menu');
  menu.style.left = e.pageX + 'px';
  menu.style.top = e.pageY + 'px';
  menu.classList.remove('hidden');
}
function hideCtx() {
  document.getElementById('ctx-menu').classList.add('hidden');
}

function fileIcon(ext) {
  const map = {
    js:'🟨', ts:'🔷', jsx:'⚛️', tsx:'⚛️',
    py:'🐍', rb:'💎', go:'🐹', rs:'🦀',
    java:'☕', kt:'🟣', swift:'🧡',
    dart:'💙', html:'🌐', css:'🎨', scss:'🎨',
    json:'📋', yaml:'📋', yml:'📋', toml:'📋',
    md:'📝', txt:'📄', sh:'⚙️', bash:'⚙️',
    sql:'🗄️', graphql:'◈', gql:'◈',
    gradle:'🐘', xml:'📰', plist:'📋',
  };
  return map[ext] || '📄';
}

function extToLang(ext) {
  const map = {
    js:'javascript', ts:'typescript', jsx:'javascript', tsx:'typescript',
    py:'python', rb:'ruby', go:'go', rs:'rust',
    java:'java', kt:'kotlin', swift:'swift',
    dart:'dart', html:'html', css:'css', scss:'scss',
    json:'json', yaml:'yaml', yml:'yaml', toml:'toml',
    md:'markdown', sh:'shell', bash:'shell', sql:'sql',
    graphql:'graphql', gql:'graphql', xml:'xml',
    gradle:'groovy', c:'c', cpp:'cpp', h:'c',
  };
  return map[ext] || 'plaintext';
}

// ── Command palette (Cmd/Ctrl+K) — Cursor-style quick actions ─────────────────
const PALETTE_COMMANDS = [
  { id: 'save',      label: '💾 Save current file',        kbd: '⌘S',  run: () => saveCurrentFile() },
  { id: 'format',    label: '✨ Format document',           kbd: '⌥F',  run: () => monacoEditor?.getAction('editor.action.formatDocument')?.run() },
  { id: 'newfile',   label: '📄 New file',                  kbd: '',    run: () => newFilePrompt() },
  { id: 'tree',      label: '🔄 Refresh file tree',         kbd: '',    run: () => loadFileTree() },
  { id: 'chat',      label: '💬 Focus chat',                kbd: '⌘L',  run: () => document.getElementById('chat-input').focus() },
  { id: 'newchat',   label: '🆕 New chat session',          kbd: '',    run: () => State.ws?.send(JSON.stringify({ type: 'new_session' })) },
  { id: 'clearchat', label: '🧹 Clear chat context',        kbd: '',    run: () => { State.ws?.send(JSON.stringify({ type: 'clear' })); clearChatMessages(); } },
  { id: 'term',      label: '⌨️ Toggle terminal',           kbd: '⌘J',  run: () => document.getElementById('terminal-strip').classList.toggle('collapsed') },
  { id: 'git',       label: '🌿 Git status',                kbd: '',    run: () => document.getElementById('btn-git').click() },
  { id: 'dash',      label: '📊 Open dashboard',            kbd: '',    run: () => window.open('/dashboard.html', '_blank') },
];

let paletteIdx = 0;

function openFileCommands(query) {
  // Fuzzy file opener: any tree-known file matching the query
  const files = [];
  document.querySelectorAll('#file-tree .tree-item.file').forEach(el => {
    const p = el.dataset.path;
    if (p) files.push(p);
  });
  return files
    .filter(p => fuzzyMatch(query, p))
    .slice(0, 8)
    .map(p => ({ id: 'open:' + p, label: '📂 ' + p, kbd: '', run: () => openFile(p) }));
}

function fuzzyMatch(query, target) {
  const q = query.toLowerCase(), t = target.toLowerCase();
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i >= q.length;
}

function paletteItems(query) {
  const q = (query || '').trim();
  const cmds = PALETTE_COMMANDS.filter(c => !q || fuzzyMatch(q, c.label));
  return q.length >= 2 ? [...cmds, ...openFileCommands(q)] : cmds;
}

function renderPalette() {
  const input = document.getElementById('palette-input');
  const list = document.getElementById('palette-list');
  const items = paletteItems(input.value);
  paletteIdx = Math.min(paletteIdx, Math.max(0, items.length - 1));
  list.innerHTML = '';
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'palette-item' + (i === paletteIdx ? ' active' : '');
    row.innerHTML = `<span>${item.label}</span><span class="palette-kbd">${item.kbd}</span>`;
    row.addEventListener('click', () => { closePalette(); item.run(); });
    row.addEventListener('mousemove', () => { paletteIdx = i; renderPalette(); });
    list.appendChild(row);
  });
  if (!items.length) list.innerHTML = '<div class="palette-item">No matching commands</div>';
}

function openPalette() {
  document.getElementById('palette-overlay').style.display = 'flex';
  const input = document.getElementById('palette-input');
  input.value = '';
  paletteIdx = 0;
  renderPalette();
  input.focus();
}

function closePalette() {
  document.getElementById('palette-overlay').style.display = 'none';
}

function bindPalette() {
  const overlay = document.getElementById('palette-overlay');
  const input = document.getElementById('palette-input');
  if (!overlay || !input) return;

  overlay.addEventListener('click', e => { if (e.target === overlay) closePalette(); });
  input.addEventListener('input', () => { paletteIdx = 0; renderPalette(); });
  input.addEventListener('keydown', e => {
    const items = paletteItems(input.value);
    if (e.key === 'Escape') { closePalette(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = (paletteIdx + 1) % items.length; renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = (paletteIdx - 1 + items.length) % items.length; renderPalette(); }
    else if (e.key === 'Enter' && items[paletteIdx]) { e.preventDefault(); closePalette(); items[paletteIdx].run(); }
  });

  // Global shortcuts
  window.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); document.getElementById('chat-input').focus(); }
    else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); document.getElementById('terminal-strip').classList.toggle('collapsed'); }
    else if (mod && e.key.toLowerCase() === 's' && !document.getElementById('editor-mount').contains(document.activeElement)) {
      e.preventDefault(); saveCurrentFile();
    }
    else if (e.key === 'Escape' && document.getElementById('palette-overlay').style.display === 'flex') closePalette();
  });
}

document.addEventListener('DOMContentLoaded', bindPalette);

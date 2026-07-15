// DevLab Tab Complete — VS Code inline completion provider.
// Talks to a running DevLab UI server (`devlab ui`) at devlab.endpoint.
const vscode = require('vscode');

let enabled = true;
let statusBar;
let lastRequest = 0;

function cfg() {
  return vscode.workspace.getConfiguration('devlab');
}

function updateStatusBar() {
  if (!statusBar) return;
  statusBar.text = enabled ? '$(sparkle) DevLab' : '$(circle-slash) DevLab';
  statusBar.tooltip = `DevLab tab completions: ${enabled ? 'on' : 'off'} (click to toggle)`;
  statusBar.show();
}

async function fetchCompletion(body, timeoutMs) {
  const endpoint = cfg().get('endpoint') || 'http://localhost:4321';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${endpoint}/api/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.completion || null;
  } catch {
    return null; // server down / timeout — fail silently, never annoy the user
  } finally {
    clearTimeout(timer);
  }
}

const provider = {
  async provideInlineCompletionItems(document, position, _context, token) {
    if (!enabled || !cfg().get('enabled')) return { items: [] };

    // Debounce: wait, then bail if a newer keystroke superseded us
    const myRequest = ++lastRequest;
    const debounce = cfg().get('debounceMs') || 300;
    await new Promise((r) => setTimeout(r, debounce));
    if (token.isCancellationRequested || myRequest !== lastRequest) return { items: [] };

    const offset = document.offsetAt(position);
    const text = document.getText();
    const prefix = text.slice(Math.max(0, offset - 4000), offset);
    const suffix = text.slice(offset, offset + 1500);
    if (!prefix.trim()) return { items: [] };

    const completion = await fetchCompletion({
      prefix,
      suffix,
      language: document.languageId,
      filename: vscode.workspace.asRelativePath(document.uri),
      useIndex: cfg().get('useIndex'),
      provider: cfg().get('provider') || undefined,
    }, 6000);

    if (!completion || token.isCancellationRequested || myRequest !== lastRequest) return { items: [] };

    return {
      items: [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))],
    };
  },
};

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'devlab.toggleCompletions';
  updateStatusBar();

  context.subscriptions.push(
    statusBar,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
    vscode.commands.registerCommand('devlab.toggleCompletions', () => {
      enabled = !enabled;
      updateStatusBar();
      vscode.window.setStatusBarMessage(`DevLab completions ${enabled ? 'enabled' : 'disabled'}`, 2000);
    }),
  );
  registerEditorActions(context);
}

function deactivate() {}

// ── Editor actions: Fix / Explain / Refactor with DevLab ─────────────────────
// Sends the selection (or diagnostic range) to the DevLab OpenAI-compatible
// API and applies the returned code as a workspace edit with preview.

async function chatOnce(promptSystem, promptUser, timeoutMs = 60000) {
  const endpoint = cfg().get('endpoint') || 'http://localhost:4321';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = cfg().get('apiKey');
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'devlab',
        messages: [
          { role: 'system', content: promptSystem },
          { role: 'user', content: promptUser },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`DevLab server ${resp.status}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function extractCode(answer) {
  const m = String(answer).match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return m ? m[1].replace(/\n$/, '') : null;
}

async function replaceSelection(editor, range, promptSystem, label) {
  const doc = editor.document;
  const code = doc.getText(range);
  const context = doc.getText(new vscode.Range(
    doc.positionAt(Math.max(0, doc.offsetAt(range.start) - 2000)),
    doc.positionAt(Math.min(doc.getText().length, doc.offsetAt(range.end) + 2000)),
  ));
  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DevLab: ${label}…`, cancellable: false },
    () => chatOnce(promptSystem,
      `File: ${vscode.workspace.asRelativePath(doc.uri)} (${doc.languageId})\n\nSURROUNDING CONTEXT:\n\`\`\`\n${context}\n\`\`\`\n\nCODE TO ${label.toUpperCase()}:\n\`\`\`\n${code}\n\`\`\``)
  );
  const newCode = extractCode(answer);
  if (!newCode) {
    vscode.window.showWarningMessage('DevLab: no code block in response.');
    return;
  }
  await editor.edit((eb) => eb.replace(range, newCode));
  vscode.window.setStatusBarMessage(`DevLab: ${label} applied`, 3000);
}

const FIX_SYSTEM = 'You fix bugs and defects in the given code. Return ONLY the corrected code in a single fenced code block. Preserve indentation and style. No commentary.';
const REFACTOR_SYSTEM = 'You refactor the given code for clarity and maintainability without changing behavior. Return ONLY the refactored code in a single fenced code block. No commentary.';
const EXPLAIN_SYSTEM = 'You explain code precisely and concisely for a professional developer. Cover what it does, key logic, and any pitfalls.';

class DevLabActions {
  provideCodeActions(document, range, ctx) {
    const actions = [];
    if (!range.isEmpty || ctx.diagnostics.length) {
      const target = ctx.diagnostics.length ? ctx.diagnostics[0].range : range;
      const fix = new vscode.CodeAction('DevLab: Fix this', vscode.CodeActionKind.QuickFix);
      fix.command = { command: 'devlab.fixSelection', title: 'Fix', arguments: [document.uri, target] };
      const refactor = new vscode.CodeAction('DevLab: Refactor', vscode.CodeActionKind.RefactorRewrite);
      refactor.command = { command: 'devlab.refactorSelection', title: 'Refactor', arguments: [document.uri, range] };
      const explain = new vscode.CodeAction('DevLab: Explain', vscode.CodeActionKind.Empty);
      explain.command = { command: 'devlab.explainSelection', title: 'Explain', arguments: [document.uri, range] };
      actions.push(fix, refactor, explain);
    }
    return actions;
  }
}

function registerEditorActions(context) {
  const withEditor = (fn) => async (uri, range) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const r = range && !range.isEmpty ? range : editor.selection;
    if (r.isEmpty) { vscode.window.showInformationMessage('DevLab: select some code first.'); return; }
    try { await fn(editor, r); }
    catch (e) { vscode.window.showErrorMessage(`DevLab: ${e.message} — is "devlab ui" running?`); }
  };

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ pattern: '**' }, new DevLabActions(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.Empty],
    }),
    vscode.commands.registerCommand('devlab.fixSelection', withEditor((ed, r) => replaceSelection(ed, r, FIX_SYSTEM, 'fix'))),
    vscode.commands.registerCommand('devlab.refactorSelection', withEditor((ed, r) => replaceSelection(ed, r, REFACTOR_SYSTEM, 'refactor'))),
    vscode.commands.registerCommand('devlab.explainSelection', withEditor(async (ed, r) => {
      const code = ed.document.getText(r);
      const answer = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'DevLab: explaining…' },
        () => chatOnce(EXPLAIN_SYSTEM, `Explain this ${ed.document.languageId} code:\n\`\`\`\n${code}\n\`\`\``)
      );
      const doc = await vscode.workspace.openTextDocument({ content: answer, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    })),
  );
}

module.exports = { activate, deactivate };

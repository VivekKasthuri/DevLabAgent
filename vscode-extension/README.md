# DevLab Tab Complete (VS Code extension)

Cursor-style inline AI completions in VS Code, powered by your local DevLab agent — any provider (Groq / Claude / Ollama), your semantic index, zero subscription.

## How it works

```
VS Code (this extension)
   └─ POST /api/complete ──► DevLab UI server (devlab ui, port 4321)
                                └─ fast-model LLM + semantic code index
```

- Fill-in-the-middle prompt (code before + after cursor)
- Cross-file context pulled from DevLab's semantic index
- Debounced (300ms), cancellable, 6s timeout, fails silently if the server is down
- Status bar toggle: click **✨ DevLab** or run `DevLab: Toggle Tab Completions`

## Install

1. Start DevLab's UI server in your project: `devlab ui` (or `node index.js ui`)
2. Package + install the extension:
   ```bash
   cd vscode-extension
   npx @vscode/vsce package
   code --install-extension devlab-tab-0.1.0.vsix
   ```
   Or for development: open this folder in VS Code and press F5.

## Settings

| Setting | Default | Description |
|---|---|---|
| `devlab.endpoint` | `http://localhost:4321` | DevLab UI server URL |
| `devlab.enabled` | `true` | Master switch |
| `devlab.debounceMs` | `300` | Typing pause before requesting |
| `devlab.useIndex` | `true` | Include semantic-index context |
| `devlab.provider` | (DevLab default) | Force groq/claude/ollama |

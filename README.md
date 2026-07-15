# DevLab 🤖

**The autonomous AI coding agent that fills every gap Claude, Copilot, & Cursor miss.**

Powered by Groq, Claude, and local free-model backends.

[![PR CI](https://img.shields.io/badge/PR%20CI-enabled-blue)](./.github/workflows/ci.yml)

## What makes it unique

| Feature | Claude | Cursor | **DevLab** |
|---|---|---|---|
| Persistent memory across sessions | ❌ | ❌ | ✅ SQLite |
| Free to use | ❌ | ❌ | ✅ Groq free tier / local models |
| Web search | ❌ | ❌ | ✅ DuckDuckGo |
| StackOverflow search | ❌ | ❌ | ✅ Built-in |
| Voice input | ❌ | ❌ | ✅ Groq Whisper |
| Security scanning | ❌ | ❌ | ✅ OWASP patterns |
| Performance analysis | ❌ | ❌ | ✅ N+1, O(n²) |
| Workflow automation | ❌ | ❌ | ✅ YAML workflows |
| Token/cost tracking | ❌ | ❌ | ✅ Per-session |
| Multi-repo awareness | ❌ | Partial | ✅ Learn any repo |
| Autonomous mode | ❌ | ❌ | ✅ No confirmations |
| Dependency CVE scan | ❌ | ❌ | ✅ npm/pip audit |
| Jira / Confluence | ❌ | ❌ | ✅ Atlassian API |
| Web/backend support | ❌ | Partial | ✅ Java, Flask, FastAPI, Go routers, REST, GraphQL |
| Design handoff | ❌ | Partial | ✅ Figma, Sketch, mobile UI mapping |
| Automation testing | ❌ | Partial | ✅ Selenium, Appium |

## Quick Start

### 1. Choose a model provider

- Groq: free tier at [console.groq.com](https://console.groq.com)
- Claude: add your Anthropic API key
- Ollama/free models: run a local model server

### 2. Install

```bash
cd Agent
npm install
cp .env.example .env
# Edit .env with the provider keys you want to use
```

### 3. Run

```bash
devlab             # Start chat (default)
devlab chat --provider claude --model claude-3-5-sonnet-latest
devlab check .     # Detect ALL issues in current project
devlab fix .       # Auto-fix ALL issues in current project
devlab fix-all     # Fix ALL registered repositories at once
devlab repos add <path>       # Register a repo
devlab repos list             # List registered repos
devlab repos discover ~/code  # Auto-find all git repos
devlab learn .     # Learn current project into memory
devlab memory      # Browse memories
devlab providers   # Show model providers
node index.js mcp     # See loaded MCP servers and tools
node index.js mcp --reload  # Reload MCP servers after config changes
# MCP works with LOCAL servers (command/args, spawned via stdio) and
# REMOTE hosted servers (url + optional auth headers, Streamable HTTP):
#   ~/.devlab/mcp-servers.json →
#   { "servers": {
#       "github":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
#       "internal": { "url": "https://mcp.mycompany.com/mcp",
#                     "headers": { "Authorization": "Bearer <token>" } } } }
# Or just ask in chat: "add mcp server https://mcp.mycompany.com/mcp"
# Privacy local-only mode blocks remote MCP URLs (localhost still allowed).
devlab scan src/   # Security scan
devlab voice       # Voice mode (needs sox)
devlab workflow code-review   # Run workflow
devlab jira search "project = ABC ORDER BY updated DESC"
devlab confluence search "space = DOCS ORDER BY lastmodified DESC"
devlab ci .      # Run pre-PR CI gate
devlab develop ABC-123 --space DOCS   # Prompts before creating the Confluence page
devlab develop ABC-123 --space DOCS --ci --repo .   # Gate on CI before page creation
devlab ui swift "https://www.figma.com/file/..." --output generated-ui --write
devlab mobile ui swift "https://www.figma.com/file/..." --output generated-ui --write
devlab automation detect .
devlab automation test . --platform auto
```

When you run `devlab chat` without provider flags, it opens a dropdown to pick the model provider and model.

### PR checks

- GitHub Actions: `.github/workflows/ci.yml`
- Jenkins: `Jenkinsfile`
- Local: `npm run ci`
- Protect `main`/`master` and require the GitHub check `PR CI / ci`

### Web/backend support

- Java/Spring Boot backend services
- Flask and FastAPI APIs
- Go APIs with Gin, Echo, Fiber, and chi
- REST and GraphQL APIs
- API contracts, controllers, services, resolvers, and schema reviews
- Selenium and Appium test automation projects

### Mobile design handoff

- `devlab ui <platform> <url>` to generate platform-specific UI scaffolds
- `devlab mobile design <path>` to inspect Figma/Sketch wireframes and assets
- `devlab mobile ui <platform> <design-url>` to generate platform-specific UI scaffolds
- `analyze_design_assets` is available to the agent for screen/component mapping
- Use it before implementing mobile UI from design files

### Automation testing

- `devlab automation detect <path>` to detect Selenium/Appium project setup
- `devlab automation analyze <path>` to inspect runners, configs, and page objects
- `devlab automation test <path>` to run the detected automation suite

### Model configuration

- `MODEL_PROVIDER=groq|claude|ollama|free|copilot`
- `MODEL_NAME=...`
- `CLAUDE_API_KEY=...`
- `CLAUDE_MODEL=...`
- `OPENAI_COMPAT_BASE_URL=http://localhost:11434`
- `OPENAI_COMPAT_MODEL=...`
- `COPILOT_FALLBACK_PROVIDER=groq|claude|ollama` (Copilot mode routes through this provider)

### Team LLM server (shared GPU box)

Turn any machine (Mac Studio, Linux GPU box, spare workstation) into a private
LLM endpoint for your whole team — code never leaves your network:

```bash
./scripts/setup-llm-server.sh            # auto-detects hardware, installs Ollama, picks a model
./scripts/setup-llm-server.sh --dry-run  # preview without changing anything
```

It prints the exact `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL` settings
each developer needs.

### Custom model — DevLab Coder (build your own)

Ship a security-hardened model of your own on top of gpt-oss (OpenAI, Apache 2.0) via Ollama
(MIT-licensed weights, free for commercial use). Two layers:

**Layer 1 — instant, no GPU** (system-prompt + params via Ollama Modelfile):

```bash
./scripts/create-devlab-model.sh              # auto-sizes base, builds "devlab-coder"
./scripts/create-devlab-model.sh --name acme-coder --base gpt-oss:20b
```

The script pulls the base, applies `models/Modelfile` (security-first system
prompt: SQLi/XSS/secrets/TOCTOU/race-condition rules, CWE citations, low-temp
params), builds the model, and smoke-tests that it flags a SQL injection.

**Layer 2 — real fine-tune** (QLoRA, one 24GB GPU or free Colab):

```bash
node scripts/export-training-data.mjs .       # harvest KB + rubric + security seed set -> train.jsonl
python scripts/finetune-qlora.py --data train.jsonl
./scripts/create-devlab-model.sh --gguf out/devlab-coder-q4.gguf   # deploy tuned weights
```

The exporter turns your `.devlab/kb/KNOWLEDGE.md` entries and `rubric.json`
criteria into chat-format training pairs and always includes a built-in
security seed set (10 CWE-annotated vulnerability/fix examples). Every rubric
correction DevLab records makes the next fine-tune better — that's the data
flywheel.

Then point DevLab at it: `MODEL_PROVIDER=ollama OPENAI_COMPAT_MODEL=devlab-coder`.

### Figma setup

- Add `FIGMA_API_TOKEN=...` to `.env` to read Figma file URLs via the API

### Atlassian setup

Add these to `.env`:

```bash
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your_api_token
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
CONFLUENCE_EMAIL=you@example.com
CONFLUENCE_API_TOKEN=your_api_token
```

### Optional: Install globally

```bash
npm link
devlab              # Now works from anywhere!
```

## Chat Commands

Inside the REPL:

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/memory` | List all saved memories |
| `/memory <query>` | Search memories |
| `/forget <key>` | Delete a memory |
| `/cost` | Show token usage |
| `/stats` | Full stats |
| `/clear` | Clear conversation (memory persists) |
| `/workflow <name>` | Run a workflow |
| `/workflows` | List available workflows |
| `/learn [path]` | Learn & index a project |
| `/model` | Change provider/model from a dropdown |
| `/develop <ticket>` | Build a Jira-driven dev brief + technical design |
| `/mcp` | Show loaded MCP servers/tools |
| `/mcp reload` | Reload MCP servers after config changes |
| `/voice` | Start voice mode |
| `/sessions` | Show recent sessions |
| `/exit` | Exit and save session |

## Capabilities

### 36 Built-in Tools

1. `read_file` — Read any file
2. `write_file` — Create/overwrite files
3. `list_files` — Directory listing with glob patterns
4. `search_files` — grep-style search across files
5. `delete_file` — Delete files
6. `run_command` — Execute shell commands
7. `git_status` — Git status + recent commits
8. `git_diff` — Staged/unstaged diff
9. `git_commit` — Stage all + commit
10. `git_create_branch` — Create & checkout branch
11. `git_push` — Push to remote
12. `web_search` — DuckDuckGo (no API key)
13. `fetch_url` — Fetch URL content
14. `search_stackoverflow` — StackOverflow answers
15. `remember` — Save to long-term memory
16. `recall` — Search long-term memory
17. `scan_security` — OWASP vulnerability scan
18. `analyze_project` — Project structure analysis
19. `generate_tests` — Test stub generation
20. `analyze_performance` — N+1, O(n²) detection
21. `scan_dependencies` — CVE audit (npm/pip)
22. `jira_search` — Search Jira issues
23. `jira_get_issue` — Get a Jira issue
24. `jira_create_issue` — Create Jira issue
25. `jira_add_comment` — Add Jira comment
26. `jira_get_transitions` — Jira workflow transitions
27. `jira_transition_issue` — Transition Jira issue
28. `confluence_search` — Search Confluence pages
29. `confluence_get_page` — Get Confluence page
30. `confluence_create_page` — Create Confluence page
31. `confluence_update_page` — Update Confluence page
32. `confluence_child_pages` — List child pages
33. `confluence_recent_pages` — List recent pages
34. `run_ci` — Pre-PR CI gate
35. `validate_api_contracts` — REST/OpenAPI/GraphQL/Postman contract checks and endpoint diffing
36. `develop_from_jira` — Jira ticket → task breakdown + technical design + Confluence brief

### Persistent Memory

All memories survive across sessions in `~/.devlab/memory.db`.

```
You: Remember that this project uses PostgreSQL 15 with pgvector
Agent: ✓ Saved to memory

# (next session, days later)
You: What database does this project use?
Agent: [recalls from memory] PostgreSQL 15 with pgvector
```

### Workflow Engine

Define repeatable workflows in YAML:

```yaml
name: deploy-prep
description: Pre-deployment checklist
steps:
  - name: Security scan
    type: tool
    name: scan_security
    args:
      path: "{{project_path}}"
      projectLevel: "true"
  
  - name: Run tests
    type: shell
    command: "npm test"
    cwd: "{{project_path}}"
  
  - name: Review results
    type: agent
    prompt: "Review the security scan and test results. Is it safe to deploy?"
```

Run with: `devlab workflow deploy-prep`

### Voice Input

Requires `sox`: `brew install sox`

```bash
devlab voice
# Or inside chat: /voice
```

### Safety Modes

Set in `.env`:

```
SAFETY_MODE=normal      # Ask before destructive ops (default)
SAFETY_MODE=strict      # Ask before ALL shell/git commands
SAFETY_MODE=autonomous  # Never ask — fully autonomous
```

## Examples

```
▶ Analyze this project and find any security issues

▶ Create a REST API endpoint for user authentication with JWT

▶ Search the web for the best way to implement rate limiting in Express

▶ Write tests for all files in src/utils/

▶ Commit all changes with a descriptive message

▶ Remember that the staging server is at staging.example.com

▶ What do I know about this project from previous sessions?
```

## Desktop Apps

DevLab ships as native desktop applications alongside the CLI and web UI:

| Platform | Tech | Build command | Output |
|---|---|---|---|
| macOS | Electron | `npm run build:mac` | `dist/DevLab-*.dmg` / `.zip` |
| **Windows** | Electron | `npm run build:win` | `dist/DevLab *.exe` (NSIS installer + portable) |
| Linux | Electron | `npm run build:linux` | AppImage / deb / rpm |
| Windows (native) | WPF (.NET) | `dotnet build apps/windows/DevLab` | Native WPF app |
| macOS (native) | SwiftUI | Xcode: `apps/macos` | Native Mac app |

All desktop apps embed the full agent (chat, file tree, editor, terminal) and the
same local-first privacy guarantees.

**Unified design system**: all surfaces — web UI, macOS SwiftUI app, and Windows
WPF app — share one visual language defined in `ui/design-tokens.json`
(near-black `#0f0f0f` backgrounds, violet `#a78bfa` accent, identical status
colors). The web UI consumes the tokens via CSS variables in
`ui/public/style.css`; the native apps mirror them in
`apps/macos/DevLab/DevLab/Models.swift` (Color extension) and
`apps/windows/DevLab/DevLab/App.xaml` (brushes). When changing the theme,
update the JSON first, then the two native palettes.

Notes:
- Cross-building Windows from macOS works with `npm run build:win`; the unpacked
  app lands in `dist/win-unpacked/DevLab.exe` before installer packaging.
- Behind a corporate proxy, electron-builder's binary downloads may be blocked
  (HTTP 403). Pre-seed `~/Library/Caches/electron-builder/` by downloading the
  reported archive with `curl`, or build on a network without TLS interception.
- The WPF app (`apps/windows/DevLab`) requires the .NET SDK on Windows.

## Enterprise self-host (Docker)

One command deploys the full stack — agent UI + private US-origin LLM — on any
Docker host. Code never leaves the machine:

```bash
DEVLAB_API_KEY=your-secret WORKSPACE=/path/to/repos docker compose up -d
# open http://localhost:4321 — API + WebSocket require "Authorization: Bearer your-secret"
```

- **Auth**: set `DEVLAB_API_KEY` to require a Bearer token on every `/api` and
  `/v1` route and on WebSocket connections (401 / close-4401 otherwise).
  Unset = open, for local single-user use.
- **Native SSO (OIDC)**: point DevLab at any IdP — Okta, Azure AD, Google,
  Keycloak, Authentik:

  ```bash
  DEVLAB_OIDC_ISSUER=https://login.corp.com/realms/dev
  DEVLAB_OIDC_CLIENT_ID=devlab
  DEVLAB_OIDC_CLIENT_SECRET=...        # optional — PKCE covers public clients
  DEVLAB_OIDC_ALLOWED_DOMAIN=corp.com  # optional — restrict sign-in domain
  ```

  Browser users are redirected to `/auth/login` (authorization-code + PKCE,
  HMAC-signed session cookies, 8h TTL, `/auth/me`, `/auth/logout`). Zero extra
  components, works air-gapped — the only network calls are to *your* IdP.
  API keys keep working alongside SSO for CI and the IDE extension.
- **Audit**: every tool execution is recorded to `~/.codeagent/audit.log` (JSONL).
- **GPU**: uncomment the NVIDIA block in `docker-compose.yml` for GPU inference.
- **Full deployment guide**: [`deploy/README.md`](deploy/README.md) covers all four
  models — local air-gapped, on-prem team server (Compose), private cloud VPC
  ([Terraform for AWS](deploy/terraform/aws/)), and multi-tenant SaaS — plus a
  rollout playbook and capacity guide.
- **How it works (CLI & apps)**: [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) —
  every surface (CLI, web UI, macOS/Windows apps, VS Code), the server API they
  share, and local vs hosted connection modes.
- **Self-hosted vs client-hosted model setup**:
  [`docs/SELF_HOST_AND_CLIENT_HOST_MODEL_SETUP.md`](docs/SELF_HOST_AND_CLIENT_HOST_MODEL_SETUP.md) —
  step-by-step setup for apps and CLI in both deployment patterns.

## Quality: cross-model verification

Complex-tier answers produced by a **local** model are automatically verified
by the strongest cloud rung available (gpt-oss-120b / Claude). If the verifier
finds critical defects, the task is re-run on the stronger model — frontier-
checked answers with ~90% of inference still free/local. Disabled automatically
in local-only privacy mode; opt out with `DEVLAB_CROSS_VERIFY=off`.

## Claude-free frontier ceiling

DevLab's top model rung has **zero Claude dependency**. On complex tasks the
router reaches for **gpt-oss-120b** first (OpenAI's open-weight model, Apache
2.0, US-origin) — frontier-class reasoning, self-hostable, and acceptable to
US-government/regulated clients. Claude is an optional fallback, never a
requirement:

- Set `DEVLAB_CLAUDE=off` to strip Claude from every routing ladder, even with
  an Anthropic key configured.
- Override the reasoning rung with `OPENROUTER_REASONING_MODEL` or
  `TOGETHER_REASONING_MODEL`.
- Cross-model verification uses the same rung, so quality checks are also
  Claude-free.


## Architecture

```
index.js              — CLI entry point (Commander.js)
src/
  agent.js            — ReAct agent loop (Reason→Act→Observe)
  llm.js              — Multi-provider LLM adapter (Groq, Claude, Ollama, Copilot alias)
  memory.js           — Persistent SQLite memory (node:sqlite)
  ui.js               — Terminal UI (chalk, ora, marked)
  workflow.js         — YAML workflow engine
  tools/
    files.js          — File system operations
    shell.js          — Safe shell execution
    git.js            — Git operations (simple-git)
    web.js            — Web search + URL fetch
    code.js           — Security scan, perf analysis, test gen
    voice.js          — Voice input (Groq Whisper)
workflows/
  examples/
    code-review.yaml  — Automated code review
    auto-test.yaml    — Test generation workflow
```

## Configuration

```env
MODEL_PROVIDER=groq                 # groq | claude | ollama | free | copilot
GROQ_API_KEY=gsk_...                # Required for Groq
GROQ_MODEL=llama-3.3-70b-versatile   # Optional — Groq default model
CLAUDE_API_KEY=sk-ant-...            # Optional — Anthropic/Claude
CLAUDE_MODEL=claude-3-5-sonnet-latest
OPENAI_COMPAT_BASE_URL=http://localhost:11434
OPENAI_COMPAT_MODEL=llama3.1
MEMORY_DB_PATH=~/.devlab/memory.db  # Optional
SAFETY_MODE=normal             # strict | normal | autonomous
```

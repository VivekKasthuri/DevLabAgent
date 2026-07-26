# DevLab 🤖

**The autonomous AI coding agent that fills the gaps other coding agents miss.**

Powered by DevLab routing and local/self-hosted model backends.

## Current agent setup

- Runtime: **Node.js 22.5+** (`node:sqlite` is required)
- Package manager: **npm**
- Default memory DB: `~/.codeagent/memory.db`
- Default MCP config: `~/.codeagent/mcp-servers.json`
- Default safety mode: `SAFETY_MODE=normal`

## What makes it unique

| Feature | Claude | Cursor | Copilot | **DevLab** |
|---|---|---|---|---|
| Persistent memory across sessions | — | — | — | ✅ SQLite |
| DevLab model family | — | — | — | ✅ `devlab-coder` + smart routing |
| Web search | — | — | — | ✅ DuckDuckGo |
| StackOverflow search | — | — | — | ✅ Built-in |
| Voice input | — | — | — | ✅ Built-in speech input |
| Security scanning | — | — | — | ✅ OWASP patterns |
| Performance analysis | — | — | — | ✅ N+1, O(n²) |
| Workflow automation | — | — | — | ✅ YAML workflows |
| Token/cost tracking | — | — | — | ✅ Per-session |
| Multi-repo awareness | — | — | — | ✅ Learn any repo |
| Autonomous mode | — | — | — | ✅ No confirmations |
| Dependency CVE scan | — | — | — | ✅ npm/pip audit |
| Jira / Confluence | — | — | — | ✅ Atlassian API |
| Web/backend support | — | — | — | ✅ Java, Flask, FastAPI, Go routers, REST, GraphQL |
| Design handoff | — | — | — | ✅ Figma, Sketch, mobile UI mapping |
| Automation testing | — | — | — | ✅ Selenium, Appium |

## Quick Start

### 1. Choose a model provider

- DevLab local model: run `devlab-coder` on Ollama
- Self-hosted OpenAI-compatible endpoint: point DevLab at your internal model server
- Copilot fallback mode: use DevLab routing on top of your configured fallback

### 2. Install

```bash
cd Agent
npm install
cp .env.example .env
# Recommended: run guided setup (writes .env for you)
devlab setup
# Or edit .env manually with the provider keys you want to use
```

### 3. Run

```bash
devlab             # Start chat (default)
devlab chat --provider ollama --model devlab-coder
devlab check .     # Detect ALL issues in current project
devlab fix .       # Auto-fix ALL issues in current project
devlab fix-all     # Fix ALL registered repositories at once
devlab repos add <path>       # Register a repo
devlab repos list             # List registered repos
devlab repos discover ~/code  # Auto-find all git repos
devlab learn .     # Learn current project into memory
devlab memory      # Browse memories
devlab providers   # Show configured providers and routing
node index.js mcp     # See loaded MCP servers and tools
node index.js mcp --reload  # Reload MCP servers after config changes
# MCP works with LOCAL servers (command/args, spawned via stdio) and
# REMOTE hosted servers (url + optional auth headers, Streamable HTTP):
#   ~/.codeagent/mcp-servers.json →
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
devlab mobile ui swift "https://www.figma.com/file/..." --output generated-ui --write
devlab automation detect .
devlab automation test . --platform auto
```

When you run `devlab chat` without provider flags, it opens a dropdown to pick the model provider and model.

### PR checks

- Local CI gate: `devlab ci .` or `npm run ci`
- Jenkins pipeline: `Jenkinsfile`
- GitHub Actions can be added/enabled if your repo uses workflow checks

### Web/backend support

- Java/Spring Boot backend services
- Flask and FastAPI APIs
- Go APIs with Gin, Echo, Fiber, and chi
- REST and GraphQL APIs
- API contracts, controllers, services, resolvers, and schema reviews
- Selenium and Appium test automation projects

### Mobile design handoff

- `devlab mobile ui <platform> <url>` to generate platform-specific UI scaffolds
- `devlab mobile design <path>` to inspect Figma/Sketch wireframes and assets
- `devlab mobile ui <platform> <design-url>` to generate platform-specific UI scaffolds
- `analyze_design_assets` is available to the agent for screen/component mapping
- Use it before implementing mobile UI from design files

### Automation testing

- `devlab automation detect <path>` to detect Selenium/Appium project setup
- `devlab automation analyze <path>` to inspect runners, configs, and page objects
- `devlab automation test <path>` to run the detected automation suite

### Model configuration

- `MODEL_PROVIDER=ollama|copilot`
- `MODEL_NAME=...`
- `OPENAI_COMPAT_BASE_URL=http://localhost:11434`
- `OPENAI_COMPAT_MODEL=...`
- `COPILOT_FALLBACK_PROVIDER=ollama` (Copilot mode routes through this provider)
- `DEVLAB_CODE_MODEL=...` (code-generation model for DevLab smart routing)
- `DEVLAB_REVIEW_MODEL=...` (code-review quality model for DevLab smart routing)
- `DEVLAB_FAST_MODEL=...` (low-latency model for quick tasks)

### DevLab models

- `devlab-coder` is the primary DevLab model identity used by smart routing.
- Build/refresh it locally:

```bash
./scripts/create-devlab-model.sh
```

- Point DevLab to the model:

```bash
MODEL_PROVIDER=ollama
OPENAI_COMPAT_MODEL=devlab-coder
```

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

### 81 Built-in Tools

| Category | Tools |
|---|---|
| Files & execution | `read_file`, `write_file`, `list_files`, `search_files`, `delete_file`, `run_command`, `detect_build_system`, `build_project` |
| Architecture, diagrams & planning | `generate_diagram`, `recommend_development`, `project_rules`, `generate_rubric`, `score_rubric`, `detect_architecture`, `detect_layer_violations`, `analyze_di`, `check_di` |
| Docker, PRs & privacy | `docker`, `docker_sandbox`, `generate_dockerfile`, `pr_prompt_statement`, `pr_baseline`, `knowledge_base`, `set_privacy` |
| Search, delegation & code intelligence | `delegate_task`, `semantic_search`, `build_code_index`, `check_endpoint_conflicts`, `check_race_conditions` |
| Git, web & memory | `github_pr`, `git_status`, `git_diff`, `git_commit`, `git_create_branch`, `git_push`, `web_search`, `fetch_url`, `search_stackoverflow`, `remember`, `recall` |
| Project analysis & code quality | `scan_security`, `analyze_project`, `generate_tests`, `analyze_performance`, `review_file`, `review_project`, `review_diff`, `apply_fix`, `validate_api_contracts`, `run_ci` |
| Mobile & design handoff | `detect_mobile_platform`, `analyze_mobile_project`, `analyze_design_assets`, `generate_mobile_ui`, `run_mobile_tests`, `run_mobile_lint`, `build_mobile`, `scan_mobile_security`, `detect_mobile_issues` |
| Automation testing | `detect_automation_platform`, `analyze_automation_project`, `run_automation_tests` |
| Jira & Confluence | `jira_search`, `jira_get_issue`, `jira_create_issue`, `jira_add_comment`, `jira_get_transitions`, `jira_transition_issue`, `confluence_search`, `confluence_get_page`, `confluence_create_page`, `confluence_update_page`, `confluence_child_pages`, `confluence_recent_pages`, `develop_from_jira` |
| MCP server management | `mcp_list_servers`, `mcp_reload_servers`, `mcp_catalog`, `mcp_suggest_servers`, `mcp_add_server`, `mcp_remove_server` |

### Persistent Memory

All memories survive across sessions in `~/.codeagent/memory.db`.

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
by the strongest reasoning rung available. If the verifier finds critical
defects, the task is re-run on the stronger model. Disabled automatically in
local-only privacy mode; opt out with `DEVLAB_CROSS_VERIFY=off`.

## High-end reasoning ceiling

On complex tasks the router can reach for **gpt-oss-120b** first — frontier-
class reasoning, self-hostable, and suitable for regulated environments.

- Override the reasoning rung with `OPENROUTER_REASONING_MODEL` or
  `TOGETHER_REASONING_MODEL`.
- Cross-model verification uses the same rung, so quality checks stay aligned
  with the strongest configured reasoning model.


## Architecture

```
index.js              — CLI entry point (Commander.js)
src/
  agent.js            — ReAct agent loop (Reason→Act→Observe)
  llm.js              — Multi-provider LLM adapter and smart routing
  memory.js           — Persistent SQLite memory (node:sqlite)
  ui.js               — Terminal UI (chalk, ora, marked)
  workflow.js         — YAML workflow engine
  tools/
    files.js          — File system operations
    shell.js          — Safe shell execution
    git.js            — Git operations (simple-git)
    web.js            — Web search + URL fetch
    code.js           — Security scan, perf analysis, test gen
    voice.js          — Voice input
workflows/
  examples/
    code-review.yaml  — Automated code review
    auto-test.yaml    — Test generation workflow
```

## Configuration

```env
MODEL_PROVIDER=ollama
OPENAI_COMPAT_BASE_URL=http://localhost:11434
OPENAI_COMPAT_MODEL=devlab-coder
DEVLAB_CODE_MODEL=codellama:13b
DEVLAB_REVIEW_MODEL=mistral:7b
DEVLAB_FAST_MODEL=llama3.2:3b
MEMORY_DB_PATH=~/.codeagent/memory.db  # Optional
SAFETY_MODE=normal             # strict | normal | autonomous
```

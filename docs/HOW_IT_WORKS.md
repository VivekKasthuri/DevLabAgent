# DevLab — How It Works: CLI & Apps

DevLab is one agent with five surfaces. All of them talk to the **same core**
(`src/agent.js` + 81 tools), so behavior is identical everywhere — only the
interface differs.

```
                    ┌────────────────────────────────────────────┐
                    │                DevLab Core                  │
   CLI ────────────►│  agent loop · 81 tools · router · memory   │
   Web UI ─────────►│  rules · quality loops · privacy · MCP     │
   macOS app ──────►│                                            │
   Windows app ────►│  LLMs: Ollama (local) / Groq / OpenAI-     │
   VS Code ext ────►│  compat / optional Claude                  │
                    └────────────────────────────────────────────┘
```

---

## 1. CLI (`node index.js …`)

The CLI is the primary surface and the engine behind everything else.

### First run

```bash
git clone <repo> && cd Agent && npm install
node index.js setup        # interactive wizard → writes .env
node index.js              # start chatting (default command)
```

### Command reference

| Command | What it does |
|---|---|
| `node index.js` / `chat` | Interactive agent chat in your terminal (default) |
| `setup` | Wizard: providers, keys, ports → `.env` |
| `ui [path]` | Start the web UI at `http://localhost:4321` |
| `providers` | List/test configured model providers |
| `learn [path]` | Index a codebase into the knowledge base |
| `memory` | View/manage long-term memory |
| `scan <path>` | Security scan (secrets, vulns, anti-patterns) |
| `fix [path]` | Autonomously find and fix issues in a project |
| `fix-all` | Multi-repo: fix issues across every registered repo |
| `repos` | Register/manage multiple repositories |
| `review [path]` | AI code review of local changes/PRs |
| `mobile [path]` | Mobile project analysis (Swift/Kotlin/RN/Flutter) |
| `analyze-di [path]` | Dependency-injection / architecture analysis |
| `automation [path]` | Generate/run automation workflows |
| `workflow <name>` | Run a saved workflow |
| `jira [action]` | Jira from the terminal (list, create, transition…) |
| `confluence [action]` | Confluence pages from the terminal |
| `develop <issueKey>` | Full loop: read Jira ticket → implement → PR |
| `ci [path]` | Generate/validate CI pipelines |
| `test [path]` | Generate and run tests |
| `check [path]` | Health check: lint + tests + security |
| `mcp [action] [name]` | Manage MCP servers (add/remove/list/suggest) |
| `voice` | Voice input mode |

### How a chat turn works

1. Your message goes to the **router** (`src/router.js`) which scores complexity
   and picks the cheapest capable model (local small → local large → cloud)
2. The **agent loop** (`src/agent.js`) runs: LLM call → tool calls (file edits,
   shell, git, Jira, MCP…) → results fed back → repeat until done
3. **Quality loop**: complex answers are verified by a stronger model; failures
   are re-run
4. **Memory + rules**: project rules from `.devlab/rules`, long-term memory,
   and the knowledge base are injected into context automatically

### Key config (`.env`)

```bash
MODEL_PROVIDER=ollama              # or groq / openai-compat
OPENAI_COMPAT_BASE_URL=http://localhost:11434
DEVLAB_PRIVACY=local-only          # block ALL external calls (air-gap)
DEVLAB_CLAUDE=off                  # guarantee no Anthropic usage
DEVLAB_API_KEY=…                   # require Bearer auth on the web UI/API
UI_PORT=4321
JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN     # Atlassian (or auto-prompted)
```

---

## 2. Web UI (`node index.js ui`)

A Cursor-like IDE in the browser, served by `ui/server.js` (Express + WebSocket).

- **Explorer** — file tree of the workspace (`GET /api/files`)
- **Editor** — open/edit/save files (`GET/POST /api/file`)
- **Chat** — streams agent responses, tool calls, and results over WebSocket
- **Dashboard** — token usage, costs, model routing stats
- **Auth** — optional `DEVLAB_API_KEY` (Bearer) and/or native OIDC SSO
  (Okta, Azure AD, Keycloak) — see README "Enterprise self-host"

The web UI is what the Docker image runs (`CMD node index.js ui /workspace`),
making it the surface for hosted deployments (see `deploy/README.md`).

### Server API (used by all apps)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/providers` | GET | Providers/models + health check |
| `/api/workspace` | GET/POST | Get/switch the active project folder |
| `/api/files?path=.` | GET | File tree |
| `/api/file?path=<rel>` | GET/POST | Read / write a file |
| `/api/git` | GET | Git status |
| `/ws` (same port) | WS | Chat: `chat`, `new_session`, `clear` → `token`, `tool_call`, `done`… |

---

## 3. macOS app (`apps/macos/DevLab`, SwiftUI)

Native three-pane IDE: **Explorer | Editor | Chats**, plus a real PTY terminal.

### How it connects

`AgentService.swift` supports two modes, switched in **Server Settings**
(server-rack icon in the CHATS header):

- **Local mode** (default, Server URL empty): the app checks
  `localhost:4321`; if nothing is running it **spawns the server itself**
  (`node index.js ui`), locating Node in Homebrew/nvm/asdf paths and the Agent
  repo at the bundled path or `~/Agent`. Requires Node.js on the Mac.
- **Hosted mode** (Server URL set, e.g. `https://devlab.corp.com`): connect
  only — never spawns. Sends `Authorization: Bearer <API key>` on every REST
  call and `?api_key=` on the WebSocket. `http/https` auto-map to `ws/wss`.
  Includes a **Test Connection** button (✓ connected / ✗ bad key / ✗ unreachable).

Settings persist in `UserDefaults`; **Save & Connect** applies live.

### Features

- Welcome screen: Open Folder, Continue Last Session, Recent Projects
- Opening a folder calls `POST /api/workspace` so the server's file APIs
  resolve against your project
- Chat panel (CHATS): streaming responses, tool-call cards, **+** starts a
  fresh session, model/provider pickers in the toolbar
- Terminal: real PTY (`forkpty`) — interactive programs, ANSI colors,
  `\r` progress bars all render correctly
- Build: open `apps/macos/DevLab/DevLab.xcodeproj` in Xcode → ⌘R

## 4. Windows app (`apps/windows/DevLab`, WPF/C#)

Same architecture as the macOS app: spawns or connects to the server,
`AgentService.cs` mirrors the Swift client (REST + WebSocket, workspace
switching). Build with Visual Studio / `dotnet build`.

## 5. VS Code extension (`vscode-extension/`)

Chat sidebar + inline actions inside VS Code, talking to the same server API
with the same auth. Works against local or hosted servers.

---

## Local vs hosted at a glance

| | Local (default) | Hosted (team server / VPC / SaaS) |
|---|---|---|
| Who runs the server | App/CLI on your machine | Docker/Terraform (see `deploy/`) |
| Needs Node.js locally | Yes (CLI/apps spawn it) | No — apps just connect |
| Auth | None (localhost) | `DEVLAB_API_KEY` Bearer + optional SSO |
| Models | Your Ollama | Shared GPU Ollama/vLLM |
| Configure apps | Nothing | Server Settings: URL + API key |

For deployment instructions (Docker Compose, AWS Terraform, capacity), see
[`deploy/README.md`](../deploy/README.md).

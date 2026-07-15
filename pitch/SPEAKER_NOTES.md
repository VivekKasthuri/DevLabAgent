# DevLab Pitch — Speaker Notes & Investor Q&A Prep

Open `deck.html` in any browser. Navigate with ← → arrows, click, or spacebar.

---

## Timing (target: 12 minutes + Q&A)

| Slide | Time | Key line to land |
|---|---|---|
| 1 Title | 30s | "We built the orchestration layer for AI coding — it's live, tested, and revenue-ready." |
| 2 Problem | 90s | "$200/mo, opaque limits, vendor lock-in — and the agents still ship race conditions." |
| 3 Solution | 90s | "One agent, six surfaces, any model, catches bugs mid-edit — and runs 100% on your own hardware for $5/mo." |
| 4 Demo | 3m | **Do it live.** The R002 race-condition prompt is the money moment. |
| 5 Why now | 60s | "Model prices collapse → value moves to orchestration. We ARE the orchestration." |
| 6 Moat | 60s | Point at the two "unique" rows first. |
| 7 Business model | 60s | "Transparent overage — the #1 competitor complaint, solved." |
| 8 Two business models | 60s | "Cloud agents rent intelligence per seat, forever. DevLab lets you buy it once and share it — or mix both. Rivals structurally can't follow." |
| 9 Deployment models | 60s | "Option A: we host it, client installs only the app. Option B: they host it, nothing ever leaves their network. Same app, either way." |
| 10 Market | 45s | "0.1% penetration = $5.4M ARR. Cursor proved willingness to pay." |
| 11 Traction | 45s | "189 tests green, 9 languages, MVVM/VIPER/TCA/DI checked. Not a prototype — a product." |
| 12 GTM | 60s | "PR bot is the team wedge: one champion, whole repo sees scorecards." |
| 13 Competition | 30s | Deliver the one-liner slowly. |
| 14 Ask | 60s | Be specific: $1.5M, 18 months, 3 milestones. |
| 15 Close | 15s | Stop talking. Let them ask. |

---

## The 3-minute live demo script

1. **Fix a bug**: `devlab "fix the failing test in checkout"` — narrate the ReAct loop as it explores → patches → re-runs tests.
2. **Guard fires**: pre-stage an edit that introduces shared mutable state in an async handler. When DevLab flags `R002` and *asks the developer how to resolve it*, pause and say: *"No other agent on the market does this."*
3. **DI analysis**: run `devlab analyze-di ./MyiOSProject` — shows VIPER or TCA detection, layer violations, and fixes. *"It knows your architecture pattern and enforces it."*
4. **PR scorecard**: show a rubric-scored review comment on a real PR + the CI merge gate blocking a low-score PR.
5. **`devlab models`**: show the branded picker — "DevLab Coder (Auto), Code, Review, Fast" — *"Client never sees codellama or mistral. Just DevLab."*

**Backup plan**: record the demo as a video in advance. Never rely on conference Wi-Fi or a corporate proxy.

---

## Anticipated investor questions & answers

**Q: Why won't Cursor/Anthropic just copy the guards?**
A: They can copy a feature; they can't copy the position. Claude Code is structurally single-vendor — routing against Anthropic's interest. Cursor's margin depends on model markup — our token-optimization attacks their P&L. The guards + routing telemetry compound: every task routed teaches us cost/quality tradeoffs they don't collect.

**Q: What's defensible about a wrapper on other people's models?**
A: Same question was asked about Cursor at $0 → answered at $500M ARR. Value: (1) routing intelligence — 71–86% measured cost reduction, (2) unique static-analysis guards wired into the edit loop, (3) multi-surface distribution, (4) offline/hybrid mode cloud rivals structurally can't offer, (5) architecture-aware DI checker across 9 languages.

**Q: How do you compete on model quality?**
A: We don't — we *use* the best model per task. Complex → Claude, standard → Groq/GPT, trivial → local CodeLlama/Mistral. When a better model ships, we route to it day one. Lock-in players can't.

**Q: What's the infra cost to serve one client?**
A: Oracle Cloud free tier (model server) + Hetzner CX22 ($4/mo) = **~$5/mo total**. Per enterprise client on dedicated server: ~$160–300/mo, billed at $299–999/mo. Healthy margins from day one.

**Q: What are the two deployment options?**
A: Option A (Vendor-Hosted): we deploy a private server per client, client downloads only the app and enters a URL + API key. Takes 2 minutes on their side. Option B (Client-Hosted): their IT runs one setup script on their own server — model and prompts never leave their network. Both options use the same binary. Source code never moves in either case.

**Q: How is source code kept private?**
A: Client installs only the app binary — no source code sent to us. `DEVLAB_NO_LOG=1` means prompts are processed in memory and discarded after inference. We can deploy a dedicated server per client (self-hosted) or the client deploys on their own network (client-hosted). Either way, source never reaches a vendor-operated AI service.

**Q: Traction is all product, no users. Why raise now?**
A: Deliberate: we built to revenue-readiness before launch (billing, quotas, license keys, 189 tests, 9-language DI checker all live). The raise funds the launch, not the build. Milestone 1 is 10K installs in 6 months on open-core distribution.

**Q: What are the real COGS on the free tier?**
A: Near zero — free tier defaults to local Ollama inference on the user's machine. Premium requests are hard-capped by the quota system already in `src/billing.js`.

**Q: Team? Solo founder risk?**
A: [Fill in: your background, and name the first 2 hires the raise funds — one infra, one DevRel.]

**Q: Exit paths?**
A: Strategic acquirers on both sides — model labs need distribution/orchestration (Anthropic bought developer-tool startups), dev-tool platforms need agent tech (GitHub, GitLab, JetBrains, Atlassian). Or standalone: Cursor's trajectory shows the standalone path.

---

## One-pager summary (for cold emails)

> **DevLab** is an autonomous AI coding agent that runs on any surface (CLI, web, native macOS/Windows, IDE, OpenAI-compatible API, GitHub PR bot), routes each task to the cheapest capable model (Claude/GPT/CodeLlama/local), and statically catches race conditions, endpoint conflicts, and DI/architecture violations *while it edits* — guards no competitor has. Hard privacy mode + source-never-leaves-client architecture mean regulated teams can deploy with confidence. MVP infra costs $5/mo (Oracle free + Hetzner). Smart 3-model router (CodeLlama · Mistral · Llama3.2) auto-picks per task; clients see only "DevLab Coder". DI analysis covers MVVM, VIPER, TCA, Clean Architecture, BLoC across 9 languages. Measured 71–86% token-cost reduction. Plans at $0/$8/$15/$25/$60 undercut every competitor tier. 81 tools, **189 tests**, 6 surfaces shipped. Raising **$1.5M seed** for launch + first 1,000 paid seats.

---

## Numbers cheat-sheet (know cold)

- 81 tools · **189 tests** · 26 test files · 6 surfaces
- Token overhead: 9,887 → ~1,400–2,800 tokens/call (71–86% cut)
- Pricing: **$0 / $7 / $12 / $20 / $49 / $599 flat / $999 client-hosted** vs Cursor $20/$40/$200, Claude $20/$25(throttled)/$100–200, Copilot $10/$19/$39 — undercut every tier
- Overage: $0.02/premium request · $0.30/1M tokens
- Market: ~30M devs; 0.1% on Pro = $4.3M ARR
- Ask: $1.5M · 18-month runway · 40% eng / 35% GTM / 25% infra
- MVP infra: Oracle Cloud free + Hetzner $4/mo = **$5/mo total**
- Enterprise margin: $160/mo server cost → $199–599/mo client billing (Option A) · $999/mo pure license (Option B)
- Models: CodeLlama 13B (code), Mistral 7B (review), Llama3.2 3B (fast) — US-origin, Apache 2.0
- DI/arch checker: 9 languages, MVVM + VIPER + TCA + Clean + BLoC + MVC patterns

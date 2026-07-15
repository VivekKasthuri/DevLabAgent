# DevLab Deployment Guide

Four deployment models, from a single laptop to enterprise VPC. Pick the one that
matches your client's security posture and team size.

---

## One-command fine-tune + deploy (knowledge-base aware)

If you want your own tuned model before any deployment option, run:

```bash
bash scripts/train-and-deploy.sh --with-history --model 13b --epochs 3 --name devlab-code
```

This single command:
- exports training data from `.devlab/kb/KNOWLEDGE.md`, `rubric.json`, and `~/.devlab/memory.db`
- fine-tunes with QLoRA
- builds GGUF
- creates the Ollama model
- updates `.env` to use the new model

Use this before Option A/B/C/D if you want custom behavior for a client/team.

| Option | Where it runs | Cost | Best for |
|---|---|---|---|
| A — Local | Each dev machine | $0 | Pilots, regulated/air-gapped users |
| B — Team server | One on-prem GPU box | Hardware only | Teams of 10–50 sharing one LLM |
| C — Private cloud (VPC) | Client's AWS/Azure/GCP | GPU instance | Enterprises wanting cloud + isolation |
| D — SaaS | Your fleet, multi-tenant | Your infra | Per-seat licensing |

---

## Option A — Fully local (air-gapped)

Each developer machine:

```bash
# 1. Install Ollama + models
brew install ollama            # or https://ollama.com/download
ollama pull gpt-oss:20b        # small/fast
ollama pull llama3.1:8b        # fallback

# 2. Install DevLab
git clone <devlab-repo> && cd Agent && npm install
node index.js setup            # interactive wizard (.env)

# 3. Hard privacy: block ALL external calls (cloud LLMs, remote MCP)
echo "DEVLAB_PRIVACY=local-only" >> .env

node index.js                  # CLI
node index.js ui               # web UI at http://localhost:4321
```

Nothing leaves the machine. Suitable for finance / government / healthcare.

---

## Option B — Shared on-prem inference server (Docker Compose)

One GPU box (e.g. 2×A100, 4×4090, or a Mac Studio) serves the whole team.
The repo's `docker-compose.yml` at the project root runs **DevLab + Ollama** together:

```bash
# On the server
DEVLAB_API_KEY=$(openssl rand -hex 24) \
DEVLAB_MODEL=gpt-oss:120b \
WORKSPACE=/srv/repos \
docker compose up -d
```

- Web UI: `http://server:4321` (Bearer auth via `DEVLAB_API_KEY`)
- NVIDIA GPUs: uncomment the `deploy.resources` block in `docker-compose.yml`
  and install [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

Developers can also keep DevLab CLI local and only share the LLM:

```bash
# On each dev machine — point at the team server's Ollama
echo "OPENAI_COMPAT_BASE_URL=http://llm.internal:11434" >> .env
```

Capacity guide: gpt-oss:20b ≈ 16 GB VRAM, gpt-oss:120b ≈ 80 GB (or 4-bit ≈ 64 GB).
~30–50 devs per 2×A100 server with continuous batching (use vLLM for >20 concurrent).

---

## Option C — Private cloud VPC (Terraform, AWS)

Deploys inside the **client's own AWS account** — code and prompts never leave
their VPC. See [`terraform/aws/`](terraform/aws/):

```bash
cd deploy/terraform/aws
terraform init
terraform apply \
  -var="key_name=my-ec2-key" \
  -var="allowed_cidr=10.0.0.0/8" \
  -var="devlab_model=gpt-oss:120b"
```

What it creates:
- VPC + private subnet + security group (UI 4321 + Ollama 11434, restricted to `allowed_cidr`)
- One GPU instance (`g5.12xlarge` default, configurable) with NVIDIA drivers,
  Docker, and the DevLab compose stack via cloud-init
- Encrypted EBS volume for model weights
- Output: private IP + SSH command + UI URL

Recommended hardening:
- Put an ALB + ACM cert in front of port 4321 for TLS
- Enable DevLab SSO (`SSO_*` env vars — see main README) behind the client's IdP
- Set `DEVLAB_PRIVACY=local` so the agent can only use the in-VPC Ollama

Azure/GCP: the cloud-init script (`user_data.sh.tpl`) is provider-agnostic —
port the instance/network resources and reuse it.

---

## Option D — SaaS (you host, clients subscribe)

Architecture sketch:

```
clients (browser/CLI) ──► API gateway (auth, per-seat licensing)
                              │
                              ├─► DevLab web UI pods  (one per tenant, WORKSPACE isolated)
                              └─► shared vLLM GPU fleet (gpt-oss-120b, devlab-coder)
```

- Tenant isolation: one DevLab container per tenant, separate `WORKSPACE` volume,
  per-tenant `DEVLAB_API_KEY`
- Licensing: Stripe/Paddle per-seat (integration pending — see roadmap)
- Scale the model tier independently with vLLM + autoscaling GPU node group

---

## Rollout playbook

1. **Pilot (week 1):** 5 devs on Option A — zero infra, immediate value
2. **Team (week 2–4):** Option B server; run the multi-repo PR bot on their repos as the demo
3. **Enterprise (month 2+):** Option C in their VPC with SSO + `local` privacy mode

## Environment variables quick reference

| Var | Purpose |
|---|---|
| `DEVLAB_API_KEY` | Bearer auth for web UI/API |
| `DEVLAB_PRIVACY` | `local-only` = block all external calls; `local` = local LLM only |
| `MODEL_PROVIDER` / `OPENAI_COMPAT_BASE_URL` | Point at Ollama/vLLM endpoint |
| `DEVLAB_MODEL` / `OPENAI_COMPAT_MODEL` | Default model (e.g. `gpt-oss:120b`) |
| `UI_PORT` | Web UI port (default 4321) |
| `DEVLAB_CLAUDE=off` | Guarantee no Anthropic calls |

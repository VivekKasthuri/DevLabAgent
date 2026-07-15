# DevLab — Model Deployment Setup Guide

## Core principle

**The client only downloads the DevLab app or CLI.**

All AI processing happens on a private server — either hosted by you (DevLab
vendor) or hosted by the client on their own network. In both cases:

- client source code **never goes to any vendor-operated public AI service**
- the model runs in a **private deployment boundary**
- client machines interact only through the DevLab app or CLI binary

---

## One-command model tuning (before deployment)

If you want your own tuned model for a client, run:

```bash
bash scripts/train-and-deploy.sh --with-history --model 13b --epochs 3 --name devlab-code
```

This automatically builds and deploys a GGUF model to Ollama, then updates `.env`.

Use `devlab-code` as the model name in server setup scripts.

---

## What clients install

| Platform | File | Size |
|---|---|---|
| macOS | `DevLab.dmg` | ~80 MB |
| Windows | `DevLab-Setup.exe` | ~90 MB |
| CLI (any OS) | `devlab` binary | ~50 MB |

Clients do **not** install Node.js, Ollama, Python, or any server component.
They install the app or CLI only.

---

## MVP Quick Setup — Oracle Cloud Free + Hetzner ($4/mo)

The fastest way to get DevLab running for your first clients.

### Architecture

```
Client App / CLI
      │
      ▼
Hetzner CX22  (~$4/mo)          Oracle Cloud Free Tier (ARM)
┌──────────────────────┐         ┌────────────────────────────┐
│  DevLab Node.js      │◄───────►│  Ollama + CodeLlama 13B    │
│  Nginx + HTTPS       │         │  FREE — 4 OCPU / 24GB RAM  │
└──────────────────────┘         └────────────────────────────┘
```

**Total cost: ~$5/mo** (Hetzner $4 + domain $1, Oracle is free)

---

### Step 1 — Oracle Cloud (model server, free)

1. Sign up at **cloud.oracle.com** (credit card required, not charged)
2. **Compute → Instances → Create Instance**
   - Shape: `VM.Standard.A1.Flex` — set **4 OCPU + 24 GB RAM**
   - OS: Ubuntu 22.04
   - Add your SSH key
3. SSH in and run:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_USER/devlab/main/deploy/oracle-hetzner/setup-oracle.sh)
```

Or copy `deploy/oracle-hetzner/setup-oracle.sh` to the server and run:

```bash
bash setup-oracle.sh --model codellama:13b
```

4. **Also open port 11434 in Oracle Console:**
   Cloud Console → Networking → VCN → Security List → Add Ingress Rule: TCP 11434

5. Note the **Oracle public IP** shown at the end of the script.

---

### Step 2 — Hetzner (app server, ~$4/mo)

1. Sign up at **hetzner.com/cloud**
2. Create server: **CX22** — Ubuntu 22.04 — note the public IP
3. Point your domain DNS A record → Hetzner IP
4. SSH in and run:

```bash
bash setup-hetzner.sh \
  --domain devlab.yourdomain.com \
  --oracle-ip <oracle-public-ip> \
  --key YOUR_SECRET_API_KEY
```

Script location: `deploy/oracle-hetzner/setup-hetzner.sh`

At the end the script prints the server URL and API key — those are the **only two values** you give each client.

---

### Step 3 — Client setup (2 minutes per client)

Send clients:
- The DevLab app (`DevLab.dmg` / `DevLab-Setup.exe`) or CLI binary
- Server URL: `https://devlab.yourdomain.com`
- API Key: `YOUR_SECRET_API_KEY`

**macOS / Windows app:**
```
Open app → Settings → Server URL + API Key → Save
```

**CLI:**
```bash
devlab config --host https://devlab.yourdomain.com --key YOUR_SECRET_API_KEY
devlab chat "review my code"
```

---

### MVP cost summary

| Component | Provider | Monthly cost |
|---|---|---|
| Model server (4 OCPU / 24 GB RAM) | Oracle Cloud Free | **$0** |
| App server (2 vCPU / 4 GB RAM) | Hetzner CX22 | **~$4** |
| Domain + SSL | Cloudflare | **~$1** |
| **Total** | | **~$5/mo** |

> **Note:** CodeLlama 13B on ARM CPU inference runs at ~2–5 tokens/sec. Sufficient
> for early clients and validation. Upgrade to RunPod RTX 3090 (~$130/mo) when
> you have paying clients who need faster responses.

---

## Deployment model 1 — Self-hosted

You (DevLab vendor) deploy the model and DevLab server on a dedicated private
server and give the client connection credentials.

### How data flows

```
Client machine
  DevLab app / CLI
  reads project files locally
        |
        | HTTPS  (prompt only, no full codebase)
        v
Your private server  (dedicated to this client)
  DevLab agent server
  Ollama + your tuned model
  DEVLAB_NO_LOG=1
        |
        | response
        v
Client machine
  fix / output applied locally
  source files stay on client disk
```

### What the client does

1. Download and install the DevLab app or CLI
2. Open Server Settings
3. Enter the private server URL and API key you provide
4. Open their project — all editing and git operations happen locally
5. Ask DevLab to fix, review, or generate — only the specific prompt is sent

### What you deploy

Run once on your dedicated server for this client:

```bash
bash deploy/private-server/setup.sh \
  --domain devlab.client-name.example.com \
  --model codellama:34b \
  --key CLIENT_SECRET_KEY
```

This installs Node.js, Ollama, your model, DevLab server, Nginx, HTTPS, and
firewall. `DEVLAB_NO_LOG=1` is set by the script so nothing is persisted.

### App configuration (client side)

**macOS / Windows app — Server Settings:**

```
Server URL:  https://devlab.client-name.example.com
API Key:     CLIENT_SECRET_KEY
```

**CLI:**

```bash
DEVLAB_API_KEY=CLIENT_SECRET_KEY \
DEVLAB_SERVER_URL=https://devlab.client-name.example.com \
./devlab
```

### What is and is not sent to the server

| Data | Sent? |
|---|---|
| Client source files | No — stays on client disk |
| File paths | No |
| Git history | No |
| The code snippet in the prompt | Yes — sent for inference only |
| Stored after response | No — `DEVLAB_NO_LOG=1` discards it |

---

## Deployment model 2 — Client-hosted

The client deploys DevLab and the model on their own private server or internal
network. Nothing ever leaves the client environment.

### How data flows

```
Client developer machine
  DevLab app / CLI
  reads project files locally
        |
        | HTTPS  (internal network only)
        v
Client's own private server
  DevLab agent server
  Ollama + your supplied model
  client-owned network boundary
        |
        | response
        v
Client developer machine
  fix / output applied locally
  source files stay inside client network
```

### What the client does

1. Download and install the DevLab app or CLI (from you)
2. Their IT or DevOps team runs the setup script on an internal server
3. Developers enter the internal server URL and API key
4. Everything stays inside the client network

### What you provide

- DevLab app installers and CLI binaries
- Setup script (`deploy/private-server/setup.sh`)
- Your tuned model GGUF file or Ollama model name
- API key or license key for that deployment

### What the client IT team deploys

On their internal server:

```bash
bash /opt/devlab/deploy/private-server/setup.sh \
  --domain devlab.internal.client.com \
  --model codellama:34b \
  --key INTERNAL_SECRET_KEY
```

If the client does not use public DNS they can use an internal hostname or IP:

```text
https://devlab.internal.client.com
https://10.10.20.15
https://devlab.corp.local
```

### App configuration (client developer side)

**macOS / Windows app — Server Settings:**

```
Server URL:  https://devlab.internal.client.com
API Key:     INTERNAL_SECRET_KEY
```

**CLI:**

```bash
DEVLAB_API_KEY=INTERNAL_SECRET_KEY \
DEVLAB_SERVER_URL=https://devlab.internal.client.com \
./devlab
```

### What is and is not sent anywhere

| Data | Goes outside client network? |
|---|---|
| Client source files | No |
| Prompt / code snippet | No — stays inside client network |
| Responses | No — stays inside client network |
| Stored on any server | No — `DEVLAB_NO_LOG=1` |

---

## Choosing the right model

You supply the model. Recommended base:

| Use case | Model | VRAM needed |
|---|---|---|
| All languages, best quality | CodeLlama 34B (Meta) | 20 GB |
| Lighter weight | Llama 3.1 8B (Meta) | 8 GB |
| Largest quality | Llama 3.1 70B (Meta) | 40 GB |

Fine-tune with your DevLab training data before deployment:

```bash
npm run train:data
python3 scripts/finetune-qlora.py --data train.jsonl --base 34b --epochs 3
bash scripts/create-devlab-model.sh --gguf out/devlab-coder-q4.gguf
```

---

## Comparison

| | Self-hosted | Client-hosted |
|---|---|---|
| Who installs the server | You | Client IT team |
| Where model runs | Your private server | Client private server |
| Client source leaves client machine | No | No |
| Client source leaves client network | Snippet sent to your server (not stored) | No — stays inside client network |
| Client setup effort | App / CLI install only | App / CLI + internal server deploy |
| Best for | Fast rollout, vendor-managed | Regulated, strict network control |

---

## Source code guarantee

In both models:

1. The full codebase is **never uploaded**
2. Only the snippet included in the chat prompt is transmitted
3. That snippet is **deleted immediately** after the model responds (`DEVLAB_NO_LOG=1`)
4. It is **never sent to OpenAI, Anthropic, or any public AI service**

This is the guarantee that differentiates DevLab from GitHub Copilot, Cursor,
and Claude Code — all of which send code to vendor-managed cloud services.

---

## Quick deploy checklist

### Self-hosted

- [ ] Provision a private server (Hetzner dedicated / OVH bare metal)
- [ ] Point domain to the server
- [ ] Run `deploy/private-server/setup.sh`
- [ ] Verify HTTPS and firewall
- [ ] Confirm `DEVLAB_NO_LOG=1` is set
- [ ] Build and distribute app / CLI to client developers
- [ ] Issue server URL and API key to client

### Client-hosted

- [ ] Build and send app / CLI installer to client
- [ ] Send `deploy/private-server/setup.sh` to client IT team
- [ ] Send your tuned model GGUF to client
- [ ] Client IT provisions internal server and runs setup
- [ ] Client developers install app / CLI and enter internal URL + key
- [ ] Verify model is loaded and responding on internal network

---

## Related docs

- [How DevLab works](./HOW_IT_WORKS.md)
- [Deployment guide](../deploy/README.md)
- [Private server setup script](../deploy/private-server/README.md)
- [MVP Oracle + Hetzner setup scripts](../deploy/oracle-hetzner/)

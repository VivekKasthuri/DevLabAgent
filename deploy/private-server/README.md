# DevLab Private Server — Step by Step Guide

## Optional Step 0 — Fine-tune your model in one command

If you want a client-specific tuned model, run this first (on a GPU machine):

```bash
bash scripts/train-and-deploy.sh --with-history --model 13b --epochs 3 --name devlab-code
```

Then use `--model devlab-code` in Step 3 below.

## Architecture

```
Client App (macOS/Windows)
        │
        │ HTTPS (port 443)
        ▼
  Nginx (SSL termination)
        │
        │ HTTP (port 4321, internal only)
        ▼
  DevLab Agent Server  ──► Ollama (port 11434, localhost only)
                                    │
                                    ▼
                            Your private model
                            (codellama:34b / llama3.1)
```

---

## Prerequisites

- Ubuntu 22.04 server (Hetzner / OVH / bare metal)
- Domain name pointed to your server IP  
  e.g. `model.yourcompany.com` → your server IP
- Minimum: 24GB VRAM GPU (RTX 4090) for CodeLlama 34B
- Root SSH access

---

## Step 1 — Point Your Domain

Go to your DNS provider. Add an A record:

```
Type: A
Name: model          (or devlab, or api)
Value: <your-server-IP>
TTL: 300
```

Wait 5 minutes for DNS to propagate:
```bash
ping model.yourcompany.com   # should return your server IP
```

---

## Step 2 — SSH into Your Server

```bash
ssh root@model.yourcompany.com
```

---

## Step 3 — Run Setup Script (One Command)

Copy DevLab to your server first:
```bash
# From your local machine
scp -r /Users/2495348/Agent root@model.yourcompany.com:/opt/devlab
```

Then on the server:
```bash
cd /opt/devlab
bash deploy/private-server/setup.sh \
  --domain model.yourcompany.com \
  --model devlab-code \
  --key YOUR_SECRET_KEY_HERE
```

> Replace `YOUR_SECRET_KEY_HERE` with any strong secret (e.g. `openssl rand -hex 32`)

This script does everything:
- Installs Node.js, Nginx, Ollama
- Downloads the model (~20GB for CodeLlama 34B)
- Configures HTTPS with Let's Encrypt
- Sets up firewall (only 443 exposed)
- Creates systemd services (auto-restart on reboot)

**Takes 20-40 minutes** (mostly model download)

---

## Step 4 — Verify Server is Running

```bash
# Check services
systemctl status devlab
systemctl status ollama

# Test the API
curl https://model.yourcompany.com/api/project
# → should return {"name":"devlab",...}

# Test model endpoint
curl https://model.yourcompany.com/v1/models \
  -H "Authorization: Bearer YOUR_SECRET_KEY_HERE"
# → should list available models
```

---

## Step 5 — Configure Client App

Open DevLab app on macOS or Windows.  
Click the **⚙ Server Settings** icon in the CHATS panel.

```
Server URL:  https://model.yourcompany.com
API Key:     YOUR_SECRET_KEY_HERE
```

Click **Test Connection** → should show ✅ Connected

---

## Step 6 — Distribute to Clients

Give each client:
1. The DevLab app (`.dmg` or `.exe`)
2. Server URL: `https://model.yourcompany.com`
3. Their API key (generate a unique one per client)

Clients need nothing else — no Node.js, no Ollama, no source code.

---

## Managing the Server

```bash
# View live logs
journalctl -u devlab -f

# Restart after config change
systemctl restart devlab

# Update model
ollama pull codellama:34b

# Add a new model
ollama pull llama3.1:8b

# Check GPU usage
nvidia-smi

# Revoke a client key (edit .env, restart)
nano /opt/devlab/.env
systemctl restart devlab
```

---

## Multiple Client API Keys (Optional)

For per-client keys, update DevLab's auth to support a key list.  
Or use Nginx basic auth per subdomain:

```
client1.model.yourcompany.com → key: abc123
client2.model.yourcompany.com → key: xyz789
```

---

## Cost Summary

```
Hetzner Dedicated (RTX 4090):  $180/mo
Domain:                        $12/yr
SSL (Let's Encrypt):           Free
─────────────────────────────────────
Total:                         ~$181/mo

10 clients = $18/client/mo
50 clients = $3.6/client/mo
```

#!/usr/bin/env bash
#
# DevLab — Team LLM Server Setup
#
# Turns any machine (Mac Studio, Linux GPU box, spare workstation) into a
# private LLM endpoint that every DevLab client on your network can use.
# Your code never leaves your network.
#
# Usage:
#   ./setup-llm-server.sh                 # auto-detect hardware, install, serve
#   ./setup-llm-server.sh --model gpt-oss:120b
#   ./setup-llm-server.sh --port 11434
#   ./setup-llm-server.sh --dry-run       # show what would happen, change nothing
#
set -euo pipefail

MODEL=""
PORT="11434"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)   MODEL="$2"; shift 2 ;;
    --port)    PORT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 1 ;;
  esac
done

say()  { printf '\033[1;36m[devlab]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[devlab]\033[0m %s\n' "$*"; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then echo "  (dry-run) $*"; else "$@"; fi; }

# ---------------------------------------------------------------- detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) echo "Unsupported OS: $OS (macOS and Linux only)"; exit 1 ;;
esac

# ---------------------------------------------------- detect memory and GPU
if [[ "$PLATFORM" == "macos" ]]; then
  MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
  GPU_DESC="Apple Silicon (unified memory)"
else
  MEM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 ))
  GPU_DESC="CPU only"
  if command -v nvidia-smi >/dev/null 2>&1; then
    GPU_DESC="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
    VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
    MEM_GB=$(( VRAM_MB / 1024 ))   # size the model to VRAM, not system RAM
  fi
fi

say "Platform : $PLATFORM"
say "Memory   : ${MEM_GB} GB usable for models"
say "GPU      : $GPU_DESC"

# --------------------------------------------------------- recommend model
if [[ -z "$MODEL" ]]; then
  # US-origin family: gpt-oss (OpenAI, Apache 2.0) 120b needs ~80GB, 20b ~16GB;
  # Llama 3.x (Meta) below that
  if   (( MEM_GB >= 80 )); then MODEL="gpt-oss:120b"
  elif (( MEM_GB >= 16 )); then MODEL="gpt-oss:20b"
  else                          MODEL="llama3.1:8b"
  fi
  say "Recommended model for this hardware: $MODEL"
else
  say "Using requested model: $MODEL"
fi

# ---------------------------------------------------------- install ollama
if command -v ollama >/dev/null 2>&1; then
  say "Ollama already installed: $(ollama --version 2>/dev/null | head -1)"
else
  say "Installing Ollama..."
  if [[ "$PLATFORM" == "macos" ]]; then
    if command -v brew >/dev/null 2>&1; then
      run brew install ollama
    else
      warn "Homebrew not found. Install Ollama from https://ollama.com/download/mac"
      warn "then re-run this script."
      exit 1
    fi
  else
    run sh -c 'curl -fsSL https://ollama.com/install.sh | sh'
  fi
fi

# ---------------------------------- configure to listen on the network ----
# Default Ollama binds 127.0.0.1 — team members couldn't reach it.
say "Configuring Ollama to listen on 0.0.0.0:${PORT} (LAN access)..."
if [[ "$PLATFORM" == "macos" ]]; then
  run launchctl setenv OLLAMA_HOST "0.0.0.0:${PORT}"
  warn "If Ollama.app is running, quit and reopen it to pick up the setting."
else
  if command -v systemctl >/dev/null 2>&1 && [[ $DRY_RUN -eq 0 ]]; then
    sudo mkdir -p /etc/systemd/system/ollama.service.d
    printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:%s"\n' "$PORT" \
      | sudo tee /etc/systemd/system/ollama.service.d/devlab.conf >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl restart ollama
  else
    warn "No systemd (or dry-run). Start manually with:"
    warn "  OLLAMA_HOST=0.0.0.0:${PORT} ollama serve"
  fi
fi

# --------------------------------------------------------------- pull model
say "Pulling $MODEL (this may take a while on first run)..."
run ollama pull "$MODEL"

# --------------------------------------------------------------- smoke test
if [[ $DRY_RUN -eq 0 ]]; then
  sleep 2
  if curl -fsS "http://localhost:${PORT}/v1/models" >/dev/null 2>&1; then
    say "Server is up ✔"
  else
    warn "Server not responding yet. Start it with: OLLAMA_HOST=0.0.0.0:${PORT} ollama serve"
  fi
fi

# ------------------------------------------------------------ instructions
IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[[ -z "${IP:-}" ]] && IP="$(ipconfig getifaddr en0 2>/dev/null || echo '<this-machine-ip>')"

cat <<EOF

============================================================
  DevLab team LLM server ready
============================================================

  Endpoint : http://${IP}:${PORT}
  Model    : ${MODEL}

  Every developer on your network configures DevLab with
  (in .env or the shell):

    MODEL_PROVIDER=ollama
    OPENAI_COMPAT_BASE_URL=http://${IP}:${PORT}
    OPENAI_COMPAT_MODEL=${MODEL}

  Your code never leaves your network.
============================================================
EOF

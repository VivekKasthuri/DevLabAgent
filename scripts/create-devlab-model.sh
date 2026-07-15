#!/usr/bin/env bash
# create-devlab-model.sh — build the "devlab-coder" custom model on Ollama.
#
# Layer 1 (this script): Modelfile customization on top of gpt-oss / Llama (Ollama) —
#   security-first system prompt + tuned inference params. Free, instant, no GPU.
# Layer 2 (optional):    a real fine-tune. Export training data with
#   scripts/export-training-data.mjs, train with scripts/finetune-qlora.py,
#   then re-run this script with --gguf <path> to deploy the tuned weights.
#
# Usage:
#   ./scripts/create-devlab-model.sh                 # auto-size base model
#   ./scripts/create-devlab-model.sh --base gpt-oss:120b
#   ./scripts/create-devlab-model.sh --gguf ./devlab-coder-q4.gguf   # deploy fine-tuned weights
#   ./scripts/create-devlab-model.sh --name acme-coder --dry-run
set -euo pipefail

NAME="devlab-coder"
BASE=""
GGUF=""
DRY_RUN=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELFILE="$ROOT/models/Modelfile"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --gguf) GGUF="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -16; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)"; exit 1 ;;
  esac
done

command -v ollama >/dev/null || { echo "ERROR: ollama not installed. Run scripts/setup-llm-server.sh first."; exit 1; }

# Auto-size the base model from available memory when not specified
if [[ -z "$BASE" && -z "$GGUF" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
  else
    MEM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 ))
  fi
  # US-origin models on Ollama: gpt-oss (OpenAI, Apache 2.0) or Llama 3.x (Meta)
  if   (( MEM_GB >= 16 )); then BASE="gpt-oss:20b"
  elif (( MEM_GB >= 12 )); then BASE="llama3.1:8b"
  else                          BASE="llama3.2:3b"; fi
  echo "Detected ${MEM_GB}GB RAM -> base model: $BASE"
fi

# Build a working Modelfile (swap FROM line for chosen base or GGUF weights)
TMP_MODELFILE="$(mktemp)"
trap 'rm -f "$TMP_MODELFILE"' EXIT
if [[ -n "$GGUF" ]]; then
  [[ -f "$GGUF" ]] || { echo "ERROR: GGUF file not found: $GGUF"; exit 1; }
  sed "s|^FROM .*|FROM $GGUF|" "$MODELFILE" > "$TMP_MODELFILE"
  echo "Using fine-tuned weights: $GGUF"
else
  sed "s|^FROM .*|FROM $BASE|" "$MODELFILE" > "$TMP_MODELFILE"
fi

if (( DRY_RUN )); then
  echo "--- Modelfile that would be built as '$NAME' ---"
  cat "$TMP_MODELFILE"
  exit 0
fi

# Pull base if needed (skipped when deploying local GGUF)
if [[ -z "$GGUF" ]] && ! ollama list | awk '{print $1}' | grep -qx "$BASE"; then
  echo "Pulling base model $BASE ..."
  ollama pull "$BASE" || {
    echo "ERROR: pull failed (proxy/firewall?). On corporate networks, download"
    echo "the model on an open network or deploy a local GGUF with --gguf."
    exit 1
  }
fi

echo "Creating model '$NAME' ..."
ollama create "$NAME" -f "$TMP_MODELFILE"

# Smoke test: must flag an obvious SQL injection
echo "Smoke testing security awareness ..."
RESP=$(ollama run "$NAME" 'Review: db.query("SELECT * FROM users WHERE id=" + req.params.id). One line.' 2>/dev/null || true)
echo "  Model says: ${RESP:0:200}"
if echo "$RESP" | grep -qi "injection\|SECURITY\|parameteriz"; then
  echo "  PASS: model flags SQL injection."
else
  echo "  WARN: model did not clearly flag the injection — check output above."
fi

cat <<EOF

Done. Use it in DevLab:

  MODEL_PROVIDER=ollama
  OPENAI_COMPAT_BASE_URL=http://localhost:11434
  OPENAI_COMPAT_MODEL=$NAME

To upgrade to a real fine-tune later:
  1. node scripts/export-training-data.mjs        # harvest KB/rubric -> train.jsonl
  2. python scripts/finetune-qlora.py             # QLoRA on a 24GB GPU / free Colab
  3. $0 --gguf out/devlab-coder-q4.gguf           # deploy tuned weights
EOF

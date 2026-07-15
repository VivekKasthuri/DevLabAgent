#!/usr/bin/env bash
# scripts/train-and-deploy.sh — Full pipeline: data → fine-tune → Ollama model
#
# Usage:
#   bash scripts/train-and-deploy.sh                         # interactive
#   bash scripts/train-and-deploy.sh --model 34b --epochs 3  # non-interactive
#   bash scripts/train-and-deploy.sh --data-only             # just export training data
#   bash scripts/train-and-deploy.sh --deploy-only --gguf out/devlab-coder-q4.gguf
#
# Requirements:
#   Step 1-3 (training): Python 3.10+, CUDA GPU with 24GB+ VRAM
#   Step 4   (deploy):   Ollama installed
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Defaults ──────────────────────────────────────────────────────────────────
MODEL_SIZE="34b"
EPOCHS=3
NAME="devlab-coder"
DATA_FILE="train.jsonl"
GGUF=""
DATA_ONLY=0
DEPLOY_ONLY=0
WITH_HISTORY=0

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --model)        MODEL_SIZE="$2"; shift 2 ;;
    --epochs)       EPOCHS="$2"; shift 2 ;;
    --name)         NAME="$2"; shift 2 ;;
    --data-only)    DATA_ONLY=1; shift ;;
    --deploy-only)  DEPLOY_ONLY=1; shift ;;
    --gguf)         GGUF="$2"; shift 2 ;;
    --with-history) WITH_HISTORY=1; shift ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
step() { echo -e "\n${CYAN}━━━ $1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${YELLOW}→${NC} $1"; }

echo ""
echo -e "${CYAN}  DevLab Model Training Pipeline${NC}"
echo -e "${CYAN}  ════════════════════════════════${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Export training data
# ─────────────────────────────────────────────────────────────────────────────
if [[ $DEPLOY_ONLY -eq 0 ]]; then
  step "1: Export Training Data"

  HISTORY_FLAG=""
  [[ $WITH_HISTORY -eq 1 ]] && HISTORY_FLAG="--with-history"

  node scripts/export-training-data.mjs . $HISTORY_FLAG --out "$DATA_FILE"
  ok "Training data exported → $DATA_FILE"

  EXAMPLE_COUNT=$(wc -l < "$DATA_FILE")
  info "Total examples: $EXAMPLE_COUNT"

  if [[ $EXAMPLE_COUNT -lt 100 ]]; then
    echo -e "${YELLOW}⚠ Only $EXAMPLE_COUNT examples. For better results add more:"
    echo "  - Use --with-history to include your DevLab chat sessions"
    echo "  - Add .devlab/kb/KNOWLEDGE.md entries to your projects${NC}"
  fi

  if [[ $DATA_ONLY -eq 1 ]]; then
    echo -e "\n${GREEN}Data exported. Run fine-tune when you have GPU access:${NC}"
    echo "  python scripts/finetune-qlora.py --data $DATA_FILE --base $MODEL_SIZE"
    exit 0
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Check GPU / Python
# ─────────────────────────────────────────────────────────────────────────────
if [[ $DEPLOY_ONLY -eq 0 ]]; then
  step "2: Check GPU & Python"

  if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
    echo "ERROR: Python not found. Install Python 3.10+ from https://python.org"
    exit 1
  fi

  PYTHON=$(command -v python3 || command -v python)
  PY_VER=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
  ok "Python $PY_VER"

  # Check CUDA
  if $PYTHON -c "import torch; assert torch.cuda.is_available()" 2>/dev/null; then
    GPU_NAME=$($PYTHON -c "import torch; print(torch.cuda.get_device_name(0))" 2>/dev/null || echo "Unknown GPU")
    ok "GPU: $GPU_NAME"
  else
    echo ""
    echo -e "${YELLOW}  No CUDA GPU detected on this machine.${NC}"
    echo -e "  Options:"
    echo -e "    1. Run on a GPU server: scp train.jsonl user@gpu-server: && ssh user@gpu-server"
    echo -e "    2. Use Google Colab (free T4 GPU) — upload train.jsonl and run:"
    echo -e "       !pip install unsloth"
    echo -e "       !python finetune-qlora.py --base 8b --data train.jsonl --epochs 3"
    echo -e "    3. Rent on Vast.ai: https://vast.ai (A100 ~\$1.50/hr)"
    echo -e ""
    echo -e "  Training data is ready at: $DATA_FILE"
    echo -e "  Copy it to your GPU machine and run step 3 manually.\n"
    exit 0
  fi

  # Check/install unsloth
  if ! $PYTHON -c "import unsloth" 2>/dev/null; then
    info "Installing unsloth (training library)..."
    $PYTHON -m pip install unsloth -q
  fi
  ok "unsloth ready"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Fine-tune
# ─────────────────────────────────────────────────────────────────────────────
if [[ $DEPLOY_ONLY -eq 0 ]]; then
  step "3: Fine-Tune (QLoRA) — Model: $MODEL_SIZE, Epochs: $EPOCHS"
  info "This will take 2-5 hours on an A100. Output → out/devlab-coder/"
  echo ""

  $PYTHON scripts/finetune-qlora.py \
    --base "$MODEL_SIZE" \
    --data "$DATA_FILE" \
    --epochs "$EPOCHS" \
    --out "out/devlab-coder" \
    --name "$NAME"

  GGUF="out/devlab-coder-q4.gguf"
  ok "Fine-tune complete → $GGUF"
fi

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Deploy to Ollama
# ─────────────────────────────────────────────────────────────────────────────
step "4: Deploy to Ollama"

if ! command -v ollama &>/dev/null; then
  echo "Ollama not installed. Install from https://ollama.com then run:"
  echo "  bash scripts/create-devlab-model.sh --gguf $GGUF --name $NAME"
  exit 0
fi

if [[ -n "$GGUF" ]]; then
  bash scripts/create-devlab-model.sh --gguf "$GGUF" --name "$NAME"
else
  # No GGUF = use base model with system prompt only
  bash scripts/create-devlab-model.sh --base "codellama:34b" --name "$NAME"
fi

ok "Model '$NAME' deployed to Ollama"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Update .env
# ─────────────────────────────────────────────────────────────────────────────
step "5: Configure DevLab to use your model"

ENV_FILE="$ROOT/.env"
if grep -q "OPENAI_COMPAT_MODEL" "$ENV_FILE" 2>/dev/null; then
  sed -i.bak "s/OPENAI_COMPAT_MODEL=.*/OPENAI_COMPAT_MODEL=$NAME/" "$ENV_FILE"
else
  echo "" >> "$ENV_FILE"
  echo "MODEL_PROVIDER=ollama" >> "$ENV_FILE"
  echo "OPENAI_COMPAT_BASE_URL=http://localhost:11434" >> "$ENV_FILE"
  echo "OPENAI_COMPAT_MODEL=$NAME" >> "$ENV_FILE"
fi

ok ".env updated → using model: $NAME"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  ✅ Your DevLab model is ready!${NC}"
echo ""
echo -e "  Model name : $NAME"
echo -e "  Test it    : ollama run $NAME 'Write a Swift function to fetch JSON'"
echo -e "  Use it     : devlab serve . --model-server"
echo ""
echo -e "  To deploy to your private server:"
echo -e "    scp out/devlab-coder-q4.gguf user@server:/opt/models/"
echo -e "    ssh user@server 'ollama create $NAME -f /opt/models/Modelfile'"
echo ""

#!/usr/bin/env bash
# install-cli.sh — Install "devlab" as a global CLI command
# Usage: bash scripts/install-cli.sh
set -e

AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo ""
echo "  DevLab CLI Installer"
echo "  ════════════════════"
echo ""

# --- Check Node 20+ ---
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ] || [ "$NODE_VER" -lt 20 ]; then
  echo "  ✗ Node.js 20+ required. Install from https://nodejs.org"
  exit 1
fi
echo "  ✓ Node.js $(node --version)"

# --- Install dependencies ---
echo "  → Installing dependencies..."
cd "$AGENT_DIR"
npm install --silent

# --- npm link (makes 'devlab' available globally) ---
echo "  → Linking CLI globally..."
npm link --silent 2>/dev/null || sudo npm link --silent

# --- Verify ---
if command -v devlab &>/dev/null; then
  echo "  ✓ 'devlab' command installed: $(which devlab)"
else
  echo "  ✗ Link failed. Try: sudo npm link"
  exit 1
fi

# --- Create .env if missing ---
if [ ! -f "$AGENT_DIR/.env" ]; then
  cp "$AGENT_DIR/.env.example" "$AGENT_DIR/.env"
  echo "  → Created .env (edit it to add your API keys)"
fi

echo ""
echo "  ✅ Done! You can now run:"
echo ""
echo "     devlab                  # interactive chat (CLI)"
echo "     devlab serve            # start web server + model API"
echo "     devlab serve --model-server   # also start Ollama"
echo "     devlab ui .             # open web IDE"
echo "     devlab fix .            # auto-fix project issues"
echo ""
echo "  First time? Run: devlab setup"
echo ""

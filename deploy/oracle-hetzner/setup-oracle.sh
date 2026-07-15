#!/usr/bin/env bash
# deploy/oracle-hetzner/setup-oracle.sh
# ─────────────────────────────────────────────────────────────────────────────
# DevLab MVP — Oracle Cloud Free Tier Model Server Setup
# Installs: Ollama, CodeLlama 13B
# This is your FREE GPU/CPU model inference server.
#
# Usage:
#   bash setup-oracle.sh
#   # Optional: bash setup-oracle.sh --model codellama:13b
#
# Requirements:
#   • Oracle Cloud Free Tier — VM.Standard.A1.Flex (ARM)
#     4 OCPU / 24 GB RAM / Ubuntu 22.04
#   • Port 11434 open in Oracle VCN Security List
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MODEL="${1:-codellama:13b}"

# Handle --model flag
while [[ $# -gt 0 ]]; do
  case $1 in
    --model) MODEL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[DONE]${NC}  $1"; }
step()    { echo -e "\n${CYAN}━━━ $1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

echo ""
echo -e "${CYAN}  DevLab MVP — Oracle Cloud Model Server${NC}"
echo -e "${CYAN}  ═══════════════════════════════════════${NC}"
echo -e "  Model : ${MODEL}"
echo ""

# ── Step 1: Install Ollama ────────────────────────────────────────────────────
step "Step 1/3 — Install Ollama"
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
success "Ollama $(ollama --version 2>/dev/null || echo 'installed')"

# ── Step 2: Configure Ollama to listen on all interfaces ─────────────────────
step "Step 2/3 — Configure Ollama (listen on 0.0.0.0)"
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf << EOF
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF

systemctl daemon-reload
systemctl enable ollama
systemctl restart ollama
sleep 3
success "Ollama listening on 0.0.0.0:11434"

# ── Step 3: Pull model ────────────────────────────────────────────────────────
step "Step 3/3 — Pull ${MODEL} (this may take 5-10 mins first time)"
ollama pull "$MODEL"
success "Model ${MODEL} ready"

# ── Open port in OS firewall (Oracle uses iptables) ──────────────────────────
info "Opening port 11434 in iptables..."
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 11434 -j ACCEPT 2>/dev/null || true
if command -v netfilter-persistent &>/dev/null; then
  netfilter-persistent save
else
  apt-get install -y iptables-persistent netfilter-persistent
  netfilter-persistent save
fi
success "Port 11434 open"

# ── Test ─────────────────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s icanhazip.com 2>/dev/null || echo "<your-oracle-ip>")

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Oracle Model Server Ready!                            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  🤖 Model     : ${CYAN}${MODEL}${NC}"
echo -e "  🌐 Public IP : ${CYAN}${PUBLIC_IP}${NC}"
echo -e "  🔌 Endpoint  : ${CYAN}http://${PUBLIC_IP}:11434${NC}"
echo ""
echo -e "  ${YELLOW}⚠️  Also open port 11434 in Oracle VCN Security List:${NC}"
echo -e "  Cloud Console → Networking → VCN → Security List"
echo -e "  Add Ingress Rule: TCP port 11434, Source 0.0.0.0/0"
echo ""
echo -e "  ${YELLOW}Next: Run setup-hetzner.sh with --oracle-ip ${PUBLIC_IP}${NC}"
echo ""

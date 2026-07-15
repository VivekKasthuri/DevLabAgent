#!/usr/bin/env bash
# deploy/oracle-hetzner/setup-hetzner.sh
# ─────────────────────────────────────────────────────────────────────────────
# DevLab MVP — Hetzner App Server Setup
# Installs: Node.js, DevLab agent server, Nginx, HTTPS (Let's Encrypt)
# Connects to: Oracle Cloud free tier (model server)
#
# Usage:
#   bash setup-hetzner.sh \
#     --domain devlab.yourdomain.com \
#     --oracle-ip <oracle-public-ip> \
#     --key YOUR_SECRET_API_KEY
#
# Requirements:
#   • Ubuntu 22.04 on Hetzner CX22 ($4/mo)
#   • Domain pointed at this server's IP
#   • Oracle Cloud model server already running (run setup-oracle.sh first)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
DOMAIN=""
ORACLE_IP=""
API_KEY=""
DEVLAB_PORT=4321
OLLAMA_MODEL="codellama:13b"
DEVLAB_DIR="/opt/devlab"
NODE_VERSION="20"
DEVLAB_REPO="https://github.com/YOUR_USER/devlab.git"   # ← update before using

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)    DOMAIN="$2";     shift 2 ;;
    --oracle-ip) ORACLE_IP="$2";  shift 2 ;;
    --key)       API_KEY="$2";    shift 2 ;;
    --model)     OLLAMA_MODEL="$2"; shift 2 ;;
    --repo)      DEVLAB_REPO="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$ORACLE_IP" || -z "$API_KEY" ]]; then
  echo ""
  echo "Usage: bash setup-hetzner.sh --domain devlab.yourdomain.com --oracle-ip <ip> --key YOUR_KEY"
  echo ""
  exit 1
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[DONE]${NC}  $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
step()    { echo -e "\n${CYAN}━━━ $1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

echo ""
echo -e "${CYAN}  DevLab MVP — Hetzner App Server${NC}"
echo -e "${CYAN}  ═══════════════════════════════${NC}"
echo -e "  Domain     : ${DOMAIN}"
echo -e "  Oracle IP  : ${ORACLE_IP}"
echo -e "  Model      : ${OLLAMA_MODEL}"
echo ""

# ── Step 1: System packages ───────────────────────────────────────────────────
step "Step 1/5 — System packages"
apt-get update -qq
apt-get install -y -qq curl git nginx certbot python3-certbot-nginx ufw
success "Packages installed"

# ── Step 2: Node.js ───────────────────────────────────────────────────────────
step "Step 2/5 — Node.js ${NODE_VERSION}"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi
success "Node.js $(node --version) ready"

# ── Step 3: DevLab ────────────────────────────────────────────────────────────
step "Step 3/5 — DevLab agent server"
if [[ -d "$DEVLAB_DIR" ]]; then
  info "Updating existing DevLab installation..."
  cd "$DEVLAB_DIR" && git pull --quiet
else
  git clone "$DEVLAB_REPO" "$DEVLAB_DIR"
fi

cd "$DEVLAB_DIR"
npm install --quiet

# Write .env
cat > "$DEVLAB_DIR/.env" << EOF
PORT=${DEVLAB_PORT}
OLLAMA_HOST=http://${ORACLE_IP}:11434
OLLAMA_MODEL=${OLLAMA_MODEL}
DEVLAB_API_KEY=${API_KEY}
DEVLAB_NO_LOG=1
NODE_ENV=production
EOF
chmod 600 "$DEVLAB_DIR/.env"

# ── Step 4: Systemd service ───────────────────────────────────────────────────
step "Step 4/5 — Systemd service"
cat > /etc/systemd/system/devlab.service << EOF
[Unit]
Description=DevLab Agent Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${DEVLAB_DIR}
EnvironmentFile=${DEVLAB_DIR}/.env
ExecStart=/usr/bin/node index.js serve
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable devlab
systemctl restart devlab
sleep 2

if systemctl is-active --quiet devlab; then
  success "DevLab service running"
else
  warn "DevLab service failed to start — check: journalctl -u devlab -n 30"
fi

# ── Step 5: Nginx + HTTPS ─────────────────────────────────────────────────────
step "Step 5/5 — Nginx + HTTPS"

cat > /etc/nginx/sites-available/devlab << EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass         http://127.0.0.1:${DEVLAB_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_read_timeout 300;
    }
}
EOF

ln -sf /etc/nginx/sites-available/devlab /etc/nginx/sites-enabled/devlab
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# HTTPS via Let's Encrypt
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
  --email "admin@${DOMAIN}" --redirect
success "HTTPS enabled for ${DOMAIN}"

# ── Firewall ─────────────────────────────────────────────────────────────────
ufw allow OpenSSH
ufw allow "Nginx Full"
ufw --force enable
success "Firewall configured"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         DevLab MVP Server is LIVE!                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  🌐 Server URL : ${CYAN}https://${DOMAIN}${NC}"
echo -e "  🔑 API Key    : ${CYAN}${API_KEY}${NC}"
echo -e "  🤖 Model      : ${CYAN}${OLLAMA_MODEL} on Oracle Cloud (CPU)${NC}"
echo ""
echo -e "  ${YELLOW}Give clients these 2 values:${NC}"
echo -e "  Server URL → https://${DOMAIN}"
echo -e "  API Key    → ${API_KEY}"
echo ""
echo -e "  Logs: ${CYAN}journalctl -u devlab -f${NC}"
echo ""

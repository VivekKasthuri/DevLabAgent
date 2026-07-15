#!/bin/bash
# DevLab cloud-init: installs the DevLab + Ollama compose stack on first boot.
# Provider-agnostic — reusable for Azure/GCP instances with Docker + NVIDIA drivers.
set -euxo pipefail
exec > /var/log/devlab-init.log 2>&1

DEVLAB_DIR=/opt/devlab
DEVLAB_REPO="${devlab_repo}"
DEVLAB_MODEL="${devlab_model}"
API_KEY="${devlab_api_key}"

# Auto-generate API key if not provided
if [ -z "$API_KEY" ]; then
  API_KEY=$(openssl rand -hex 24)
fi
echo "$API_KEY" > /root/devlab-api-key.txt && chmod 600 /root/devlab-api-key.txt

# Docker should be preinstalled on the DL AMI; install if missing
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# NVIDIA container toolkit (idempotent)
if ! docker info 2>/dev/null | grep -qi nvidia; then
  distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg || true
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list || true
  apt-get update && apt-get install -y nvidia-container-toolkit || true
  nvidia-ctk runtime configure --runtime=docker || true
  systemctl restart docker
fi

# Fetch DevLab
mkdir -p "$DEVLAB_DIR" /srv/repos
if [ -n "$DEVLAB_REPO" ]; then
  git clone "$DEVLAB_REPO" "$DEVLAB_DIR" || (cd "$DEVLAB_DIR" && git pull)
else
  echo "WARNING: devlab_repo not set — copy the DevLab source to $DEVLAB_DIR manually, then rerun: cd $DEVLAB_DIR && docker compose up -d"
  exit 0
fi

# GPU-enabled compose override
cat > "$DEVLAB_DIR/docker-compose.override.yml" <<'EOF'
services:
  ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    ports:
      - "11434:11434"
EOF

cd "$DEVLAB_DIR"
DEVLAB_API_KEY="$API_KEY" \
DEVLAB_MODEL="$DEVLAB_MODEL" \
DEVLAB_PRIVACY=local \
WORKSPACE=/srv/repos \
docker compose up -d --build

echo "DevLab up. API key in /root/devlab-api-key.txt"

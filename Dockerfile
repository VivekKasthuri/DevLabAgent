# DevLab — self-host container (enterprise deployment)
# Build:  docker build -t devlab .
# Run:    docker compose up   (see docker-compose.yml — includes Ollama)
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

# Workspace repos are mounted at /workspace
VOLUME ["/workspace"]
ENV UI_PORT=4321 \
    MODEL_PROVIDER=ollama \
    OPENAI_COMPAT_BASE_URL=http://ollama:11434

EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:4321/ >/dev/null || exit 1
CMD ["node", "index.js", "ui", "/workspace"]

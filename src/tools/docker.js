// Docker integration — container management, image builds, sandboxed execution,
// Dockerfile/compose generation. Degrades gracefully when Docker isn't installed.
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';

function sh(args, { cwd, timeout = 60000 } = {}) {
  try {
    const out = execFileSync('docker', args, { cwd, timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: out.trim() };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || '').toString().trim().slice(0, 2000) };
  }
}

export function dockerStatus() {
  try { execSync('command -v docker', { stdio: 'ignore' }); } catch {
    return {
      installed: false,
      running: false,
      hint: 'Docker not installed. Install: Docker Desktop (docker.com), or lightweight alternatives: `brew install colima docker` then `colima start`.',
    };
  }
  const v = sh(['version', '--format', '{{.Server.Version}}']);
  if (!v.ok) return { installed: true, running: false, hint: 'Docker CLI found but daemon not running. Start Docker Desktop or `colima start`.' };
  const info = sh(['system', 'df', '--format', '{{.Type}}: {{.TotalCount}} ({{.Size}})']);
  return { installed: true, running: true, serverVersion: v.output, diskUsage: info.ok ? info.output.split('\n') : undefined };
}

function requireDocker() {
  const s = dockerStatus();
  if (!s.running) return s; // caller returns this as the result
  return null;
}

export function listContainers({ all = false } = {}) {
  const down = requireDocker(); if (down) return down;
  const r = sh(['ps', ...(all ? ['-a'] : []), '--format', '{{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}\t{{.Ports}}']);
  if (!r.ok) return { error: r.error };
  const containers = r.output ? r.output.split('\n').map(l => {
    const [id, image, status, name, ports] = l.split('\t');
    return { id, image, status, name, ports: ports || '' };
  }) : [];
  return { count: containers.length, containers };
}

export function listImages() {
  const down = requireDocker(); if (down) return down;
  const r = sh(['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.ID}}']);
  if (!r.ok) return { error: r.error };
  const images = r.output ? r.output.split('\n').map(l => {
    const [ref, size, id] = l.split('\t');
    return { ref, size, id };
  }) : [];
  return { count: images.length, images };
}

export function buildImage({ path: dir = '.', tag, dockerfile, buildArgs = {} } = {}) {
  const down = requireDocker(); if (down) return down;
  if (!tag) return { error: 'tag is required, e.g. myapp:latest' };
  const args = ['build', '-t', tag];
  if (dockerfile) args.push('-f', dockerfile);
  for (const [k, v] of Object.entries(buildArgs)) args.push('--build-arg', `${k}=${v}`);
  args.push('.');
  const r = sh(args, { cwd: path.resolve(dir), timeout: 600000 });
  if (!r.ok) return { built: false, error: r.error };
  return { built: true, tag, log: r.output.split('\n').slice(-15).join('\n') };
}

export function runContainer({ image, command, name, ports = [], env = {}, volumes = [], detach = true, rm = true, workdir } = {}) {
  const down = requireDocker(); if (down) return down;
  if (!image) return { error: 'image is required' };
  const args = ['run'];
  if (detach) args.push('-d');
  if (rm) args.push('--rm');
  if (name) args.push('--name', name);
  if (workdir) args.push('-w', workdir);
  for (const p of ports) args.push('-p', p);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const v of volumes) args.push('-v', v);
  args.push(image);
  if (command) args.push(...(Array.isArray(command) ? command : ['sh', '-c', command]));
  const r = sh(args, { timeout: detach ? 60000 : 300000 });
  if (!r.ok) return { started: false, error: r.error };
  return detach ? { started: true, containerId: r.output.slice(0, 12) } : { started: true, output: r.output.slice(0, 8000) };
}

// Sandboxed execution: run code/commands in a throwaway container with the project
// mounted read-only — safest way to execute untrusted or experimental code.
export function sandboxRun({ command, image, projectPath, network = false, timeout = 120000 } = {}) {
  const down = requireDocker(); if (down) return down;
  if (!command) return { error: 'command is required' };
  const img = image || 'node:20-alpine';
  const args = ['run', '--rm', '--memory', '512m', '--cpus', '1', '--pids-limit', '256'];
  if (!network) args.push('--network', 'none');
  if (projectPath) args.push('-v', `${path.resolve(projectPath)}:/workspace:ro`, '-w', '/workspace');
  args.push(img, 'sh', '-c', command);
  const r = sh(args, { timeout });
  return r.ok
    ? { ok: true, sandbox: { image: img, network, readonly: !!projectPath }, output: r.output.slice(0, 8000) }
    : { ok: false, error: r.error };
}

export function containerLogs({ container, tail = 100 } = {}) {
  const down = requireDocker(); if (down) return down;
  if (!container) return { error: 'container name or id required' };
  const r = sh(['logs', '--tail', String(tail), container]);
  return r.ok ? { logs: r.output.slice(0, 10000) } : { error: r.error };
}

export function stopContainer({ container } = {}) {
  const down = requireDocker(); if (down) return down;
  if (!container) return { error: 'container name or id required' };
  const r = sh(['stop', container], { timeout: 30000 });
  return r.ok ? { stopped: true, container } : { error: r.error };
}

export function composeAction({ path: dir = '.', action = 'up', service } = {}) {
  const down = requireDocker(); if (down) return down;
  const cwd = path.resolve(dir);
  const hasCompose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(f => fs.existsSync(path.join(cwd, f)));
  if (!hasCompose && action !== 'ps') return { error: 'No compose file found in ' + cwd };
  const map = {
    up: ['compose', 'up', '-d'],
    down: ['compose', 'down'],
    ps: ['compose', 'ps', '--format', 'table'],
    logs: ['compose', 'logs', '--tail', '50'],
    restart: ['compose', 'restart'],
  };
  const args = map[action];
  if (!args) return { error: `Unknown action: ${action}. Use up/down/ps/logs/restart` };
  if (service) args.push(service);
  const r = sh(args, { cwd, timeout: 300000 });
  return r.ok ? { action, ok: true, output: r.output.slice(0, 6000) } : { action, ok: false, error: r.error };
}

// ---------- Dockerfile / compose generation (no Docker required) ----------
function detectAppType(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return { type: 'nextjs', port: 3000, start: 'npm start' };
      if (deps.express || deps.fastify || deps.koa) return { type: 'node-server', port: 3000, start: pkg.scripts?.start ? 'npm start' : 'node index.js' };
      return { type: 'node', port: 3000, start: pkg.scripts?.start ? 'npm start' : 'node index.js' };
    } catch { return { type: 'node', port: 3000, start: 'npm start' }; }
  }
  if (has('requirements.txt') || has('pyproject.toml')) {
    const isDjango = has('manage.py');
    return { type: isDjango ? 'django' : 'python', port: 8000, start: isDjango ? 'python manage.py runserver 0.0.0.0:8000' : 'python main.py' };
  }
  if (has('go.mod')) return { type: 'go', port: 8080, start: './app' };
  if (has('pom.xml')) return { type: 'java-maven', port: 8080 };
  if (has('build.gradle') || has('build.gradle.kts')) return { type: 'java-gradle', port: 8080 };
  return { type: 'unknown', port: 8080 };
}

const DOCKERFILES = {
  node: (a) => `FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE ${a.port}
CMD ["sh", "-c", "${a.start}"]
`,
  python: (a) => `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd -m appuser
USER appuser
EXPOSE ${a.port}
CMD ["sh", "-c", "${a.start}"]
`,
  go: (a) => `FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app .

FROM alpine:3.20
RUN adduser -D appuser
USER appuser
COPY --from=build /app /app
EXPOSE ${a.port}
CMD ["/app"]
`,
  'java-maven': (a) => `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn dependency:go-offline -q
COPY src ./src
RUN mvn package -q -DskipTests

FROM eclipse-temurin:21-jre-alpine
COPY --from=build /src/target/*.jar /app.jar
EXPOSE ${a.port}
CMD ["java", "-jar", "/app.jar"]
`,
};
DOCKERFILES.nextjs = DOCKERFILES.node;
DOCKERFILES['node-server'] = DOCKERFILES.node;
DOCKERFILES.django = DOCKERFILES.python;
DOCKERFILES['java-gradle'] = DOCKERFILES['java-maven'];

export function generateDockerfile({ path: dir = '.', write = true, compose = false } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { error: `Path not found: ${root}` };
  const app = detectAppType(root);
  const template = DOCKERFILES[app.type];
  if (!template) return { error: `Unsupported project type '${app.type}' — supported: node, nextjs, python, django, go, java (maven/gradle)` };

  const dockerfile = template(app);
  const dockerignore = ['node_modules', '.git', '.env*', '*.log', 'dist', 'build', '__pycache__', '.devlab', 'coverage'].join('\n') + '\n';
  const name = path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const composeYml = `services:
  ${name}:
    build: .
    ports:
      - "${app.port}:${app.port}"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
`;

  const written = [];
  if (write) {
    const df = path.join(root, 'Dockerfile');
    if (fs.existsSync(df)) return { error: 'Dockerfile already exists — delete it first or use write:false to preview', preview: dockerfile };
    fs.writeFileSync(df, dockerfile); written.push(df);
    const di = path.join(root, '.dockerignore');
    if (!fs.existsSync(di)) { fs.writeFileSync(di, dockerignore); written.push(di); }
    if (compose) {
      const cf = path.join(root, 'docker-compose.yml');
      if (!fs.existsSync(cf)) { fs.writeFileSync(cf, composeYml); written.push(cf); }
    }
  }
  return {
    detected: app.type,
    port: app.port,
    written,
    ...(write ? {} : { dockerfile, dockerignore, ...(compose ? { compose: composeYml } : {}) }),
    next: `docker build -t ${name}:latest ${dir} && docker run --rm -p ${app.port}:${app.port} ${name}:latest`,
  };
}

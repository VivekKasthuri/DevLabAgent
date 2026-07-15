// src/tools/builder.js — universal build detection + verification for any language
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { runCommand } from './shell.js';
import { printTool } from '../ui.js';

// ── Detect every build system present in a project ───────────────────────────
export function detectBuildSystems(projectPath = '.') {
  const abs = resolve(projectPath);
  const systems = [];
  const has = (f) => existsSync(join(abs, f));
  const ls = (() => { try { return readdirSync(abs); } catch { return []; } })();

  // Xcode (Swift/ObjC — macOS/iOS)
  const xcworkspace = ls.find(f => f.endsWith('.xcworkspace'));
  const xcodeproj  = ls.find(f => f.endsWith('.xcodeproj'));
  if (xcworkspace || xcodeproj) {
    const container = xcworkspace ? `-workspace ${xcworkspace}` : `-project ${xcodeproj}`;
    const name = (xcworkspace || xcodeproj).replace(/\.(xcworkspace|xcodeproj)$/, '');
    systems.push({
      id: 'xcode', language: 'swift', ide: 'Xcode',
      command: `xcodebuild ${container} -scheme ${name} -configuration Debug build`,
      errorPattern: /error:/i,
    });
  }
  if (has('Package.swift')) {
    systems.push({ id: 'spm', language: 'swift', ide: 'Xcode', command: 'swift build', errorPattern: /error:/i });
  }

  // Android / Kotlin / Java via Gradle
  if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')) {
    const wrapper = has('gradlew') ? './gradlew' : 'gradle';
    const isAndroid = has('app/build.gradle') || has('app/build.gradle.kts') ||
      (has('build.gradle') && /com\.android/.test(readFileSync(join(abs, 'build.gradle'), 'utf8')));
    systems.push({
      id: 'gradle', language: isAndroid ? 'kotlin/android' : 'kotlin/java', ide: 'Android Studio',
      command: `${wrapper} ${isAndroid ? 'assembleDebug' : 'build'} -q`,
      errorPattern: /(^e:|error:|FAILURE)/im,
    });
  }
  if (has('pom.xml')) {
    systems.push({ id: 'maven', language: 'java', ide: 'IntelliJ', command: 'mvn -q compile', errorPattern: /\[ERROR\]/ });
  }

  // Flutter
  if (has('pubspec.yaml') && /^\s*flutter\s*:/m.test(readFileSync(join(abs, 'pubspec.yaml'), 'utf8'))) {
    systems.push({ id: 'flutter', language: 'dart', ide: 'VS Code / Android Studio', command: 'flutter analyze --no-pub', errorPattern: /error •|error -/i });
  }

  // Node / TypeScript / React Native
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['react-native']) {
        systems.push({ id: 'react-native', language: 'react-native', ide: 'VS Code', command: 'npx tsc --noEmit 2>/dev/null || node --check index.js', errorPattern: /error TS|SyntaxError/ });
      } else if (has('tsconfig.json')) {
        systems.push({ id: 'typescript', language: 'typescript', ide: 'VS Code', command: 'npx tsc --noEmit', errorPattern: /error TS/ });
      } else if (pkg.scripts?.build) {
        systems.push({ id: 'npm-build', language: 'javascript', ide: 'VS Code', command: 'npm run build --silent', errorPattern: /error/i });
      } else {
        systems.push({ id: 'node-check', language: 'javascript', ide: 'VS Code', command: `find . -maxdepth 3 -name "*.js" -not -path "*/node_modules/*" -exec node --check {} +`, errorPattern: /SyntaxError/ });
      }
    } catch {}
  }

  // .NET / C#
  const csproj = ls.find(f => f.endsWith('.csproj') || f.endsWith('.sln'));
  if (csproj) systems.push({ id: 'dotnet', language: 'csharp', ide: 'Visual Studio', command: 'dotnet build --nologo -v q', errorPattern: /error CS/ });

  // Rust / Go / Python / CMake / Make
  if (has('Cargo.toml')) systems.push({ id: 'cargo', language: 'rust', ide: 'VS Code', command: 'cargo check -q', errorPattern: /error(\[|:)/ });
  if (has('go.mod'))     systems.push({ id: 'go', language: 'go', ide: 'VS Code', command: 'go build ./...', errorPattern: /Error|cannot|undefined/ });
  if (ls.some(f => f.endsWith('.py')) || has('pyproject.toml') || has('requirements.txt')) {
    systems.push({ id: 'python', language: 'python', ide: 'VS Code', command: `python3 -m compileall -q . -x '(venv|\\.venv|node_modules)'`, errorPattern: /Error|error/ });
  }
  if (has('CMakeLists.txt')) systems.push({ id: 'cmake', language: 'c/c++', ide: 'CLion / VS Code', command: 'cmake -S . -B /tmp/cmake-build -DCMAKE_BUILD_TYPE=Debug > /dev/null && cmake --build /tmp/cmake-build', errorPattern: /error:/i });

  return { projectPath: abs, systems, detected: systems.length > 0 };
}

// ── Extract only error lines from noisy build output ────────────────────────
function extractErrors(output, pattern) {
  const lines = output.split('\n');
  const errs = [];
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      errs.push(lines.slice(Math.max(0, i - 1), i + 3).join('\n'));
      if (errs.length >= 15) break;
    }
  }
  return errs;
}

// ── Build the project and verify zero errors ────────────────────────────────
export async function buildProject(projectPath = '.', { system = 'auto', timeout = 300000 } = {}) {
  const { systems, projectPath: abs } = detectBuildSystems(projectPath);
  if (systems.length === 0) {
    return { success: false, error: 'No build system detected. Supported: Xcode, SwiftPM, Gradle/Android, Maven, Flutter, npm/TypeScript, React Native, .NET, Cargo, Go, Python, CMake.' };
  }

  const targets = system === 'auto' ? systems : systems.filter(s => s.id === system || s.language === system);
  if (targets.length === 0) {
    return { success: false, error: `Build system '${system}' not found. Available: ${systems.map(s => s.id).join(', ')}` };
  }

  const results = [];
  for (const t of targets) {
    printTool(`build:${t.id} → ${t.command.slice(0, 80)}`);
    const r = await runCommand(t.command, { cwd: abs, timeout });
    if (r.error) {
      results.push({ system: t.id, language: t.language, ide: t.ide, command: t.command, success: false, errors: [r.error], summary: `❌ ${t.id}: ${r.error}` });
      continue;
    }
    const output = `${r.stdout || ''}\n${r.stderr || ''}`;
    const errors = extractErrors(output, t.errorPattern);
    const ok = r.exitCode === 0 && errors.length === 0;
    results.push({
      system: t.id, language: t.language, ide: t.ide,
      command: t.command,
      success: ok,
      errors: ok ? [] : errors.slice(0, 10),
      summary: ok ? `✅ ${t.id} build succeeded — no errors` : `❌ ${t.id} build failed — ${errors.length || 'see'} error(s)`,
    });
  }

  const allOk = results.every(r => r.success);
  return {
    projectPath: abs,
    success: allOk,
    verdict: allOk ? 'BUILD SUCCEEDED — no errors in any IDE (Xcode / VS Code / Android Studio)' : 'BUILD FAILED — fix the errors below and rebuild',
    results,
  };
}

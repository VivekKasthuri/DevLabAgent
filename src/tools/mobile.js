// src/tools/mobile.js — Swift, Kotlin, React Native, Flutter support
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { resolve, join, extname, basename, dirname } from 'path';
import { tmpdir } from 'os';
import { runCommandSync, runCommand } from './shell.js';
import { listFiles, readFile, searchFiles } from './files.js';
import { printTool, printWarn, printSuccess, printError } from '../ui.js';

// ── Platform detection ─────────────────────────────────────────────────────────

/**
 * Returns: { platform, subtype, confidence, details }
 * platform: 'swift' | 'kotlin' | 'react-native' | 'flutter' | 'unknown'
 */
export function detectMobilePlatform(projectPath = '.') {
  const abs = resolve(projectPath);

  // Flutter — check pubspec.yaml first (before RN, since RN may also have dart)
  const pubspec = join(abs, 'pubspec.yaml');
  if (existsSync(pubspec)) {
    const content = readFileSync(pubspec, 'utf8');
    if (/^\s*flutter\s*:/m.test(content)) {
      const name = content.match(/^name:\s*(.+)/m)?.[1]?.trim() || 'unknown';
      const version = content.match(/^version:\s*(.+)/m)?.[1]?.trim();
      const hasDartDir = existsSync(join(abs, 'lib'));
      return { platform: 'flutter', confidence: 'high', name, version, hasDartDir, pubspecPath: pubspec };
    }
  }

  // React Native — package.json with react-native dep + ios/ AND android/
  const pkgPath = join(abs, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['react-native']) {
        const hasIOS     = existsSync(join(abs, 'ios'));
        const hasAndroid = existsSync(join(abs, 'android'));
        const isExpo     = !!deps['expo'];
        return {
          platform: 'react-native',
          confidence: 'high',
          version: deps['react-native'],
          isExpo,
          hasIOS,
          hasAndroid,
          name: pkg.name,
        };
      }
    } catch {}
  }

  // Swift — Package.swift OR .xcodeproj / .xcworkspace
  const hasPackageSwift = existsSync(join(abs, 'Package.swift'));
  const xcodeProjEntries = tryReadDir(abs).filter(e => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'));
  const hasSwiftFiles = tryReadDir(join(abs, 'Sources')).some(e => e.endsWith('.swift')) ||
                        tryReadDir(abs).some(e => e.endsWith('.swift'));

  if (hasPackageSwift || xcodeProjEntries.length > 0) {
    const subtype = hasPackageSwift ? 'spm' : 'xcode';
    const isIOS = xcodeProjEntries.length > 0 && (
      existsSync(join(abs, 'ios')) || checkPlist(abs, /iPhone|iPad|iOS/i)
    );
    return {
      platform: 'swift',
      confidence: 'high',
      subtype,
      isSPM: subtype === 'spm',
      isXcode: subtype === 'xcode',
      isIOS,
      isMacOS: !isIOS,
      xcodeProjEntries,
      packageSwiftPath: hasPackageSwift ? join(abs, 'Package.swift') : null,
    };
  }

  // Kotlin/Android — build.gradle(.kts) + AndroidManifest.xml OR .kt files
  const hasGradle    = existsSync(join(abs, 'build.gradle')) || existsSync(join(abs, 'build.gradle.kts'));
  const hasGradlew   = existsSync(join(abs, 'gradlew'));
  const hasManifest  = existsSync(join(abs, 'app', 'src', 'main', 'AndroidManifest.xml')) ||
                       existsSync(join(abs, 'src', 'main', 'AndroidManifest.xml'));
  const hasKotlinDir = existsSync(join(abs, 'app', 'src', 'main', 'java')) ||
                       existsSync(join(abs, 'src', 'main', 'kotlin'));

  if (hasGradle || hasManifest || hasKotlinDir) {
    const isMultiModule = tryReadDir(abs).some(e =>
      existsSync(join(abs, e, 'build.gradle')) || existsSync(join(abs, e, 'build.gradle.kts'))
    );
    return {
      platform: 'kotlin',
      confidence: hasGradle && hasManifest ? 'high' : 'medium',
      isAndroid: hasManifest,
      isMultiModule,
      hasGradlew,
      gradleFile: existsSync(join(abs, 'build.gradle.kts')) ? 'build.gradle.kts' : 'build.gradle',
    };
  }

  return { platform: 'unknown', confidence: 'low' };
}

// ── Design handoff detection ─────────────────────────────────────────────────

export async function detectDesignAssets(projectPath = '.') {
  const abs = resolve(projectPath);
  const sketchFiles = await listFiles(abs, '**/*.sketch', { maxResults: 50 });
  const figmaJsonFiles = await listFiles(abs, '**/*figma*.json', { maxResults: 50 });
  const figmaExportFiles = await listFiles(abs, '**/*.{fig,figma}', { maxResults: 50 });
  const imageFiles = await listFiles(abs, '**/*.{png,jpg,jpeg,svg,pdf}', { maxResults: 100 });

  const assets = [];
  const sources = new Set();

  for (const file of (sketchFiles.files || []).slice(0, 10)) {
    const metadata = summarizeSketchArchive(join(abs, file.path));
    if (metadata) {
      assets.push({ type: 'sketch', file: file.path, ...metadata });
      sources.add('sketch');
    }
  }

  for (const file of (figmaJsonFiles.files || []).slice(0, 10)) {
    const metadata = summarizeFigmaJson(join(abs, file.path));
    if (metadata) {
      assets.push({ type: 'figma-json', file: file.path, ...metadata });
      sources.add('figma');
    }
  }

  for (const file of (figmaExportFiles.files || []).slice(0, 10)) {
    assets.push({ type: extname(file.path).slice(1).toLowerCase(), file: file.path });
    sources.add('figma');
  }

  const designFiles = [...(sketchFiles.files || []), ...(figmaJsonFiles.files || []), ...(figmaExportFiles.files || [])].length;
  const hasDesignHandoff = designFiles > 0;

  return {
    projectPath: abs,
    hasDesignHandoff,
    designSources: [...sources],
    sketchFiles: sketchFiles.count,
    figmaFiles: figmaJsonFiles.count + figmaExportFiles.count,
    imageFiles: imageFiles.count,
    assets,
    summary: summarizeDesignAssets(assets),
    recommendedWorkflow: hasDesignHandoff
      ? [
          'Inspect the design source first',
          'List screens, states, and shared components',
          'Map design tokens to theme primitives',
          'Implement responsive layouts for the target mobile platform',
          'Write or update UI tests/snapshots for the new screens',
        ]
      : [],
  };
}

export async function generateMobileUIFromDesign(designSource, platform, { outputDir = 'generated-ui', write = false } = {}) {
  const targetPlatform = normalizeTargetPlatform(platform);
  if (!targetPlatform || targetPlatform === 'unknown') {
    return { error: `Unsupported platform: ${platform}` };
  }

  const { tempDir, summary, sourceKind, sourcePath, sourceUrl } = await loadDesignSummary(designSource);
  try {
    const screens = buildDesignScreenList(summary);
    const files = [];
    const resolvedOutputDir = resolve(outputDir);
    const designLabel = summary?.pages?.[0] || summary?.frames?.[0] || summary?.artboards?.[0] || 'DesignScreen';
    const safeBase = toPascalCase(designLabel) || 'DesignScreen';
    const targetScreens = screens.length ? screens : [{ name: safeBase, label: designLabel }];

    for (const screen of targetScreens.slice(0, 3)) {
      const file = renderPlatformUIScreen(targetPlatform, screen, summary, {
        sourceUrl,
        sourceKind,
        sourcePath,
      });
      const outPath = join(resolvedOutputDir, file.fileName);
      if (write) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, file.content, 'utf8');
      }
      files.push({ path: outPath, fileName: file.fileName, preview: file.content.slice(0, 4000) });
    }

    const manifest = {
      designSource: sourceUrl || sourcePath || designSource,
      sourceKind,
      platform: targetPlatform,
      screens: targetScreens.slice(0, 3),
      summary: {
        pages: summary?.pages || [],
        frames: summary?.frames || [],
        components: summary?.components || [],
        artboards: summary?.artboards || [],
      },
      files,
      outputDir: resolvedOutputDir,
      written: write,
    };

    if (write) {
      mkdirSync(resolvedOutputDir, { recursive: true });
      writeFileSync(join(resolvedOutputDir, 'mobile-ui.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    }

    return manifest;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function normalizeTargetPlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (['swift', 'ios', 'macos', 'swiftui'].includes(value)) return 'swift';
  if (['kotlin', 'android', 'compose'].includes(value)) return 'kotlin';
  if (['react-native', 'reactnative', 'rn'].includes(value)) return 'react-native';
  if (['flutter', 'dart'].includes(value)) return 'flutter';
  return value;
}

function toPascalCase(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1).replace(/[^A-Za-z0-9]/g, ''))
    .join('');
}

function toSnakeCase(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function buildDesignScreenList(summary) {
  const names = [
    ...(summary?.pages || []),
    ...(summary?.frames || []),
    ...(summary?.artboards || []),
  ]
    .filter(Boolean)
    .map(name => String(name).trim())
    .filter(Boolean);
  const unique = [...new Set(names)];
  return unique.slice(0, 3).map(name => ({ name: toPascalCase(name) || 'DesignScreen', label: name }));
}

function renderPlatformUIScreen(platform, screen, summary, meta = {}) {
  const title = screen.label || screen.name;
  const components = (summary?.components || []).slice(0, 4);
  const sourceLine = meta.sourceUrl ? `// Source: ${meta.sourceUrl}` : meta.sourcePath ? `// Source: ${meta.sourcePath}` : '// Source: design input';

  if (platform === 'swift') {
    return {
      fileName: `${screen.name}View.swift`,
      content: `import SwiftUI

${sourceLine}

struct ${screen.name}View: View {
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("${escapeSwiftString(title)}")
          .font(.largeTitle.bold())
        Text("Build this screen from the supplied design. Replace placeholders with native SwiftUI components.")
          .font(.body)
          .foregroundStyle(.secondary)

        VStack(alignment: .leading, spacing: 12) {
          Text("Design components")
            .font(.headline)
          ${components.length ? components.map(component => `Text("• ${escapeSwiftString(component)}")`).join('\n          ') : 'Text("• Add design components here")'}
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding()
    }
  }
}

#Preview {
  ${screen.name}View()
}
`,
    };
  }

  if (platform === 'kotlin') {
    return {
      fileName: `${screen.name}Screen.kt`,
      content: `package ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

${sourceLine}

@Composable
fun ${screen.name}Screen(
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(text = "${escapeKotlinString(title)}", style = MaterialTheme.typography.headlineLarge)
            Text(
                text = "Build this screen from the supplied design. Replace placeholders with Compose components.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(text = "Design components", style = MaterialTheme.typography.titleMedium)
${components.length ? components.map(component => `            Text(text = "• ${escapeKotlinString(component)}")`).join('\n') : '            Text(text = "• Add design components here")'}
        }
    }
}
`,
    };
  }

  if (platform === 'react-native') {
    return {
      fileName: `${screen.name}Screen.tsx`,
      content: `import React from 'react';
import { SafeAreaView, ScrollView, Text, View, StyleSheet } from 'react-native';

${sourceLine}

export function ${screen.name}Screen() {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>${escapeJsString(title)}</Text>
        <Text style={styles.body}>
          Build this screen from the supplied design. Replace placeholders with native React Native components.
        </Text>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Design components</Text>
${components.length ? components.map(component => `          <Text style={styles.item}>• ${escapeJsString(component)}</Text>`).join('\n') : '          <Text style={styles.item}>• Add design components here</Text>'}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 32, fontWeight: '700' },
  body: { fontSize: 16, color: '#667085', lineHeight: 22 },
  card: { gap: 12, padding: 16, borderRadius: 16, backgroundColor: '#F2F4F7' },
  sectionTitle: { fontSize: 18, fontWeight: '600' },
  item: { fontSize: 14, color: '#344054' },
});
`,
    };
  }

  if (platform === 'flutter') {
    return {
      fileName: `${toSnakeCase(screen.name)}_screen.dart`,
      content: `import 'package:flutter/material.dart';

${sourceLine}

class ${screen.name}Screen extends StatelessWidget {
  const ${screen.name}Screen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${escapeDartString(title)}',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 12),
              Text(
                'Build this screen from the supplied design. Replace placeholders with Flutter widgets.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 24),
              Text(
                'Design components',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 12),
${components.length ? components.map(component => `              Text('• ${escapeDartString(component)}')`).join('\n') : "              Text('• Add design components here')"}
            ],
          ),
        ),
      ),
    );
  }
}
`,
    };
  }

  return { error: `Unsupported platform: ${platform}` };
}

async function loadDesignSummary(designSource) {
  const tempDir = mkdtempSync(join(tmpdir(), 'codeagent-design-'));
  const source = String(designSource || '').trim();
  if (!source) {
    return { tempDir, summary: {}, sourceKind: 'unknown', sourcePath: null, sourceUrl: null };
  }

  if (existsSync(source)) {
    const abs = resolve(source);
    if (source.toLowerCase().endsWith('.sketch')) {
      return { tempDir, summary: summarizeSketchArchive(abs) || {}, sourceKind: 'sketch', sourcePath: abs, sourceUrl: null };
    }
    if (source.toLowerCase().endsWith('.json')) {
      return { tempDir, summary: summarizeFigmaJson(abs) || {}, sourceKind: 'json', sourcePath: abs, sourceUrl: null };
    }
    const detected = await detectDesignAssets(abs);
    return { tempDir, summary: detected.summary || summarizeDesignAssets(detected.assets || []), sourceKind: 'local', sourcePath: abs, sourceUrl: null };
  }

  const parsed = tryParseUrl(source);
  if (!parsed) {
    return { tempDir, summary: {}, sourceKind: 'unknown', sourcePath: null, sourceUrl: source };
  }

  if (/figma\.com$/i.test(parsed.hostname) || /figma\.com$/i.test(parsed.hostname.replace(/^www\./i, ''))) {
    const fileKey = extractFigmaFileKey(source);
    const token = process.env.FIGMA_API_TOKEN;
    if (!fileKey) throw new Error('Could not extract a Figma file key from the URL.');
    if (!token) throw new Error('FIGMA_API_TOKEN is required to read Figma URLs.');
    const response = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!response.ok) {
      throw new Error(`Figma API request failed (${response.status}): ${await response.text()}`);
    }
    const json = await response.json();
    const localPath = join(tempDir, 'figma.json');
    writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf8');
    return { tempDir, summary: summarizeFigmaJson(localPath) || {}, sourceKind: 'figma', sourcePath: localPath, sourceUrl: source };
  }

  if (/\.sketch([?#].*)?$/i.test(parsed.pathname) || /sketch/i.test(parsed.hostname) || /sketch/i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Sketch download failed (${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const localPath = join(tempDir, 'design.sketch');
    writeFileSync(localPath, buffer);
    return { tempDir, summary: summarizeSketchArchive(localPath) || {}, sourceKind: 'sketch', sourcePath: localPath, sourceUrl: source };
  }

  if (/\.json([?#].*)?$/i.test(parsed.pathname)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Design JSON download failed (${response.status})`);
    }
    const text = await response.text();
    const localPath = join(tempDir, 'design.json');
    writeFileSync(localPath, text, 'utf8');
    return { tempDir, summary: summarizeFigmaJson(localPath) || {}, sourceKind: 'json', sourcePath: localPath, sourceUrl: source };
  }

  return { tempDir, summary: {}, sourceKind: 'unknown', sourcePath: null, sourceUrl: source };
}

function tryParseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function extractFigmaFileKey(url) {
  const match = String(url).match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/i);
  return match?.[1] || null;
}

function escapeSwiftString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeKotlinString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeJsString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeDartString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function summarizeDesignAssets(assets = []) {
  const pages = [];
  const frames = [];
  const components = [];
  const artboards = [];

  for (const asset of assets) {
    for (const page of asset.pages || []) pages.push(page);
    for (const frame of asset.frames || []) frames.push(frame);
    for (const component of asset.components || []) components.push(component);
    for (const artboard of asset.artboards || []) artboards.push(artboard);
  }

  return {
    pages: [...new Set(pages)].slice(0, 20),
    frames: [...new Set(frames)].slice(0, 20),
    components: [...new Set(components)].slice(0, 20),
    artboards: [...new Set(artboards)].slice(0, 20),
  };
}

function summarizeFigmaJson(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const pages = [];
    const components = [];
    const frames = [];

    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object') return;
      const type = String(node.type || '').toUpperCase();
      const name = node.name || node.title || node.id;
      if (type === 'FRAME' || type === 'SECTION' || type === 'PAGE') {
        if (name && frames.length < 20) frames.push(name);
      }
      if (type === 'COMPONENT' || type === 'COMPONENT_SET' || type === 'INSTANCE') {
        if (name && components.length < 20) components.push(name);
      }
      if (type === 'PAGE' && name && pages.length < 20) pages.push(name);
      for (const child of node.children || []) walk(child, depth + 1);
    };

    walk(parsed.document || parsed);

    return {
      pages: [...new Set(pages)].slice(0, 20),
      frames: [...new Set(frames)].slice(0, 20),
      components: [...new Set(components)].slice(0, 20),
      schemaVersion: parsed.schemaVersion,
    };
  } catch {
    return null;
  }
}

function summarizeSketchArchive(filePath) {
  try {
    const list = runCommandSync(`unzip -l ${JSON.stringify(filePath)} | head -50`);
    const manifest = runCommandSync(`unzip -p ${JSON.stringify(filePath)} document.json 2>/dev/null | head -c 50000`);
    const document = manifest.success && manifest.stdout ? JSON.parse(manifest.stdout) : null;
    const pages = [];
    const artboards = [];

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      const name = node.name || node.do_objectID || node.id;
      const className = node._class || node.class;
      if (className === 'page' && name && pages.length < 20) pages.push(name);
      if ((className === 'artboard' || className === 'symbolMaster') && name && artboards.length < 20) artboards.push(name);
      for (const child of node.layers || node.children || []) walk(child);
    };

    walk(document);

    return {
      pages: [...new Set(pages)].slice(0, 20),
      artboards: [...new Set(artboards)].slice(0, 20),
      archiveListing: list.success ? list.stdout.split('\n').slice(0, 12) : [],
    };
  } catch {
    return null;
  }
}

function tryReadDir(p) {
  try { return readdirSync(p); } catch { return []; }
}

function checkPlist(abs, pattern) {
  try {
    const infoPlist = join(abs, 'Info.plist');
    if (existsSync(infoPlist)) return pattern.test(readFileSync(infoPlist, 'utf8'));
  } catch {}
  return false;
}

// ── Run tests ─────────────────────────────────────────────────────────────────

export async function runMobileTests(projectPath = '.', platform) {
  const abs = resolve(projectPath);
  const p = platform || detectMobilePlatform(abs).platform;
  printTool(`Running tests [${p}]: ${abs}`);

  switch (p) {
    case 'swift': {
      const hasPkg = existsSync(join(abs, 'Package.swift'));
      if (hasPkg) {
        return runCommand('swift test 2>&1 | tail -50', { cwd: abs, timeout: 120000 });
      }
      // Xcode — try xcodebuild
      const scheme = await detectXcodeScheme(abs);
      const cmd = scheme
        ? `xcodebuild test -scheme "${scheme}" -destination "platform=macOS" 2>&1 | grep -E "error:|warning:|PASSED|FAILED|Test Suite" | tail -30`
        : 'echo "No scheme found — run tests manually in Xcode"';
      return runCommand(cmd, { cwd: abs, timeout: 300000 });
    }

    case 'kotlin': {
      const gradlew = existsSync(join(abs, 'gradlew')) ? './gradlew' : 'gradle';
      return runCommand(`${gradlew} test 2>&1 | tail -40`, { cwd: abs, timeout: 180000 });
    }

    case 'react-native': {
      return runCommand('npx jest --passWithNoTests --forceExit 2>&1 | tail -40', { cwd: abs, timeout: 120000 });
    }

    case 'flutter': {
      return runCommand('flutter test 2>&1 | tail -40', { cwd: abs, timeout: 120000 });
    }

    default:
      return { error: `Unknown platform: ${p}` };
  }
}

// ── Lint ──────────────────────────────────────────────────────────────────────

export async function runMobileLint(projectPath = '.', platform) {
  const abs = resolve(projectPath);
  const p = platform || detectMobilePlatform(abs).platform;
  printTool(`Linting [${p}]: ${abs}`);

  switch (p) {
    case 'swift': {
      const hasSwiftLint = await commandExists('swiftlint');
      if (hasSwiftLint) {
        return runCommand('swiftlint lint --quiet 2>&1 | head -50', { cwd: abs, timeout: 60000 });
      }
      // Fallback: swift build for compile errors
      const hasPkg = existsSync(join(abs, 'Package.swift'));
      if (hasPkg) return runCommand('swift build 2>&1 | grep -E "error:|warning:" | head -30', { cwd: abs, timeout: 120000 });
      return { note: 'Install SwiftLint: brew install swiftlint', skipped: true };
    }

    case 'kotlin': {
      const gradlew = existsSync(join(abs, 'gradlew')) ? './gradlew' : 'gradle';
      // Try Android lint first, then ktlint
      const hasKtlint = await commandExists('ktlint');
      if (hasKtlint) {
        return runCommand('ktlint --format 2>&1 | head -50', { cwd: abs, timeout: 60000 });
      }
      return runCommand(`${gradlew} lint 2>&1 | grep -E "error|warning" | head -40`, { cwd: abs, timeout: 180000 });
    }

    case 'react-native': {
      const hasESLint = existsSync(join(abs, 'node_modules', '.bin', 'eslint')) ||
                        existsSync(join(abs, '.eslintrc.js')) || existsSync(join(abs, '.eslintrc.json'));
      if (hasESLint) {
        return runCommand('npx eslint . --ext .js,.jsx,.ts,.tsx --max-warnings=0 2>&1 | head -50', { cwd: abs, timeout: 60000 });
      }
      return runCommand('npx @react-native-community/eslint-config 2>/dev/null || echo "No ESLint config found"', { cwd: abs });
    }

    case 'flutter': {
      return runCommand('flutter analyze 2>&1 | tail -40', { cwd: abs, timeout: 120000 });
    }

    default:
      return { error: `Unknown platform: ${p}` };
  }
}

// ── Build ─────────────────────────────────────────────────────────────────────

export async function buildMobileProject(projectPath = '.', platform, { release = false } = {}) {
  const abs = resolve(projectPath);
  const p = platform || detectMobilePlatform(abs).platform;
  printTool(`Building [${p}]${release ? ' (release)' : ''}: ${abs}`);

  switch (p) {
    case 'swift': {
      const hasPkg = existsSync(join(abs, 'Package.swift'));
      const config = release ? '--configuration release' : '--configuration debug';
      if (hasPkg) return runCommand(`swift build ${config} 2>&1 | tail -30`, { cwd: abs, timeout: 300000 });
      return runCommand('xcodebuild build 2>&1 | grep -E "error:|warning:|BUILD" | tail -20', { cwd: abs, timeout: 300000 });
    }

    case 'kotlin': {
      const gradlew = existsSync(join(abs, 'gradlew')) ? './gradlew' : 'gradle';
      const task = release ? 'assembleRelease' : 'assembleDebug';
      return runCommand(`${gradlew} ${task} 2>&1 | tail -30`, { cwd: abs, timeout: 300000 });
    }

    case 'react-native': {
      // Just verify bundling works (full native build needs Xcode/Android Studio)
      return runCommand('npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output /tmp/rn-test-bundle.js 2>&1 | tail -20', { cwd: abs, timeout: 180000 });
    }

    case 'flutter': {
      const target = release ? 'release' : 'debug';
      return runCommand(`flutter build apk --${target} 2>&1 | tail -30`, { cwd: abs, timeout: 300000 });
    }

    default:
      return { error: `Unknown platform: ${p}` };
  }
}

// ── Project analysis ──────────────────────────────────────────────────────────

export async function analyzeMobileProject(projectPath = '.') {
  const abs = resolve(projectPath);
  const detected = detectMobilePlatform(abs);
  const { platform } = detected;
  printTool(`Analyzing mobile project [${platform}]: ${abs}`);

  const info = { platform, ...detected, projectPath: abs };

  switch (platform) {
    case 'swift': {
      // Package.swift or Xcode project
      if (detected.packageSwiftPath) {
        info.packageSwift = readFileSync(detected.packageSwiftPath, 'utf8');
      }
      // Find all Swift files
      const swiftFiles = await listFiles(abs, '**/*.swift', { maxResults: 200 });
      info.swiftFiles = swiftFiles.count;
      info.testFiles = (swiftFiles.files || []).filter(f => f.path.includes('Test') || f.path.includes('Spec')).length;
      // Info.plist
      const plistSearch = await searchFiles('CFBundleShortVersionString', { path: abs, filePattern: '**/*.plist', maxResults: 1 });
      if (plistSearch.matches[0]) info.infoPlistPath = plistSearch.matches[0].file;
      break;
    }

    case 'kotlin': {
      const ktFiles = await listFiles(abs, '**/*.kt', { maxResults: 500 });
      info.kotlinFiles = ktFiles.count;
      info.testFiles = (ktFiles.files || []).filter(f => f.path.includes('Test') || f.path.includes('test')).length;
      // AndroidManifest
      const manifestPath = join(abs, 'app', 'src', 'main', 'AndroidManifest.xml');
      if (existsSync(manifestPath)) {
        const manifest = readFileSync(manifestPath, 'utf8');
        info.packageName = manifest.match(/package="([^"]+)"/)?.[1];
        info.exportedActivities = (manifest.match(/android:exported="true"/g) || []).length;
        info.usesPermissions = (manifest.match(/<uses-permission[^>]+>/g) || []).map(p => p.match(/android:name="([^"]+)"/)?.[1]).filter(Boolean);
        info.internetPermission = info.usesPermissions?.includes('android.permission.INTERNET');
      }
      // Gradle dependencies
      const gradleFile = join(abs, 'app', 'build.gradle.kts') || join(abs, 'app', 'build.gradle');
      if (existsSync(gradleFile)) {
        info.gradleContent = readFileSync(gradleFile, 'utf8').slice(0, 3000);
      }
      break;
    }

    case 'react-native': {
      const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
      info.dependencies = Object.keys(pkg.dependencies || {});
      info.rnVersion = pkg.dependencies?.['react-native'];
      info.jsFiles = (await listFiles(abs, '**/*.{js,jsx,ts,tsx}', { maxResults: 300 })).count;
      info.testFiles = (await listFiles(abs, '**/__tests__/**/*.{js,ts}', { maxResults: 100 })).count;
      info.hasDetox = !!pkg.devDependencies?.detox;
      info.hasCodePush = !!pkg.dependencies?.['react-native-code-push'];
      info.nativeModules = info.dependencies.filter(d => d.startsWith('react-native-'));
      break;
    }

    case 'flutter': {
      const pubspec = readFileSync(join(abs, 'pubspec.yaml'), 'utf8');
      info.dartFiles = (await listFiles(abs, '**/*.dart', { maxResults: 500 })).count;
      info.testFiles = (await listFiles(abs, 'test/**/*.dart', { maxResults: 100 })).count;
      // Parse dependencies from pubspec.yaml
      const depsMatch = pubspec.match(/^dependencies:\n([\s\S]*?)(?=^\w|\z)/m);
      info.dependencies = depsMatch?.[1]?.split('\n').map(l => l.trim().split(':')[0]).filter(d => d && !d.startsWith('#')) || [];
      info.sdkConstraint = pubspec.match(/sdk:\s*["']?([^"'\n]+)/)?.[1];
      break;
    }
  }

  const design = await detectDesignAssets(abs);
  if (design.hasDesignHandoff) info.designAssets = design;

  return info;
}

// ── Security scanning (OWASP Mobile Top 10) ──────────────────────────────────

const MOBILE_SEC_PATTERNS = {
  swift: [
    { id: 'SW01', sev: 'CRITICAL', name: 'Hardcoded Secret', re: /(?:apiKey|secret|token|password)\s*=\s*"[A-Za-z0-9+\/=_\-]{8,}"/gi },
    { id: 'SW02', sev: 'HIGH',     name: 'Insecure UserDefaults (sensitive data)', re: /UserDefaults\.standard\.set\([^,]+,\s*forKey:\s*"(?:password|token|secret|key|auth)/gi },
    { id: 'SW03', sev: 'HIGH',     name: 'Disabled ATS (allowsArbitraryLoads)', re: /NSAllowsArbitraryLoads.*true|allowsArbitraryLoads.*true/gi },
    { id: 'SW04', sev: 'MEDIUM',   name: 'Weak Keychain accessibility (kSecAttrAccessibleAlways)', re: /kSecAttrAccessibleAlways[^W]/g },
    { id: 'SW05', sev: 'HIGH',     name: 'URL scheme open without validation', re: /application\(_:open:options:\)|openURL/g },
    { id: 'SW06', sev: 'MEDIUM',   name: 'print() with sensitive data', re: /print\([^)]*(?:password|token|secret|key)[^)]*\)/gi },
    { id: 'SW07', sev: 'MEDIUM',   name: 'Deprecated MD5/SHA1', re: /CC_MD5|CC_SHA1|Insecure\.MD5|\.sha1/g },
    { id: 'SW08', sev: 'HIGH',     name: 'Jailbreak detection bypass risk (dylib)', re: /dlopen|dyld_shared_cache/g },
    { id: 'SW09', sev: 'MEDIUM',   name: 'Logging sensitive response', re: /print\(response\)|NSLog.*response/gi },
    { id: 'SW10', sev: 'HIGH',     name: 'Disabled certificate pinning / TLS bypass', re: /URLSession\.shared\.delegate\s*=\s*nil|serverTrust\s*=\s*nil|evaluateServerTrust/g },
  ],
  kotlin: [
    { id: 'KT01', sev: 'CRITICAL', name: 'Hardcoded API Key/Secret', re: /(?:apiKey|secret|token|password|API_KEY)\s*[=:]\s*"[A-Za-z0-9+\/=_\-]{8,}"/gi },
    { id: 'KT02', sev: 'HIGH',     name: 'SharedPreferences for sensitive data', re: /sharedPreferences.*(?:password|token|secret)|putString\("(?:pass|token|secret|key)/gi },
    { id: 'KT03', sev: 'HIGH',     name: 'SQL Injection in rawQuery', re: /rawQuery\s*\([^,]*\+/g },
    { id: 'KT04', sev: 'HIGH',     name: 'android:debuggable=true in release', re: /android:debuggable="true"/g },
    { id: 'KT05', sev: 'HIGH',     name: 'android:allowBackup=true', re: /android:allowBackup="true"/g },
    { id: 'KT06', sev: 'MEDIUM',   name: 'Exported Activity without permission', re: /android:exported="true"(?![\s\S]*?android:permission)/g },
    { id: 'KT07', sev: 'MEDIUM',   name: 'Insecure HTTP (cleartext)', re: /http:\/\/(?!localhost|127\.0\.0\.1|10\.0)/g },
    { id: 'KT08', sev: 'MEDIUM',   name: 'Log.d/Log.e with sensitive data', re: /Log\.[deiw]\s*\([^,]+,\s*[^)]*(?:password|token|secret)/gi },
    { id: 'KT09', sev: 'HIGH',     name: 'WebView.setJavaScriptEnabled (XSS)', re: /setJavaScriptEnabled\s*\(\s*true\s*\)/g },
    { id: 'KT10', sev: 'MEDIUM',   name: 'Weak random (java.util.Random)', re: /java\.util\.Random\(\)|Random\(\)(?!.*SecureRandom)/g },
  ],
  'react-native': [
    { id: 'RN01', sev: 'CRITICAL', name: 'Hardcoded Secret/API Key', re: /(?:apiKey|secret|token|password|API_KEY)\s*[:=]\s*['"`][A-Za-z0-9+\/=_\-]{8,}['"`]/gi },
    { id: 'RN02', sev: 'HIGH',     name: 'AsyncStorage for sensitive data', re: /AsyncStorage\.setItem\s*\(\s*['"`][^'"`]*(?:password|token|secret|key)/gi },
    { id: 'RN03', sev: 'HIGH',     name: 'Insecure HTTP URL', re: /http:\/\/(?!localhost|127\.0\.0\.1)/g },
    { id: 'RN04', sev: 'HIGH',     name: 'Disabled SSL pinning / cert validation', re: /NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized:\s*false/g },
    { id: 'RN05', sev: 'MEDIUM',   name: 'console.log with sensitive data', re: /console\.(log|warn|error)\s*\([^)]*(?:password|token|secret|key)[^)]*\)/gi },
    { id: 'RN06', sev: 'MEDIUM',   name: 'Deep link without validation', re: /Linking\.addEventListener|getInitialURL/g },
    { id: 'RN07', sev: 'HIGH',     name: 'eval() in JS bundle', re: /\beval\s*\(/g },
    { id: 'RN08', sev: 'MEDIUM',   name: 'Expo secret in app.json/app.config.js', re: /secrets?|apiKey|token/gi },
    { id: 'RN09', sev: 'HIGH',     name: 'Unvalidated navigation deep link', re: /navigation\.navigate\s*\([^)]*params\b/g },
    { id: 'RN10', sev: 'MEDIUM',   name: 'Insecure WebView (allowUniversalAccessFromFileURLs)', re: /allowUniversalAccessFromFileURLs|allowFileAccess/g },
  ],
  flutter: [
    { id: 'FL01', sev: 'CRITICAL', name: 'Hardcoded Secret/API Key', re: /(?:apiKey|secret|token|password|API_KEY)\s*=\s*['"]?[A-Za-z0-9+\/=_\-]{8,}['"]?/gi },
    { id: 'FL02', sev: 'HIGH',     name: 'SharedPreferences for sensitive data', re: /SharedPreferences.*(?:setString|set)\s*\([^)]*(?:password|token|secret|key)/gi },
    { id: 'FL03', sev: 'HIGH',     name: 'Insecure HTTP (no HTTPS)', re: /http:\/\/(?!localhost|127\.0\.0\.1)/g },
    { id: 'FL04', sev: 'HIGH',     name: 'Disabled certificate verification', re: /badCertificateCallback.*true|onBadCertificate.*return\s+true/g },
    { id: 'FL05', sev: 'MEDIUM',   name: 'print() with sensitive data', re: /print\([^)]*(?:password|token|secret|key)[^)]*\)/gi },
    { id: 'FL06', sev: 'MEDIUM',   name: 'Weak random (dart:math Random)', re: /math\.Random\(\)(?!.*secure)/g },
    { id: 'FL07', sev: 'HIGH',     name: 'SQL Injection in rawQuery (sqflite)', re: /rawQuery\s*\([^,]*\+|rawInsert\s*\([^,]*\+/g },
    { id: 'FL08', sev: 'MEDIUM',   name: 'debugPrint in production', re: /debugPrint\s*\(/g },
    { id: 'FL09', sev: 'HIGH',     name: 'Jailbreak/Root bypass risk', re: /Platform\.isAndroid.*root|jailbreak/gi },
    { id: 'FL10', sev: 'MEDIUM',   name: 'Insecure deep link handling', re: /uni_links|app_links|getInitialUri/g },
  ],
};

export async function scanMobileSecurity(projectPath = '.', platform) {
  const abs = resolve(projectPath);
  const p = platform || detectMobilePlatform(abs).platform;
  if (p === 'unknown') return { error: 'Could not detect mobile platform' };

  printTool(`Mobile security scan [${p}]: ${abs}`);

  const patterns = MOBILE_SEC_PATTERNS[p] || [];
  const extMap = { swift: '**/*.swift', kotlin: '**/*.{kt,xml}', 'react-native': '**/*.{js,jsx,ts,tsx}', flutter: '**/*.dart' };
  const fileGlob = extMap[p] || '**/*';

  const files = await listFiles(abs, fileGlob, { maxResults: 300 });
  const findings = [];

  for (const f of (files.files || []).slice(0, 200)) {
    if (f.type !== 'file') continue;
    const fabs = join(abs, f.path);
    let content;
    try { content = readFileSync(fabs, 'utf8'); } catch { continue; }

    for (const pattern of patterns) {
      const matches = [...content.matchAll(new RegExp(pattern.re.source, pattern.re.flags))];
      for (const m of matches.slice(0, 3)) {
        const line = content.slice(0, m.index).split('\n').length;
        findings.push({ id: pattern.id, severity: pattern.sev, name: pattern.name, file: f.path, line, match: m[0].slice(0, 120) });
      }
    }
  }

  const byFile = {};
  for (const f of findings) {
    if (!byFile[f.file]) byFile[f.file] = [];
    byFile[f.file].push(f);
  }

  const riskScore = findings.reduce((s, f) => s + ({ CRITICAL: 40, HIGH: 20, MEDIUM: 10, LOW: 5 }[f.severity] || 0), 0);
  const grade = riskScore === 0 ? 'A' : riskScore < 20 ? 'B' : riskScore < 60 ? 'C' : riskScore < 120 ? 'D' : 'F';

  return {
    platform: p,
    projectPath: abs,
    filesScanned: (files.files || []).length,
    findingCount: findings.length,
    criticals: findings.filter(f => f.severity === 'CRITICAL').length,
    highs: findings.filter(f => f.severity === 'HIGH').length,
    mediums: findings.filter(f => f.severity === 'MEDIUM').length,
    riskScore,
    grade,
    findings: findings.slice(0, 50),
    byFile,
  };
}

// ── Auto-fix mobile issues ────────────────────────────────────────────────────

export async function fixMobileLint(projectPath = '.', platform) {
  const abs = resolve(projectPath);
  const p = platform || detectMobilePlatform(abs).platform;
  printTool(`Auto-fixing lint [${p}]`);

  switch (p) {
    case 'swift': {
      const hasSwiftLint = await commandExists('swiftlint');
      if (hasSwiftLint) {
        return runCommand('swiftlint --fix --quiet 2>&1 | tail -20', { cwd: abs, timeout: 60000 });
      }
      return { note: 'SwiftLint not installed. Install: brew install swiftlint', skipped: true };
    }
    case 'kotlin': {
      const hasKtlint = await commandExists('ktlint');
      if (hasKtlint) return runCommand('ktlint --format 2>&1 | tail -20', { cwd: abs, timeout: 60000 });
      return { note: 'ktlint not installed. Install: brew install ktlint', skipped: true };
    }
    case 'react-native':
      return runCommand('npx eslint . --ext .js,.jsx,.ts,.tsx --fix 2>&1 | tail -20', { cwd: abs, timeout: 60000 });
    case 'flutter':
      return runCommand('dart fix --apply 2>&1 | tail -20', { cwd: abs, timeout: 120000 });
    default:
      return { error: `Unsupported platform: ${p}` };
  }
}

// ── Detect all mobile issues (for fixer.js integration) ──────────────────────

export async function detectMobileIssues(projectPath = '.') {
  const abs = resolve(projectPath);
  const detected = detectMobilePlatform(abs);
  const { platform } = detected;

  if (platform === 'unknown') return { issues: [], projectPath: abs };

  printTool(`Detecting mobile issues [${platform}]`);
  const issues = [];

  // Lint
  const lintResult = await runMobileLint(abs, platform);
  const lintOutput = (lintResult.stdout || '') + (lintResult.stderr || '');
  if (lintOutput && (lintOutput.includes('error') || lintOutput.includes('warning'))) {
    const errors = (lintOutput.match(/error/gi) || []).length;
    if (errors > 0) {
      issues.push({ type: 'lint', severity: 'medium', message: `${platform} lint: ${errors} errors`, detail: lintOutput.slice(0, 2000), projectPath: abs, platform });
    }
  }

  // Tests
  const testResult = await runMobileTests(abs, platform);
  const testOutput = (testResult.stdout || '') + (testResult.stderr || '');
  if (!testResult.success && testOutput) {
    const failed = (testOutput.match(/FAILED|failing|FAIL/gi) || []).length;
    if (failed > 0) {
      issues.push({ type: 'test', severity: 'high', message: `${platform} tests: ${failed} failing`, detail: testOutput.slice(0, 2000), projectPath: abs, platform });
    }
  }

  // Security
  const secResult = await scanMobileSecurity(abs, platform);
  if (secResult.criticals > 0) {
    issues.push({ type: 'security', severity: 'critical', message: `${secResult.criticals} critical mobile security issues (grade ${secResult.grade})`, detail: JSON.stringify(secResult.findings?.slice(0, 5), null, 2), projectPath: abs, platform, findings: secResult.findings });
  } else if (secResult.highs > 0) {
    issues.push({ type: 'security', severity: 'high', message: `${secResult.highs} high severity mobile security issues`, detail: JSON.stringify(secResult.findings?.filter(f => f.severity === 'HIGH').slice(0, 5), null, 2), projectPath: abs, platform });
  }

  // Missing deps
  if (platform === 'flutter' && !await commandExists('flutter')) {
    issues.push({ type: 'deps', severity: 'high', message: 'flutter CLI not found', fix: 'Install Flutter SDK: https://flutter.dev/docs/get-started/install', projectPath: abs });
  }
  if (platform === 'react-native' && !existsSync(join(abs, 'node_modules'))) {
    issues.push({ type: 'deps', severity: 'high', message: 'node_modules missing', fix: 'npm install', projectPath: abs });
  }
  if ((platform === 'kotlin') && !existsSync(join(abs, 'gradlew')) && !await commandExists('gradle')) {
    issues.push({ type: 'deps', severity: 'medium', message: 'Gradle wrapper not found', projectPath: abs });
  }

  return { platform, issues, issueCount: issues.length, projectPath: abs };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function commandExists(cmd) {
  const r = await runCommandSync(`which ${cmd} 2>/dev/null`);
  return r.success && r.stdout.trim().length > 0;
}

async function detectXcodeScheme(abs) {
  const r = await runCommandSync('xcodebuild -list 2>&1 | grep -A5 "Schemes:" | grep -v "Schemes:" | head -1', abs);
  return r.stdout?.trim() || null;
}

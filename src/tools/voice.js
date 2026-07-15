// src/tools/voice.js — voice input via Groq Whisper + macOS recording
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, execFileSync } from 'child_process';
import { transcribeAudio } from '../llm.js';
import { printTool, printError, printSuccess, labels } from '../ui.js';
import chalk from 'chalk';

const TMP_AUDIO = join(tmpdir(), 'devlab_voice.wav');

function detectRecorder() {
  try { execSync('which sox', { stdio: 'pipe' }); return 'sox'; } catch {}
  try { execSync('which ffmpeg', { stdio: 'pipe' }); return 'ffmpeg'; } catch {}
  try { execSync('which rec', { stdio: 'pipe' }); return 'rec'; } catch {}
  return null;
}

async function recordAudio(seconds = 5) {
  // Sanitize: seconds is interpolated into a shell command — force a safe integer
  seconds = Math.max(1, Math.min(300, parseInt(seconds, 10) || 5));
  const recorder = detectRecorder();
  if (!recorder) {
    return { error: 'No audio recorder found. Install sox: brew install sox' };
  }

  printTool(`Recording for ${seconds}s... (press Ctrl+C to stop early)`);
  const opts = { timeout: (seconds + 5) * 1000, stdio: ['ignore', 'ignore', 'ignore'] };
  try {
    if (recorder === 'sox' || recorder === 'rec') {
      try {
        execFileSync('rec', ['-q', '-r', '16000', '-c', '1', TMP_AUDIO, 'trim', '0', String(seconds)], opts);
      } catch {
        execFileSync('sox', ['-q', '-d', '-r', '16000', '-c', '1', TMP_AUDIO, 'trim', '0', String(seconds)], opts);
      }
    } else {
      execFileSync('ffmpeg', ['-y', '-f', 'avfoundation', '-i', ':0', '-ar', '16000', '-ac', '1', '-t', String(seconds), TMP_AUDIO], opts);
    }
    return { path: TMP_AUDIO, recorder };
  } catch (e) {
    return { error: e.message };
  }
}

export async function voiceToText(seconds = 5) {
  const rec = await recordAudio(seconds);
  if (rec.error) return rec;

  printTool('Transcribing via Groq Whisper...');
  try {
    const text = await transcribeAudio(TMP_AUDIO);
    try { unlinkSync(TMP_AUDIO); } catch {}
    printSuccess(`Transcribed: "${text}"`);
    return { text, success: true };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Voice mode REPL ────────────────────────────────────────────────────────────
export async function startVoiceMode(agent) {
  console.log(`\n${labels.voice} ${chalk.magentaBright('Voice mode — speak your command, then press Enter')}`);
  console.log(chalk.gray('  Uses Groq Whisper (free). Requires sox: brew install sox\n'));

  const recorder = detectRecorder();
  if (!recorder) {
    printError('No recorder found. Install sox: brew install sox');
    return;
  }

  // Keep recording & processing
  while (true) {
    console.log(chalk.gray('\nPress Enter to start recording (q + Enter to quit)...'));
    const input = await new Promise(res => {
      process.stdin.once('data', d => res(d.toString().trim()));
    });
    if (input === 'q') break;

    const result = await voiceToText(8);
    if (result.error) {
      printError(result.error);
      continue;
    }
    if (result.text) {
      await agent.run(result.text);
    }
  }
}

// src/config.js — centralised configuration
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load .env from project root if present
try {
  const { config } = await import('dotenv');
  config({ path: join(process.cwd(), '.env') });
  // Also try Agent dir
  config({ path: new URL('../.env', import.meta.url).pathname });
} catch {}

export const AGENT_DIR = join(homedir(), '.codeagent');
if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });

export const MEMORY_DB_PATH = process.env.MEMORY_DB_PATH || join(AGENT_DIR, 'memory.db');
export const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || join(new URL('..', import.meta.url).pathname, 'workflows');

export const GROQ_API_KEY = process.env.GROQ_API_KEY;
export const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
export const FAST_MODEL = 'llama-3.1-8b-instant';
export const WHISPER_MODEL = 'whisper-large-v3-turbo';
export const MODEL_PROVIDER = (process.env.MODEL_PROVIDER || (process.env.GROQ_API_KEY ? 'groq' : (process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY ? 'claude' : 'free'))).toLowerCase();
export const MODEL_NAME = process.env.MODEL_NAME || DEFAULT_MODEL;
export const FAST_MODEL_NAME = process.env.FAST_MODEL_NAME || FAST_MODEL;
export const FREE_MODEL_PROVIDER = (process.env.FREE_MODEL_PROVIDER || '').toLowerCase();
export const FREE_MODEL = process.env.FREE_MODEL || DEFAULT_MODEL;
export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-latest';
export const CLAUDE_FAST_MODEL = process.env.CLAUDE_FAST_MODEL || CLAUDE_MODEL;
export const CLAUDE_BASE_URL = process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com';
export const OPENAI_COMPAT_BASE_URL = process.env.OPENAI_COMPAT_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OLLAMA_API_KEY || 'ollama';
export const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || process.env.OLLAMA_MODEL || FREE_MODEL;

// Near-frontier, low-cost provider presets (all OpenAI-compatible).
// One env key unlocks ~90-95% of Claude quality at 1/10th-1/15th the price.
export const CHEAP_FRONTIER_PROVIDERS = {
  // US-origin, government-acceptable models only (no Chinese-origin weights):
  // gpt-oss (OpenAI, Apache 2.0) for frontier reasoning; Llama 3.x for chat.
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
    fastModel: process.env.OPENROUTER_FAST_MODEL || 'meta-llama/llama-3.1-8b-instruct',
    reasoningModel: process.env.OPENROUTER_REASONING_MODEL || 'openai/gpt-oss-120b',
  },
  together: {
    baseUrl: process.env.TOGETHER_BASE_URL || 'https://api.together.xyz/v1',
    apiKey: process.env.TOGETHER_API_KEY,
    model: process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fastModel: process.env.TOGETHER_FAST_MODEL || 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
    reasoningModel: process.env.TOGETHER_REASONING_MODEL || 'openai/gpt-oss-120b',
  },
};

// DEVLAB_CLAUDE=off runs DevLab fully Claude-free: Claude rungs are stripped
// from every routing ladder even when an Anthropic key is present.
export const CLAUDE_DISABLED = /^(off|0|false|no)$/i.test(process.env.DEVLAB_CLAUDE || '');
export const COPILOT_FALLBACK_PROVIDER = (process.env.COPILOT_FALLBACK_PROVIDER || (process.env.GROQ_API_KEY ? 'groq' : (process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY ? 'claude' : 'free'))).toLowerCase();
export const FALLBACK_PROVIDER = (process.env.FALLBACK_PROVIDER || COPILOT_FALLBACK_PROVIDER).toLowerCase();

export const SAFETY_MODE = (process.env.SAFETY_MODE || 'normal').toLowerCase();
// strict = confirm everything | normal = confirm destructive | autonomous = no confirms
export const AUTONOMOUS = SAFETY_MODE === 'autonomous';

export const MAX_AGENT_ITERATIONS = 30;
export const MAX_CONTEXT_MESSAGES = 40;   // prune after this
export const MAX_FILE_SIZE = 200_000;     // bytes — skip larger files in scans

// DEVLAB_NO_LOG=1 — server never stores prompts, code, or responses.
// Set this on your hosted server so client source code stays client-side only.
// Disables: session_turns DB writes, memory recall injection, request logging.
export const NO_LOG = /^(1|true|yes|on)$/i.test(process.env.DEVLAB_NO_LOG || '');

export const VERSION = '1.0.0';

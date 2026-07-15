// src/llm.js — multi-provider LLM interface with streaming, tool calling, and cost tracking
import Groq from 'groq-sdk';
import {
  GROQ_API_KEY,
  DEFAULT_MODEL,
  FAST_MODEL_NAME,
  MODEL_PROVIDER,
  MODEL_NAME,
  CLAUDE_API_KEY,
  CLAUDE_MODEL,
  CLAUDE_FAST_MODEL,
  CLAUDE_BASE_URL,
  OPENAI_COMPAT_BASE_URL,
  OPENAI_COMPAT_API_KEY,
  OPENAI_COMPAT_MODEL,
  FREE_MODEL_PROVIDER,
  FREE_MODEL,
  COPILOT_FALLBACK_PROVIDER,
  FALLBACK_PROVIDER,
  CHEAP_FRONTIER_PROVIDERS,
} from './config.js';
import { printError, stopSpinner } from './ui.js';
import { assertProviderAllowed } from './privacy.js';

const groq = GROQ_API_KEY && GROQ_API_KEY !== 'gsk_your_key_here'
  ? new Groq({ apiKey: GROQ_API_KEY })
  : null;

const FREE_PROVIDER_ALIASES = new Set(['free', 'free-model', 'free-models']);
const OPENAI_COMPATIBLE_PROVIDER_ALIASES = new Set(['ollama', 'openai', 'openai-compatible', 'local']);
const ANTHROPIC_PROVIDER_ALIASES = new Set(['claude', 'anthropic']);
const COPILOT_PROVIDER_ALIASES = new Set(['copilot', 'copilot-cli']);

// ── Session token tracking ────────────────────────────────────────────────────
let sessionTokensIn = 0;
let sessionTokensOut = 0;
let sessionCalls = 0;
let sessionCacheRead = 0;
let sessionCacheWrite = 0;

export function getTokenStats() {
  return {
    in: sessionTokensIn, out: sessionTokensOut, calls: sessionCalls,
    total: sessionTokensIn + sessionTokensOut,
    cacheRead: sessionCacheRead, cacheWrite: sessionCacheWrite,
  };
}

export function resetTokenStats() {
  sessionTokensIn = 0;
  sessionTokensOut = 0;
  sessionCalls = 0;
  sessionCacheRead = 0;
  sessionCacheWrite = 0;
}

export function listModelProviders() {
  return [
    { name: 'groq', description: 'Groq OpenAI-compatible API (fast, free tier)', supportsTools: true },
    { name: 'claude', description: 'Anthropic Claude via Messages API', supportsTools: true },
    { name: 'ollama', description: 'Local OpenAI-compatible models (free)', supportsTools: true },
    { name: 'free', description: 'Free model alias (Groq free tier or local fallback)', supportsTools: true },
    { name: 'copilot', description: 'Copilot alias fallback (routes to a normal provider)', supportsTools: true },
  ];
}

export function getProviderModels(provider) {
  const normalized = normalizeProvider(provider);
  if (normalized === 'claude') {
    return [
      { value: 'claude-3-5-sonnet-latest', label: 'claude-3-5-sonnet-latest', description: 'Recommended for coding' },
      { value: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku-latest', description: 'Faster, lower cost' },
      { value: 'claude-3-opus-latest', label: 'claude-3-opus-latest', description: 'Largest model' },
    ];
  }

  if (normalized === 'openai-compatible') {
    return [
      { value: OPENAI_COMPAT_MODEL, label: `${OPENAI_COMPAT_MODEL} (active)`, description: 'Currently configured model' },
      { value: 'devlab-coder', label: 'devlab-coder', description: 'Custom DevLab coding model' },
      { value: 'codellama:13b', label: 'codellama:13b', description: 'CodeLlama 13B — coding, 8GB RAM' },
      { value: 'codellama:34b', label: 'codellama:34b', description: 'CodeLlama 34B — best quality, 20GB RAM' },
      { value: 'llama3.2:3b', label: 'llama3.2:3b', description: 'Fast general chat, 2GB RAM' },
      { value: 'mistral:7b', label: 'mistral:7b', description: 'Good code review, 4GB RAM' },
      { value: 'gpt-oss:20b', label: 'gpt-oss:20b', description: 'OpenAI open-weight model (Apache 2.0)' },
    ];
  }

  if (normalized === 'free') {
    return [
      { value: FREE_MODEL, label: `${FREE_MODEL} (current)`, description: 'Default free model' },
      { value: FAST_MODEL_NAME, label: `${FAST_MODEL_NAME} (fast)`, description: 'Fast Groq model' },
      { value: OPENAI_COMPAT_MODEL, label: `${OPENAI_COMPAT_MODEL} (local)`, description: 'OpenAI-compatible local model' },
    ];
  }

  return [
    { value: MODEL_NAME, label: `${MODEL_NAME} (current)`, description: 'Default Groq model' },
    { value: FAST_MODEL_NAME, label: `${FAST_MODEL_NAME} (fast)`, description: 'Fast Groq model' },
  ];
}

/**
 * Fetch live model list from a running Ollama server.
 * Returns [] if Ollama is not reachable.
 * @param {string} [baseUrl] - Ollama base URL, defaults to OPENAI_COMPAT_BASE_URL
 */
export async function listOllamaModels(baseUrl) {
  const base = (baseUrl || OPENAI_COMPAT_BASE_URL).replace(/\/v1\/?$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => ({
      value: m.name,
      label: m.name,
      description: `${m.size ? (m.size / 1e9).toFixed(1) + ' GB' : ''}${m.name === OPENAI_COMPAT_MODEL ? ' ◀ active' : ''}`,
    }));
  } catch {
    return [];
  }
}

// ── Core chat function ────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {Array}  opts.messages
 * @param {Array}  [opts.tools]
 * @param {string} [opts.model]
 * @param {string} [opts.provider]
 * @param {boolean}[opts.stream]       stream text to stdout (best-effort)
 * @param {boolean}[opts.fastModel]    use smaller fast model
 * @returns {{ content: string, toolCalls: Array, provider: string, effectiveProvider: string }}
 */
export async function chat({ messages, tools = [], model, provider, stream = false, fastModel = false }) {
  const requestedProvider = normalizeProvider(provider || MODEL_PROVIDER);
  const effectiveProvider = resolveEffectiveProvider(requestedProvider);
  const chosenModel = resolveModelName(requestedProvider, effectiveProvider, model, fastModel);

  // Privacy guard: in local-only mode, cloud providers are hard-blocked here —
  // the single choke point every request (agent, subagents, router, UI) flows through.
  assertProviderAllowed(effectiveProvider, { baseUrl: OPENAI_COMPAT_BASE_URL });

  const resp = await dispatchChat({ messages, tools, model: chosenModel, stream, requestedProvider, effectiveProvider });

  // Billing: meter every request (never let metering break a chat)
  try {
    const { meter } = await import('./billing.js');
    meter({ provider: effectiveProvider, tokensIn: resp.inputTokens || 0, tokensOut: resp.outputTokens || 0 });
  } catch { /* metering is best-effort */ }

  return resp;
}

async function dispatchChat({ messages, tools, model: chosenModel, stream, requestedProvider, effectiveProvider }) {
  // Cheap-frontier presets (openrouter/together): OpenAI-compatible
  // endpoints with near-Claude quality at ~1/10th the cost.
  const preset = CHEAP_FRONTIER_PROVIDERS[effectiveProvider];
  if (preset) {
    if (!preset.apiKey) throw new Error(`${effectiveProvider.toUpperCase()}_API_KEY is not set.`);
    return chatOpenAICompatible({
      messages, tools, stream,
      model: chosenModel,
      provider: requestedProvider,
      effectiveProvider,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
    });
  }

  if (effectiveProvider === 'groq') {
    return chatGroq({ messages, tools, model: chosenModel, stream, provider: requestedProvider, effectiveProvider });
  }

  if (effectiveProvider === 'claude') {
    return chatAnthropic({ messages, tools, model: chosenModel, provider: requestedProvider, effectiveProvider });
  }

  if (effectiveProvider === 'openai-compatible') {
    return chatOpenAICompatible({
      messages,
      tools,
      model: chosenModel,
      stream,
      provider: requestedProvider,
      effectiveProvider,
      baseUrl: OPENAI_COMPAT_BASE_URL,
      apiKey: OPENAI_COMPAT_API_KEY,
    });
  }

  throw new Error(`Unsupported model provider: ${requestedProvider || MODEL_PROVIDER}`);
}

async function chatGroq({ messages, tools = [], model, stream = false, provider, effectiveProvider }) {
  if (!groq) {
    throw new Error('GROQ_API_KEY is not set. Configure GROQ_API_KEY or switch MODEL_PROVIDER to claude/ollama/free.');
  }

  const params = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 8192,
  };

  if (tools.length > 0) {
    params.tools = tools;
    params.tool_choice = 'auto';
  }

  let content = '';
  let toolCalls = [];
  let inputTokens = 0;
  let outputTokens = 0;

  if (stream && tools.length === 0) {
    const streamResp = await groq.chat.completions.create({ ...params, stream: true });
    process.stdout.write('\n');
    for await (const chunk of streamResp) {
      const delta = chunk.choices[0]?.delta?.content || '';
      process.stdout.write(delta);
      content += delta;
      if (chunk.x_groq?.usage) {
        inputTokens = chunk.x_groq.usage.prompt_tokens || 0;
        outputTokens = chunk.x_groq.usage.completion_tokens || 0;
      }
    }
    process.stdout.write('\n');
  } else {
    const resp = await groq.chat.completions.create(params);
    const msg = resp.choices[0].message;
    content = msg.content || '';
    toolCalls = msg.tool_calls || [];
    inputTokens = resp.usage?.prompt_tokens || 0;
    outputTokens = resp.usage?.completion_tokens || 0;
  }

  sessionTokensIn += inputTokens;
  sessionTokensOut += outputTokens;
  sessionCalls++;

  return { content, toolCalls, model, provider, effectiveProvider, inputTokens, outputTokens };
}

async function chatAnthropic({ messages, tools = [], model, provider, effectiveProvider }) {
  if (!CLAUDE_API_KEY) {
    throw new Error('CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is not set.');
  }

  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body = {
    model,
    max_tokens: 8192,
    temperature: 0.2,
    messages: anthropicMessages,
  };

  if (system) {
    // Prompt caching: system prompt (DevLab prompt + rules + memories) is stable
    // per session — cache it so repeat reads cost ~10% of normal input tokens.
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  if (tools.length > 0) {
    body.tools = tools.map(toAnthropicTool);
    // Cache the (large, static) tool definitions block too.
    body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
    body.tool_choice = { type: 'auto' };
  }

  const resp = await fetch(`${CLAUDE_BASE_URL.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!resp.ok) {
    throw new Error(`Claude request failed (${resp.status}): ${data.error?.message || data.error || JSON.stringify(data).slice(0, 500)}`);
  }

  let content = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') content += block.text || '';
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `tool_${toolCalls.length + 1}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const cacheRead = data.usage?.cache_read_input_tokens || 0;
  const cacheWrite = data.usage?.cache_creation_input_tokens || 0;
  sessionTokensIn += inputTokens;
  sessionTokensOut += outputTokens;
  sessionCacheRead += cacheRead;
  sessionCacheWrite += cacheWrite;
  sessionCalls++;

  return { content, toolCalls, model, provider, effectiveProvider, inputTokens, outputTokens, cacheRead, cacheWrite };
}

async function chatOpenAICompatible({ messages, tools = [], model, stream = false, provider, effectiveProvider, baseUrl, apiKey }) {
  const payload = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 8192,
  };

  if (tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  if (stream && tools.length === 0) {
    // Best-effort stream support: not all compatible providers implement SSE the same way.
    // Fall back to non-streaming for portability.
  }

  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...((apiKey && apiKey !== 'ollama') ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!resp.ok) {
    throw new Error(`Model request failed (${resp.status}): ${data.error?.message || data.error || JSON.stringify(data).slice(0, 500)}`);
  }

  const msg = data.choices?.[0]?.message || {};
  const content = msg.content || '';
  const toolCalls = msg.tool_calls || [];
  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;

  sessionTokensIn += inputTokens;
  sessionTokensOut += outputTokens;
  sessionCalls++;

  return { content, toolCalls, model, provider, effectiveProvider, inputTokens, outputTokens };
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  if (!value) return 'groq';
  if (ANTHROPIC_PROVIDER_ALIASES.has(value)) return 'claude';
  if (COPILOT_PROVIDER_ALIASES.has(value)) return 'copilot';
  if (OPENAI_COMPATIBLE_PROVIDER_ALIASES.has(value)) return 'openai-compatible';
  if (FREE_PROVIDER_ALIASES.has(value)) return 'free';
  return value;
}

function resolveEffectiveProvider(requestedProvider) {
  if (requestedProvider === 'copilot') {
    return resolveEffectiveProvider(normalizeProvider(COPILOT_FALLBACK_PROVIDER || FALLBACK_PROVIDER || 'groq'));
  }

  if (requestedProvider === 'free') {
    const freeProvider = normalizeProvider(FREE_MODEL_PROVIDER || (groq ? 'groq' : 'ollama'));
    return freeProvider === 'copilot' ? 'groq' : freeProvider;
  }

  if (requestedProvider === 'groq' || requestedProvider === 'claude' || requestedProvider === 'openai-compatible') {
    return requestedProvider;
  }

  // Unknown values are treated as a fallback-friendly OpenAI-compatible provider.
  return requestedProvider === 'ollama' ? 'openai-compatible' : requestedProvider;
}

function resolveModelName(requestedProvider, provider, model, fastModel) {
  if (model) return model;
  if (requestedProvider === 'free') return FREE_MODEL;
  if (provider === 'claude') return fastModel ? CLAUDE_FAST_MODEL : CLAUDE_MODEL;
  const preset = CHEAP_FRONTIER_PROVIDERS[provider];
  if (preset) return fastModel ? preset.fastModel : preset.model;
  if (provider === 'openai-compatible') return fastModel ? (process.env.OPENAI_COMPAT_FAST_MODEL || OPENAI_COMPAT_MODEL) : OPENAI_COMPAT_MODEL;
  if (provider === 'groq') return fastModel ? FAST_MODEL_NAME : MODEL_NAME;
  return fastModel ? FAST_MODEL_NAME : MODEL_NAME;
}

function toAnthropicTool(tool) {
  const fn = tool?.function || {};
  return {
    name: fn.name,
    description: fn.description || '',
    input_schema: fn.parameters || { type: 'object', properties: {} },
  };
}

function toAnthropicMessages(messages = []) {
  const anthropicMessages = [];
  let system = '';

  for (const message of messages) {
    if (!message || !message.role) continue;
    if (message.role === 'system') {
      system = system ? `${system}\n\n${message.content || ''}` : (message.content || '');
      continue;
    }

    if (message.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id || message.id || `tool_${anthropicMessages.length + 1}`,
          content: message.content || '',
        }],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) {
        blocks.push({ type: 'text', text: String(message.content) });
      }
      for (const toolCall of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(toolCall.function?.arguments || '{}'); } catch {}
        blocks.push({
          type: 'tool_use',
          id: toolCall.id || `tool_${blocks.length + 1}`,
          name: toolCall.function?.name,
          input,
        });
      }
      anthropicMessages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }

    anthropicMessages.push({
      role: message.role,
      content: [{ type: 'text', text: String(message.content || '') }],
    });
  }

  return { system, messages: anthropicMessages };
}

// ── Transcription via Whisper ─────────────────────────────────────────────────
export async function transcribeAudio(audioFilePath) {
  if (!groq) {
    throw new Error('GROQ_API_KEY is required for transcription.');
  }
  assertProviderAllowed('groq'); // audio leaves the machine too
  const { createReadStream } = await import('fs');
  const transcription = await groq.audio.transcriptions.create({
    file: createReadStream(audioFilePath),
    model: 'whisper-large-v3-turbo',
    response_format: 'text',
  });
  return transcription;
}

// ── Quick summarise (uses fast model) ─────────────────────────────────────────
export async function summarise(text, instruction = 'Summarise concisely in 3-5 sentences:', opts = {}) {
  const resp = await chat({
    messages: [
      { role: 'system', content: 'You are a concise summariser. Return plain text, no markdown.' },
      { role: 'user', content: `${instruction}\n\n${text.slice(0, 20000)}` },
    ],
    fastModel: true,
    provider: opts.provider,
    model: opts.model,
  });
  return resp.content;
}

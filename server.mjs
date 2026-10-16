#!/usr/bin/env node
/**
 * joycode-proxy — expose JoyCode (京东云 JoyCoder 积分) as an OpenAI-compatible API.
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream & non-stream)
 *   GET  /health
 *
 * Backend: JoyCode's "color gateway" — https://api-ai.jd.com/api with an
 * HMAC-SHA256 signed query string and a `ptKey` header. This is the exact
 * protocol the JoyCode IDE uses (reversed from its bundled extension.js), so
 * requests are billed against the same account/credits as the IDE itself.
 *
 * Credits are not exposed by the backend response; token counts ARE returned,
 * so `usage` is passed through verbatim.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.JOYCODE_PROXY_PORT || 8318);
const HOST = process.env.JOYCODE_PROXY_HOST || '127.0.0.1';
const DEFAULT_MODEL = process.env.JOYCODE_PROXY_MODEL || 'JoyAI-Code-1.6';
const API_KEY = process.env.JOYCODE_PROXY_API_KEY || '';

// ---- JoyCode gateway credentials (overridable via env) -------------------
// Extracted from the JoyCode IDE login state; ptKey is the account ticket,
// colorBaseUrl is the gateway origin, masterBaseUrl is the direct origin.
const PT_KEY = process.env.JOYCODE_PT_KEY || '';
const COLOR_BASE_URL = process.env.JOYCODE_COLOR_BASE_URL || 'https://api-ai.jd.com';
const MASTER_BASE_URL = process.env.JOYCODE_MASTER_BASE_URL || '';
const TENANT = process.env.JOYCODE_TENANT || '';
const LOGIN_TYPE = process.env.JOYCODE_LOGIN_TYPE || 'PIN_JD_CLOUD';

// Gateway constants (shipped in the JoyCode extension bundle).
const COLOR_GATEWAY_APPID = 'joycode_ide';
const COLOR_GATEWAY_PATH = '/api';
// HMAC signing key, extracted from the JoyCode IDE's bundled extension.js.
//
// This is a PUBLIC PROTOCOL CONSTANT, not a secret: it is baked into every copy
// of the IDE and identifies the client, nothing more. It cannot authorize a
// request on its own — the account credential is the `ptKey` header, which is
// read from the environment and must never be committed.
//
// If JoyCode ever rotates the key, re-extract it from extension.js and update
// this constant (or override at runtime via JOYCODE_SIGN_KEY).
const COLOR_GATEWAY_SIGN_KEY =
  process.env.JOYCODE_SIGN_KEY || '0691a3f0b37b4a85aeb63ad0fc7db3ed';

/** Models the JoyCode backend offers (from /joycode_modelList). */
const MODELS = [
  { id: 'JoyAI-Code-1.6', name: 'JoyAI-Code-1.6', vision: false, contextWindow: 200000, maxTokens: 64000 },
  { id: 'GLM-5.3-agent', name: 'GLM-5.3', vision: false, contextWindow: 200000, maxTokens: 64000 },
  { id: 'Kimi-K2.6-agent', name: 'Kimi-K2.6', vision: true, contextWindow: 200000, maxTokens: 64000 },
  { id: 'MiniMax-M3-agent', name: 'MiniMax-M3', vision: true, contextWindow: 200000, maxTokens: 64000 },
  { id: 'Doubao-Seed-2.0-pro-agent', name: 'Doubao-Seed-2.0-pro', vision: true, contextWindow: 200000, maxTokens: 64000 },
];
const MODEL_IDS = new Set(MODELS.map((m) => m.id));
const MODEL_ALIASES = new Map();
for (const m of MODELS) {
  MODEL_ALIASES.set(m.id.toLowerCase(), m.id);
  MODEL_ALIASES.set(m.name.toLowerCase(), m.id);
}
// Common shorthands -> chatApiModel
MODEL_ALIASES.set('joyai', 'JoyAI-Code-1.6');
MODEL_ALIASES.set('joyai-code', 'JoyAI-Code-1.6');
MODEL_ALIASES.set('glm', 'GLM-5.3-agent');
MODEL_ALIASES.set('glm-5.3', 'GLM-5.3-agent');
MODEL_ALIASES.set('kimi', 'Kimi-K2.6-agent');
MODEL_ALIASES.set('kimi-k2.6', 'Kimi-K2.6-agent');
MODEL_ALIASES.set('minimax', 'MiniMax-M3-agent');
MODEL_ALIASES.set('minimax-m3', 'MiniMax-M3-agent');
MODEL_ALIASES.set('doubao', 'Doubao-Seed-2.0-pro-agent');
MODEL_ALIASES.set('doubao-seed', 'Doubao-Seed-2.0-pro-agent');

const created = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- helpers

function log(...args) {
  process.stderr.write(`[joycode-proxy ${new Date().toISOString()}] ${args.join(' ')}\n`);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, code, param: null } });
}

async function readBody(req, limitBytes = 16 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * JoyCode gateway signature (mirrors extension.js module 68327):
 *   merged = { ...extra, appid, functionId, t: Date.now() }
 *   h      = sortedKeys.map(k => merged[k]).filter(non-empty).join('&')
 *   sign   = hex( HMAC-SHA256(h, secret) )
 */
function signQuery(functionId, extra = {}) {
  const merged = { ...extra, appid: COLOR_GATEWAY_APPID, functionId, t: Date.now() };
  const h = Object.keys(merged)
    .sort()
    .map((k) => merged[k])
    .filter((v) => v !== '' && v !== undefined && v !== null)
    .join('&');
  const sig = crypto.createHmac('sha256', COLOR_GATEWAY_SIGN_KEY).update(h).digest('hex');
  return { ...merged, sign: sig };
}

/**
 * Build the gateway URL. Prefers the color gateway origin; falls back to a
 * direct origin (masterBaseUrl) if configured.
 */
function gatewayUrl(functionId, extra = {}) {
  const q = signQuery(functionId, extra);
  const origin = COLOR_BASE_URL || MASTER_BASE_URL;
  if (!origin) throw new Error('no JoyCode gateway origin configured');
  const u = new URL(COLOR_GATEWAY_PATH, origin);
  for (const [k, v] of Object.entries(q)) u.searchParams.append(k, String(v));
  return u.toString();
}

/** Headers the gateway expects (ptKey is the account auth). */
function gatewayHeaders() {
  return {
    'content-type': 'application/json; charset=UTF-8',
    ptKey: PT_KEY,
    ...(LOGIN_TYPE ? { loginType: LOGIN_TYPE } : {}),
    ...(TENANT ? { tenant: encodeURIComponent(TENANT) } : {}),
  };
}

function resolveModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (MODEL_IDS.has(requested)) return requested;
  const lower = String(requested).toLowerCase();
  if (MODEL_ALIASES.has(lower)) return MODEL_ALIASES.get(lower);
  return requested; // let the backend decide
}

function modelRecord(id) {
  return MODELS.find((m) => m.id === id) || null;
}

// ---------------------------------------------------------------- joycode call

/**
 * Drive one JoyCode chat completion. Returns the full assembled payload.
 * When `onDelta` is provided, streams deltas (reasoning vs content) as they
 * arrive and returns `{ text, reasoning, usage, finishReason }` instead of
 * the raw upstream body.
 */
async function runJoyCode({ prompt, system, model, signal, onDelta }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model,
    messages,
    stream: Boolean(onDelta),
    ...(onDelta ? {} : { max_tokens: 64000 }),
  };

  const url = gatewayUrl('chat_completions');
  const headers = gatewayHeaders();

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`joycode upstream ${resp.status}: ${t.slice(0, 300)}`);
  }

  if (!onDelta) {
    const json = await resp.json().catch(async () => {
      throw new Error(`joycode upstream returned non-JSON: ${(await resp.text()).slice(0, 200)}`);
    });
    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    return {
      text: message.content ?? '',
      reasoning: message.reasoning_content ?? '',
      usage: json.usage ?? null,
      finishReason: choice?.finish_reason ?? 'stop',
      modelUsed: json.model ?? model,
    };
  }

  // ---- streaming ----
  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = 'stop';
  let modelUsed = model;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.model) modelUsed = chunk.model;
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (delta.role === 'assistant' && !delta.content && !delta.reasoning_content) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onDelta({ channel: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          text += delta.content;
          onDelta({ channel: 'content', text: delta.content });
        }
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, reasoning, usage, finishReason, modelUsed };
}

// ---------------------------------------------------------------- handlers

function handleModels(res) {
  sendJson(res, 200, {
    object: 'list',
    data: MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created,
      owned_by: 'joycode',
    })),
  });
}

async function handleChatCompletions(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return sendError(res, 400, 'invalid JSON body');
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendError(res, 400, "you must provide a 'messages' array");
  }

  const model = resolveModel(payload.model);
  const wantsStream = payload.stream === true;
  const { prompt, system } = flattenMessages(messages);

  if (!prompt.trim()) return sendError(res, 400, 'no usable text content in messages');

  const controller = new AbortController();
  req.on('aborted', () => controller.abort());

  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;

  if (!wantsStream) {
    try {
      const out = await runJoyCode({ prompt, system, model, signal: controller.signal });
      return sendJson(
        res,
        200,
        {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: out.modelUsed || model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: out.text, ...(out.reasoning ? { reasoning_content: out.reasoning } : {}) },
              finish_reason: out.finishReason,
            },
          ],
          usage: out.usage,
        },
        { 'x-joycode-model': out.modelUsed || model },
      );
    } catch (e) {
      log('non-stream error:', e?.message);
      if (controller.signal.aborted) return;
      return sendError(res, 502, String(e?.message ?? e), 'upstream_error');
    }
  }

  // ---- streaming ----
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const write = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const baseChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };

  write({ ...baseChunk, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  res.write(': joycode-proxy stream open\n\n');

  let sentAny = false;
  try {
    const out = await runJoyCode({
      prompt,
      system,
      model,
      signal: controller.signal,
      onDelta: ({ channel, text }) => {
        sentAny = true;
        if (channel === 'reasoning') {
          write({ ...baseChunk, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
        } else {
          write({ ...baseChunk, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        }
      },
    });

    if (!sentAny && out.text) {
      write({ ...baseChunk, choices: [{ index: 0, delta: { content: out.text }, finish_reason: null }] });
    }

    write({ ...baseChunk, model: out.modelUsed || model, choices: [{ index: 0, delta: {}, finish_reason: out.finishReason }] });
    if (out.usage) {
      write({ ...baseChunk, model: out.modelUsed || model, choices: [], usage: out.usage });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    log('stream error:', e?.message);
    if (!res.writableEnded) {
      write({ ...baseChunk, choices: [{ index: 0, delta: { content: `\n[proxy error] ${e?.message ?? e}` }, finish_reason: null }] });
      write({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

// ---------------------------------------------------------------- flatten

/**
 * OpenAI `messages` -> { prompt, system }.
 * JoyCode's gateway is a plain OpenAI-compatible chat backend, so we could pass
 * messages through verbatim. But to keep the proxy stateless and robust across
 * clients (and match the qoder-proxy behaviour), we flatten to a single prompt.
 */
function flattenMessages(messages) {
  const systemParts = [];
  const turns = [];

  for (const m of messages ?? []) {
    const role = m.role;
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .map((c) => {
              if (typeof c === 'string') return c;
              if (c?.type === 'text') return c.text ?? '';
              if (c?.type === 'image_url') return '[image omitted]';
              return '';
            })
            .join('')
        : '';

    if (role === 'system' || role === 'developer') {
      if (content.trim()) systemParts.push(content.trim());
      continue;
    }
    if (!content.trim()) continue;

    if (role === 'user') turns.push(`User: ${content}`);
    else if (role === 'assistant') turns.push(`Assistant: ${content}`);
    else if (role === 'tool') turns.push(`Tool result: ${content}`);
  }

  let prompt;
  if (turns.length === 1 && turns[0].startsWith('User: ')) {
    prompt = turns[0].slice('User: '.length);
  } else if (turns.length === 0) {
    prompt = systemParts.join('\n\n') || '';
  } else {
    prompt = `${turns.join('\n\n')}\n\nAssistant:`;
  }

  return { prompt, system: systemParts.join('\n\n') };
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    return res.end();
  }

  if (url.pathname === '/health' || url.pathname === '/') {
    const missing = [];
    if (!PT_KEY) missing.push('JOYCODE_PT_KEY');
    if (!COLOR_BASE_URL && !MASTER_BASE_URL) missing.push('JOYCODE_COLOR_BASE_URL/MASTER_BASE_URL');
    return sendJson(res, 200, {
      status: 'ok',
      service: 'joycode-proxy',
      models: MODELS.length,
      default_model: DEFAULT_MODEL,
      configured: missing.length === 0,
      ...(missing.length ? { missing_env: missing } : {}),
    });
  }

  if (API_KEY) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${API_KEY}`) return sendError(res, 401, 'invalid api key', 'authentication_error');
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/v1/models/')) {
    return handleModels(res);
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/chat/completions/')) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendError(res, 413, String(e.message));
    }
    return handleChatCompletions(req, res, body);
  }

  return sendError(res, 404, `unknown route ${req.method} ${url.pathname}`, 'not_found_error');
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`default model: ${DEFAULT_MODEL} | ${MODELS.length} models available`);
  log(`gateway: ${COLOR_BASE_URL || MASTER_BASE_URL}${COLOR_GATEWAY_PATH}`);
  log(`auth: ptKey ${PT_KEY ? 'present' : 'MISSING (set JOYCODE_PT_KEY)'}${API_KEY ? ' + bearer key required' : ''}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
}

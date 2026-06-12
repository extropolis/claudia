/**
 * Test script: Stream text from SAP AI Core
 *
 * Mirrors the streaming pattern from /Users/I850333/experiments/conductor/backend/sap_aicore_model.py
 * (SAPAICoreStreamManager). Uses /invoke-with-response-stream endpoint and parses Bedrock-style SSE.
 *
 * Usage:
 *   cd backend
 *   npx tsx test-aicore-stream.ts "Tell me a short joke"
 *
 * Reads creds from env vars (loaded from conductor's .env if not already set):
 *   AICORE_AUTH_URL, AICORE_CLIENT_ID, AICORE_CLIENT_SECRET,
 *   AICORE_BASE_URL, AICORE_RESOURCE_GROUP, AICORE_DEPLOYMENT_ID
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// --- env loading -----------------------------------------------------------

function loadEnvFromConductor() {
  const conductorEnv = '/Users/I850333/experiments/conductor/.env';
  if (!fs.existsSync(conductorEnv)) return;
  const txt = fs.readFileSync(conductorEnv, 'utf-8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!k.startsWith('AICORE_')) continue;
    if (!process.env[k]) {
      // strip surrounding quotes if any
      process.env[k] = v.replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvFromConductor();

const cfg = {
  authUrl: process.env.AICORE_AUTH_URL!,
  clientId: process.env.AICORE_CLIENT_ID!,
  clientSecret: process.env.AICORE_CLIENT_SECRET!,
  baseUrl: process.env.AICORE_BASE_URL!,
  resourceGroup: process.env.AICORE_RESOURCE_GROUP || 'default',
  deploymentId: process.env.AICORE_DEPLOYMENT_ID!,
};

for (const [k, v] of Object.entries(cfg)) {
  if (!v) {
    console.error(`[fatal] missing env var for ${k}`);
    process.exit(1);
  }
}

// --- logging helper --------------------------------------------------------

const log = {
  info: (...a: any[]) => console.error('[info]', ...a),
  debug: (...a: any[]) => process.env.DEBUG && console.error('[debug]', ...a),
  warn: (...a: any[]) => console.error('[warn]', ...a),
  error: (...a: any[]) => console.error('[error]', ...a),
};

// --- token fetch -----------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now() / 1000;
  if (cachedToken && now < cachedToken.expiresAt - 300) {
    log.debug('reusing cached token, expires in', Math.round(cachedToken.expiresAt - now), 's');
    return cachedToken.token;
  }

  const base = cfg.authUrl.replace(/\/+$/, '');
  const tokenUrl = base.endsWith('/oauth/token') ? base : `${base}/oauth/token`;
  log.info('fetching access token from', tokenUrl);

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`token fetch failed: ${resp.status} ${t}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in,
  };
  log.info('token acquired, expires_in=', data.expires_in, 's');
  return cachedToken.token;
}

// --- streaming -------------------------------------------------------------

interface StreamEvent {
  type: string;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: any;
  usage?: any;
}

async function* streamMessage(prompt: string): AsyncGenerator<StreamEvent> {
  const token = await getAccessToken();

  const url = `${cfg.baseUrl}/v2/inference/deployments/${cfg.deploymentId}/invoke-with-response-stream`;
  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  };

  log.info('POST', url);
  log.debug('body', JSON.stringify(requestBody));

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'AI-Resource-Group': cfg.resourceGroup,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok || !resp.body) {
    const t = await resp.text();
    throw new Error(`stream request failed: ${resp.status} ${t}`);
  }

  log.info('stream connected, status=', resp.status);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let chunkCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunkCount++;
    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n');
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json.startsWith('{')) continue;
      try {
        const evt = JSON.parse(json) as StreamEvent;
        yield evt;
      } catch (e) {
        log.warn('failed to parse SSE line:', json.slice(0, 100));
      }
    }
  }

  // tail
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const json = tail.slice(5).trim();
    if (json.startsWith('{')) {
      try {
        yield JSON.parse(json) as StreamEvent;
      } catch {}
    }
  }

  log.info('stream complete, chunks=', chunkCount);
}

// --- main ------------------------------------------------------------------

async function main() {
  const prompt = process.argv.slice(2).join(' ').trim() ||
    'Write a short two-sentence haiku about streaming tokens.';

  log.info('prompt:', prompt);
  log.info('deployment:', cfg.deploymentId);
  log.info('-----');

  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let fullText = '';
  let stopReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const evt of streamMessage(prompt)) {
    log.debug('event:', evt.type, JSON.stringify(evt).slice(0, 200));

    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      const t = evt.delta.text || '';
      if (firstTokenAt === null) firstTokenAt = Date.now();
      fullText += t;
      process.stdout.write(t); // live stream to stdout
    } else if (evt.type === 'message_start' && evt.message?.usage) {
      inputTokens = evt.message.usage.input_tokens || 0;
    } else if (evt.type === 'message_delta') {
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      const u = (evt as any).usage;
      if (u?.output_tokens) outputTokens = u.output_tokens;
      if (u?.input_tokens) inputTokens = u.input_tokens;
    }
  }

  process.stdout.write('\n');
  const totalMs = Date.now() - startedAt;
  const ttftMs = firstTokenAt ? firstTokenAt - startedAt : -1;
  log.info('-----');
  log.info('stop_reason:', stopReason);
  log.info('chars:', fullText.length);
  log.info('input_tokens:', inputTokens, 'output_tokens:', outputTokens);
  log.info('time_to_first_token_ms:', ttftMs);
  log.info('total_ms:', totalMs);
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});

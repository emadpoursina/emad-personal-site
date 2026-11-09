/**
 * src/lib/ai-provider.mjs
 *
 * OpenAI-compatible chat completion provider adapter.
 * Formats requests, enforces a bounded timeout with AbortController,
 * maps failures to typed ProviderError instances, and guarantees
 * no credentials or upstream bodies leak into errors.
 */

import { getConfig } from './env.mjs';

/** Maximum permitted timeout in milliseconds. */
const MAX_TIMEOUT_MS = 30000;

/**
 * Error thrown when an upstream AI provider call fails or times out.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'upstream' | 'timeout', status?: number }} [options]
   */
  constructor(message, { kind, status } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    if (typeof status === 'number') {
      this.status = status;
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}

/**
 * Resolves the effective timeout capped at MAX_TIMEOUT_MS.
 *
 * @param {unknown} timeoutMs
 * @returns {number}
 */
function resolveTimeout(timeoutMs) {
  if (timeoutMs !== undefined && timeoutMs !== null) {
    const parsed = Number(timeoutMs);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_TIMEOUT_MS);
    }
  }
  let fromEnv = MAX_TIMEOUT_MS;
  try {
    const configVal = Number(getConfig()?.AI_TIMEOUT_MS);
    if (Number.isFinite(configVal) && configVal > 0) {
      fromEnv = configVal;
    }
  } catch {
    // Fall back to MAX_TIMEOUT_MS if config resolution fails
  }
  return Math.min(fromEnv, MAX_TIMEOUT_MS);
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {Array<{ role: string, content: string }>} params.messages
 * @param {number} [params.timeoutMs]
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<string>} Trimmed assistant answer string.
 */
export async function callProvider({
  baseUrl,
  apiKey,
  model,
  messages,
  timeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const cleanBaseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
  const endpoint = `${cleanBaseUrl}/chat/completions`;
  const effectiveTimeout = resolveTimeout(timeoutMs);

  const controller = new AbortController();
  let timer = null;
  let timedOut = false;

  try {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);

    let response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: 500,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut || controller.signal.aborted || err?.name === 'AbortError') {
        throw new ProviderError('AI provider request timed out', { kind: 'timeout' });
      }
      throw new ProviderError('AI provider network error', { kind: 'upstream' });
    }

    if (!response.ok) {
      try {
        await response.text?.();
      } catch {
        // Ignore upstream body consumption errors
      }
      throw new ProviderError(`AI provider returned HTTP ${response.status}`, {
        kind: 'upstream',
        status: response.status,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (timedOut || controller.signal.aborted || err?.name === 'AbortError') {
        throw new ProviderError('AI provider request timed out', { kind: 'timeout' });
      }
      throw new ProviderError('AI provider returned malformed JSON', {
        kind: 'upstream',
      });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ProviderError('AI provider returned empty or invalid content', {
        kind: 'upstream',
      });
    }

    return content.trim();
  } catch (err) {
    if (err instanceof ProviderError) {
      throw err;
    }
    if (timedOut || controller.signal.aborted || err?.name === 'AbortError') {
      throw new ProviderError('AI provider request timed out', { kind: 'timeout' });
    }
    throw new ProviderError('AI provider network error', { kind: 'upstream' });
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

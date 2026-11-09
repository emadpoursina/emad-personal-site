/**
 * src/lib/generator-provider.mjs
 *
 * Outbound adapter for the external cover-letter generator service.
 * Enforces bounded timeout with AbortController, formats requests,
 * validates responses, maps failures to typed GeneratorError instances,
 * and guarantees no secrets or request/upstream bodies leak into errors.
 */

const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 30000;

export const BANNED_PHRASES = [
  'I am writing to express my interest',
  'passionate',
  'dynamic',
  'synergy',
  'results-driven',
  'team player',
];

export const REQUIRED_WORK_AUTHORIZATION = 'Requires employer-sponsored work authorization.';
export const REQUIRED_SIGNOFF = 'Best regards, Emad Poursina';
export const MAX_CHARACTERS = 12000;

/**
 * Error thrown when an external cover-letter generator call fails or times out.
 */
export class GeneratorError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'upstream' | 'timeout', status?: number }} [options]
   */
  constructor(message, { kind, status } = {}) {
    super(message);
    this.name = 'GeneratorError';
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
 * Builds the outbound JSON payload object for the generator service.
 *
 * @param {object} profile Profile or candidate object with candidate facts.
 * @param {string} jobDescription Job description text.
 * @returns {object} Formatted request payload.
 */
export function buildGeneratorRequest(profile, jobDescription) {
  const p = profile ?? {};
  const links = p.links ?? {};
  return {
    job_description: typeof jobDescription === 'string' ? jobDescription.trim() : String(jobDescription ?? '').trim(),
    candidate: {
      name: p.name ?? '',
      headline: p.headline ?? '',
      work_authorization: p.workAuthorization ?? p.work_authorization ?? '',
      availability: p.availability ?? '',
      contact_email: p.contactEmail ?? p.contact_email ?? '',
      linkedin: links.linkedin ?? p.linkedin ?? '',
      github: links.github ?? p.github ?? '',
      bio: p.bio ?? '',
    },
    required: {
      work_authorization: REQUIRED_WORK_AUTHORIZATION,
      signoff: REQUIRED_SIGNOFF,
      banned_phrases: [...BANNED_PHRASES],
    },
    max_characters: MAX_CHARACTERS,
  };
}

/**
 * Validates and extracts the letter from an upstream generator response payload.
 *
 * @param {unknown} data Parsed JSON response body from upstream.
 * @returns {string} Trimmed letter string.
 * @throws {GeneratorError} If response is invalid, missing letter, empty, or exceeds 12000 chars.
 */
export function readGeneratorResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GeneratorError('Generator returned invalid response format', { kind: 'upstream' });
  }

  if (typeof data.letter !== 'string') {
    throw new GeneratorError('Generator response missing or invalid letter', { kind: 'upstream' });
  }

  const trimmed = data.letter.trim();
  if (trimmed.length === 0) {
    throw new GeneratorError('Generator response letter is empty', { kind: 'upstream' });
  }

  if (trimmed.length > MAX_CHARACTERS) {
    throw new GeneratorError('Generator response letter exceeds maximum length', { kind: 'upstream' });
  }

  return trimmed;
}

/**
 * Resolves effective timeout in milliseconds, bounded between 1 and MAX_TIMEOUT_MS.
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
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Calls the external cover-letter generator service.
 *
 * @param {object} params
 * @param {string} params.endpoint Target HTTP URL, called exactly as given.
 * @param {string} params.apiKey Bearer token for Authorization header.
 * @param {string} params.jobDescription Job description to tailor against.
 * @param {object} params.candidate Candidate profile data.
 * @param {number} [params.timeoutMs] Optional timeout in ms (capped at 30,000).
 * @param {typeof fetch} [params.fetchImpl] Injected fetch implementation.
 * @returns {Promise<string>} Trimmed tailored cover letter string.
 */
export async function callGenerator({
  endpoint,
  apiKey,
  jobDescription,
  candidate,
  timeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
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
          'Accept': 'application/json',
        },
        body: JSON.stringify(buildGeneratorRequest(candidate, jobDescription)),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut || controller.signal.aborted || err?.name === 'AbortError') {
        throw new GeneratorError('Generator request timed out', { kind: 'timeout' });
      }
      throw new GeneratorError('Generator network error', { kind: 'upstream' });
    }

    if (!response.ok) {
      try {
        await response.text?.();
      } catch {
        // Discard / ignore upstream body consumption errors
      }
      throw new GeneratorError(`Generator returned HTTP ${response.status}`, {
        kind: 'upstream',
        status: response.status,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (timedOut || controller.signal.aborted || err?.name === 'AbortError') {
        throw new GeneratorError('Generator request timed out', { kind: 'timeout' });
      }
      throw new GeneratorError('Generator returned malformed JSON', {
        kind: 'upstream',
      });
    }

    return readGeneratorResponse(data);
  } catch (err) {
    if (err instanceof GeneratorError) {
      throw err;
    }
    if (timedOut || controller.signal.aborted || err?.name === 'AbortError') {
      throw new GeneratorError('Generator request timed out', { kind: 'timeout' });
    }
    throw new GeneratorError('Generator network error', { kind: 'upstream' });
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

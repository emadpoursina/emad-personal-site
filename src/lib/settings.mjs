/**
 * src/lib/settings.mjs
 *
 * Effective settings resolver, validator, persistence, and masked view.
 * - Resolution per call (no cache): admin row -> env -> built-in default.
 * - URL and integer validation; single warning on invalid env fallback.
 * - Fails closed on secret decryption failure (warns once, no env fallback).
 * - saveSettings validates all 12 fields and applies changes atomically.
 */

import { getAllSettings, applySettings } from './db.mjs';
import { encryptSecret, decryptSecret, maskSecret } from './secrets.mjs';

/**
 * The 12 settings form fields mapped to their database key and type.
 */
export const SETTINGS_FIELDS = Object.freeze({
  aiBaseUrl: Object.freeze({ key: 'ai.baseUrl', type: 'non-secret' }),
  aiModel: Object.freeze({ key: 'ai.model', type: 'non-secret' }),
  aiApiKey: Object.freeze({ key: 'ai.apiKey', type: 'secret' }),
  askDailyCap: Object.freeze({ key: 'ask.dailyCap', type: 'non-secret' }),
  askRateLimitPerHour: Object.freeze({ key: 'ask.rateLimitPerHour', type: 'non-secret' }),
  smtpHost: Object.freeze({ key: 'smtp.host', type: 'non-secret' }),
  smtpPort: Object.freeze({ key: 'smtp.port', type: 'non-secret' }),
  smtpSecure: Object.freeze({ key: 'smtp.secure', type: 'non-secret' }),
  smtpUser: Object.freeze({ key: 'smtp.user', type: 'non-secret' }),
  smtpPass: Object.freeze({ key: 'smtp.pass', type: 'secret' }),
  smtpFrom: Object.freeze({ key: 'smtp.from', type: 'non-secret' }),
  generatorEndpoint: Object.freeze({ key: 'generator.endpoint', type: 'non-secret' }),
});

const ALLOWED_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Set of warning keys emitted to avoid duplicate logging */
const _warned = new Set();

/**
 * Emits console.warn at most once per key. Never logs secret or input values.
 * @param {string} key
 * @param {string} message
 */
function warnOnce(key, message) {
  if (!_warned.has(key)) {
    _warned.add(key);
    console.warn(`[settings] ${message}`);
  }
}

/**
 * Resets the warning set. Intended for tests.
 */
export function resetSettingsWarnings() {
  _warned.clear();
}

/**
 * Validates whether a raw string is a valid absolute URL according to settings rules:
 * - absolute URL, string length <= 500
 * - protocol must be https: or (http: only for localhost, 127.0.0.1, [::1])
 * - no username or password
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidUrl(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    if (ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname)) {
      return true;
    }
  }
  return false;
}

/**
 * Parses and validates an integer within inclusive bounds.
 * Accepts numbers or numeric strings.
 *
 * @param {unknown} val
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
function parseBoundedInt(val, min, max) {
  if (typeof val === 'number') {
    if (Number.isInteger(val) && val >= min && val <= max) {
      return val;
    }
    return null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isInteger(n) && n >= min && n <= max && String(n) === trimmed) {
        return n;
      }
    }
  }
  return null;
}

/**
 * Validates an email address.
 * @param {string} addr
 * @returns {boolean}
 */
function isValidEmailAddress(addr) {
  if (typeof addr !== 'string') return false;
  const trimmed = addr.trim();
  if (trimmed.length < 3 || trimmed.length > 320) return false;
  if (/\s/.test(trimmed)) return false;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) return false;
  if (trimmed.indexOf('@', atIndex + 1) !== -1) return false;
  const domain = trimmed.slice(atIndex + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

/**
 * Validates `addr` or `Name <addr>` format with length <= 320.
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidFrom(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;

  const match = trimmed.match(/^([^<>]*)<([^<>]+)>$/);
  if (match) {
    const addr = match[2].trim();
    return isValidEmailAddress(addr);
  }

  if (trimmed.includes('<') || trimmed.includes('>')) return false;
  return isValidEmailAddress(trimmed);
}

/**
 * Resolves effective values and their sources across admin rows, env vars, and defaults.
 * Evaluates per call without a persistent cache.
 */
function resolveSettings() {
  const adminRows = getAllSettings();

  const values = {};
  const sources = {};
  let decryptFailedAiApiKey = false;
  let decryptFailedSmtpPass = false;

  // 1. aiBaseUrl (URL)
  if (typeof adminRows['ai.baseUrl'] === 'string' && adminRows['ai.baseUrl'].trim() !== '') {
    values.aiBaseUrl = adminRows['ai.baseUrl'].trim().replace(/\/+$/, '');
    sources.aiBaseUrl = 'admin';
  } else if (typeof process.env.AI_BASE_URL === 'string' && process.env.AI_BASE_URL.trim() !== '') {
    const raw = process.env.AI_BASE_URL.trim();
    if (isValidUrl(raw)) {
      values.aiBaseUrl = raw.replace(/\/+$/, '');
      sources.aiBaseUrl = 'env';
    } else {
      warnOnce('AI_BASE_URL', 'Invalid AI_BASE_URL in environment; falling back to default.');
      values.aiBaseUrl = 'https://openrouter.ai/api/v1';
      sources.aiBaseUrl = 'default';
    }
  } else {
    values.aiBaseUrl = 'https://openrouter.ai/api/v1';
    sources.aiBaseUrl = 'default';
  }

  // 2. aiModel (string)
  if (typeof adminRows['ai.model'] === 'string' && adminRows['ai.model'].trim() !== '') {
    values.aiModel = adminRows['ai.model'].trim();
    sources.aiModel = 'admin';
  } else if (typeof process.env.AI_MODEL === 'string' && process.env.AI_MODEL.trim() !== '') {
    values.aiModel = process.env.AI_MODEL.trim();
    sources.aiModel = 'env';
  } else {
    values.aiModel = 'anthropic/claude-haiku-5.5';
    sources.aiModel = 'default';
  }

  // 3. aiApiKey (secret)
  if (typeof adminRows['ai.apiKey'] === 'string' && adminRows['ai.apiKey'].trim() !== '') {
    sources.aiApiKey = 'admin';
    try {
      values.aiApiKey = decryptSecret(adminRows['ai.apiKey']);
    } catch {
      warnOnce('aiApiKey', 'Failed to decrypt AI API key; failing closed.');
      values.aiApiKey = '';
      decryptFailedAiApiKey = true;
    }
  } else if (typeof process.env.AI_API_KEY === 'string' && process.env.AI_API_KEY.trim() !== '') {
    values.aiApiKey = process.env.AI_API_KEY;
    sources.aiApiKey = 'env';
  } else {
    values.aiApiKey = '';
    sources.aiApiKey = 'default';
  }

  // 4. askDailyCap (integer 1-100000)
  if (typeof adminRows['ask.dailyCap'] === 'string' && adminRows['ask.dailyCap'].trim() !== '') {
    values.askDailyCap = parseInt(adminRows['ask.dailyCap'], 10);
    sources.askDailyCap = 'admin';
  } else if (typeof process.env.ASK_DAILY_CAP === 'string' && process.env.ASK_DAILY_CAP.trim() !== '') {
    const n = parseBoundedInt(process.env.ASK_DAILY_CAP.trim(), 1, 100000);
    if (n !== null) {
      values.askDailyCap = n;
      sources.askDailyCap = 'env';
    } else {
      warnOnce('ASK_DAILY_CAP', 'Invalid ASK_DAILY_CAP in environment; falling back to default.');
      values.askDailyCap = 200;
      sources.askDailyCap = 'default';
    }
  } else {
    values.askDailyCap = 200;
    sources.askDailyCap = 'default';
  }

  // 5. askRateLimitPerHour (integer 1-1000)
  if (typeof adminRows['ask.rateLimitPerHour'] === 'string' && adminRows['ask.rateLimitPerHour'].trim() !== '') {
    values.askRateLimitPerHour = parseInt(adminRows['ask.rateLimitPerHour'], 10);
    sources.askRateLimitPerHour = 'admin';
  } else if (typeof process.env.ASK_RATE_LIMIT_PER_HOUR === 'string' && process.env.ASK_RATE_LIMIT_PER_HOUR.trim() !== '') {
    const n = parseBoundedInt(process.env.ASK_RATE_LIMIT_PER_HOUR.trim(), 1, 1000);
    if (n !== null) {
      values.askRateLimitPerHour = n;
      sources.askRateLimitPerHour = 'env';
    } else {
      warnOnce('ASK_RATE_LIMIT_PER_HOUR', 'Invalid ASK_RATE_LIMIT_PER_HOUR in environment; falling back to default.');
      values.askRateLimitPerHour = 10;
      sources.askRateLimitPerHour = 'default';
    }
  } else {
    values.askRateLimitPerHour = 10;
    sources.askRateLimitPerHour = 'default';
  }

  // 6. smtpHost (string)
  if (typeof adminRows['smtp.host'] === 'string' && adminRows['smtp.host'].trim() !== '') {
    values.smtpHost = adminRows['smtp.host'];
    sources.smtpHost = 'admin';
  } else if (typeof process.env.SMTP_HOST === 'string' && process.env.SMTP_HOST.trim() !== '') {
    values.smtpHost = process.env.SMTP_HOST;
    sources.smtpHost = 'env';
  } else {
    values.smtpHost = '';
    sources.smtpHost = 'default';
  }

  // 7. smtpPort (integer 1-65535)
  if (typeof adminRows['smtp.port'] === 'string' && adminRows['smtp.port'].trim() !== '') {
    values.smtpPort = parseInt(adminRows['smtp.port'], 10);
    sources.smtpPort = 'admin';
  } else if (typeof process.env.SMTP_PORT === 'string' && process.env.SMTP_PORT.trim() !== '') {
    const n = parseBoundedInt(process.env.SMTP_PORT.trim(), 1, 65535);
    if (n !== null) {
      values.smtpPort = n;
      sources.smtpPort = 'env';
    } else {
      warnOnce('SMTP_PORT', 'Invalid SMTP_PORT in environment; falling back to default.');
      values.smtpPort = 587;
      sources.smtpPort = 'default';
    }
  } else {
    values.smtpPort = 587;
    sources.smtpPort = 'default';
  }

  // 8. smtpSecure (boolean)
  if (typeof adminRows['smtp.secure'] === 'string' && adminRows['smtp.secure'].trim() !== '') {
    values.smtpSecure = adminRows['smtp.secure'] === 'true';
    sources.smtpSecure = 'admin';
  } else if (typeof process.env.SMTP_SECURE === 'string' && process.env.SMTP_SECURE.trim() !== '') {
    values.smtpSecure = process.env.SMTP_SECURE.trim().toLowerCase() === 'true';
    sources.smtpSecure = 'env';
  } else {
    values.smtpSecure = false;
    sources.smtpSecure = 'default';
  }

  // 9. smtpUser (string)
  if (typeof adminRows['smtp.user'] === 'string' && adminRows['smtp.user'].trim() !== '') {
    values.smtpUser = adminRows['smtp.user'];
    sources.smtpUser = 'admin';
  } else if (typeof process.env.SMTP_USER === 'string' && process.env.SMTP_USER.trim() !== '') {
    values.smtpUser = process.env.SMTP_USER;
    sources.smtpUser = 'env';
  } else {
    values.smtpUser = '';
    sources.smtpUser = 'default';
  }

  // 10. smtpPass (secret)
  if (typeof adminRows['smtp.pass'] === 'string' && adminRows['smtp.pass'].trim() !== '') {
    sources.smtpPass = 'admin';
    try {
      values.smtpPass = decryptSecret(adminRows['smtp.pass']);
    } catch {
      warnOnce('smtpPass', 'Failed to decrypt SMTP password; failing closed.');
      values.smtpPass = '';
      decryptFailedSmtpPass = true;
    }
  } else if (typeof process.env.SMTP_PASS === 'string' && process.env.SMTP_PASS.trim() !== '') {
    values.smtpPass = process.env.SMTP_PASS;
    sources.smtpPass = 'env';
  } else {
    values.smtpPass = '';
    sources.smtpPass = 'default';
  }

  // 11. smtpFrom (string)
  if (typeof adminRows['smtp.from'] === 'string' && adminRows['smtp.from'].trim() !== '') {
    values.smtpFrom = adminRows['smtp.from'];
    sources.smtpFrom = 'admin';
  } else if (typeof process.env.SMTP_FROM === 'string' && process.env.SMTP_FROM.trim() !== '') {
    values.smtpFrom = process.env.SMTP_FROM;
    sources.smtpFrom = 'env';
  } else {
    values.smtpFrom = 'Emad Poursina <emad.poursina.work@gmail.com>';
    sources.smtpFrom = 'default';
  }

  // 12. generatorEndpoint (URL)
  if (typeof adminRows['generator.endpoint'] === 'string' && adminRows['generator.endpoint'].trim() !== '') {
    values.generatorEndpoint = adminRows['generator.endpoint'].trim().replace(/\/+$/, '');
    sources.generatorEndpoint = 'admin';
  } else if (typeof process.env.GENERATOR_ENDPOINT === 'string' && process.env.GENERATOR_ENDPOINT.trim() !== '') {
    const raw = process.env.GENERATOR_ENDPOINT.trim();
    if (isValidUrl(raw)) {
      values.generatorEndpoint = raw.replace(/\/+$/, '');
      sources.generatorEndpoint = 'env';
    } else {
      warnOnce('GENERATOR_ENDPOINT', 'Invalid GENERATOR_ENDPOINT in environment; falling back to default.');
      values.generatorEndpoint = '';
      sources.generatorEndpoint = 'default';
    }
  } else {
    values.generatorEndpoint = '';
    sources.generatorEndpoint = 'default';
  }

  const aiConfigured = !decryptFailedAiApiKey && Boolean(values.aiBaseUrl && values.aiModel && values.aiApiKey);
  const hasApiKey = !decryptFailedAiApiKey && Boolean(values.aiApiKey);
  const hasSmtpPass = !decryptFailedSmtpPass && Boolean(values.smtpPass);

  return {
    values,
    sources,
    aiConfigured,
    hasApiKey,
    hasSmtpPass,
    decryptFailedAiApiKey,
    decryptFailedSmtpPass,
  };
}

/**
 * Returns a flat object with all 12 effective settings values plus aiConfigured.
 * Resolution precedence: admin row -> environment variable -> built-in default.
 *
 * @returns {{
 *   aiBaseUrl: string;
 *   aiModel: string;
 *   aiApiKey: string;
 *   askDailyCap: number;
 *   askRateLimitPerHour: number;
 *   smtpHost: string;
 *   smtpPort: number;
 *   smtpSecure: boolean;
 *   smtpUser: string;
 *   smtpPass: string;
 *   smtpFrom: string;
 *   generatorEndpoint: string;
 *   aiConfigured: boolean;
 * }}
 */
export function getEffectiveSettings() {
  const { values, aiConfigured } = resolveSettings();
  return {
    aiBaseUrl: values.aiBaseUrl,
    aiModel: values.aiModel,
    aiApiKey: values.aiApiKey,
    askDailyCap: values.askDailyCap,
    askRateLimitPerHour: values.askRateLimitPerHour,
    smtpHost: values.smtpHost,
    smtpPort: values.smtpPort,
    smtpSecure: values.smtpSecure,
    smtpUser: values.smtpUser,
    smtpPass: values.smtpPass,
    smtpFrom: values.smtpFrom,
    generatorEndpoint: values.generatorEndpoint,
    aiConfigured,
  };
}

/**
 * Returns effective SMTP settings: { host, port, secure, user, pass, from, enabled }.
 * enabled is true when host, user, and pass are present and decryptable.
 *
 * @returns {{
 *   host: string;
 *   port: number;
 *   secure: boolean;
 *   user: string;
 *   pass: string;
 *   from: string;
 *   enabled: boolean;
 * }}
 */
export function getEffectiveSmtp() {
  const { values, decryptFailedSmtpPass } = resolveSettings();
  const enabled = !decryptFailedSmtpPass && Boolean(values.smtpHost && values.smtpUser && values.smtpPass);
  return {
    host: values.smtpHost,
    port: values.smtpPort,
    secure: values.smtpSecure,
    user: values.smtpUser,
    pass: values.smtpPass,
    from: values.smtpFrom,
    enabled,
  };
}

/**
 * Returns the masked view of settings suitable for administrative UI and JSON responses.
 * Never includes full secret plaintext.
 *
 * @returns {{
 *   aiBaseUrl: string;
 *   aiModel: string;
 *   askDailyCap: number;
 *   askRateLimitPerHour: number;
 *   smtpHost: string;
 *   smtpPort: number;
 *   smtpSecure: boolean;
 *   smtpUser: string;
 *   smtpFrom: string;
 *   generatorEndpoint: string;
 *   hasApiKey: boolean;
 *   hasSmtpPass: boolean;
 *   apiKeyMasked: string;
 *   smtpPassMasked: string;
 *   aiConfigured: boolean;
 *   sources: Record<string, 'admin' | 'env' | 'default'>;
 * }}
 */
export function getMaskedSettings() {
  const { values, sources, aiConfigured, hasApiKey, hasSmtpPass } = resolveSettings();
  return {
    aiBaseUrl: values.aiBaseUrl,
    aiModel: values.aiModel,
    askDailyCap: values.askDailyCap,
    askRateLimitPerHour: values.askRateLimitPerHour,
    smtpHost: values.smtpHost,
    smtpPort: values.smtpPort,
    smtpSecure: values.smtpSecure,
    smtpUser: values.smtpUser,
    smtpFrom: values.smtpFrom,
    generatorEndpoint: values.generatorEndpoint,
    hasApiKey,
    hasSmtpPass,
    apiKeyMasked: hasApiKey ? maskSecret(values.aiApiKey) : '',
    smtpPassMasked: hasSmtpPass ? maskSecret(values.smtpPass) : '',
    aiConfigured,
    sources,
  };
}

/**
 * Validates and saves settings input in a single atomic transaction.
 *
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true } | { ok: false; errors: Record<string, string> }}
 */
export function saveSettings(input) {
  const data = input && typeof input === 'object' ? input : {};
  const errors = {};
  const sets = {};
  const deletes = [];

  // 1. aiBaseUrl
  if ('aiBaseUrl' in data) {
    const val = data.aiBaseUrl;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('ai.baseUrl');
    } else {
      const raw = typeof val === 'string' ? val.trim() : String(val).trim();
      if (!isValidUrl(raw)) {
        errors.aiBaseUrl = 'Enter an HTTPS base URL (localhost may use HTTP).';
      } else {
        sets['ai.baseUrl'] = raw.replace(/\/+$/, '');
      }
    }
  }

  // 2. aiModel
  if ('aiModel' in data) {
    const val = data.aiModel;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('ai.model');
    } else {
      const raw = typeof val === 'string' ? val.trim() : String(val).trim();
      if (raw.length === 0 || raw.length > 200 || /[\u0000-\u001F\u007F]/.test(raw)) {
        errors.aiModel = 'Enter a model ID.';
      } else {
        sets['ai.model'] = raw;
      }
    }
  }

  // 3. aiApiKey (secret)
  if ('aiApiKey' in data) {
    const val = data.aiApiKey;
    if (val !== undefined && val !== null && val !== '') {
      const raw = typeof val === 'string' ? val : String(val);
      if (raw.length < 1 || raw.length > 4096 || /[\u0000-\u001F\u007F]/.test(raw)) {
        errors.aiApiKey = 'Enter a valid API key.';
      } else {
        try {
          sets['ai.apiKey'] = encryptSecret(raw);
        } catch {
          errors.aiApiKey = 'Secret storage is unavailable.';
        }
      }
    }
  }

  // 4. askDailyCap
  if ('askDailyCap' in data) {
    const val = data.askDailyCap;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('ask.dailyCap');
    } else {
      const n = parseBoundedInt(val, 1, 100000);
      if (n === null) {
        errors.askDailyCap = 'Daily cap must be a whole number between 1 and 100000.';
      } else {
        sets['ask.dailyCap'] = String(n);
      }
    }
  }

  // 5. askRateLimitPerHour
  if ('askRateLimitPerHour' in data) {
    const val = data.askRateLimitPerHour;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('ask.rateLimitPerHour');
    } else {
      const n = parseBoundedInt(val, 1, 1000);
      if (n === null) {
        errors.askRateLimitPerHour = 'Rate limit must be a whole number between 1 and 1000.';
      } else {
        sets['ask.rateLimitPerHour'] = String(n);
      }
    }
  }

  // 6. smtpHost
  if ('smtpHost' in data) {
    const val = data.smtpHost;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('smtp.host');
    } else {
      const raw = typeof val === 'string' ? val : String(val);
      if (raw.length > 255 || /\s/.test(raw) || /[\u0000-\u001F\u007F]/.test(raw)) {
        errors.smtpHost = 'Enter a valid SMTP host.';
      } else {
        sets['smtp.host'] = raw;
      }
    }
  }

  // 7. smtpPort
  if ('smtpPort' in data) {
    const val = data.smtpPort;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('smtp.port');
    } else {
      const n = parseBoundedInt(val, 1, 65535);
      if (n === null) {
        errors.smtpPort = 'Port must be between 1 and 65535.';
      } else {
        sets['smtp.port'] = String(n);
      }
    }
  }

  // 8. smtpSecure (checkbox/boolean: present/truthy -> true, absent/falsy -> false)
  const isSecure = data.smtpSecure === true || data.smtpSecure === 'true' || data.smtpSecure === 'on' || data.smtpSecure === 1 || data.smtpSecure === '1';
  sets['smtp.secure'] = isSecure ? 'true' : 'false';

  // 9. smtpUser
  if ('smtpUser' in data) {
    const val = data.smtpUser;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('smtp.user');
    } else {
      const raw = typeof val === 'string' ? val : String(val);
      if (raw.length > 320 || /[\u0000-\u001F\u007F]/.test(raw)) {
        errors.smtpUser = 'Enter a valid SMTP username.';
      } else {
        sets['smtp.user'] = raw;
      }
    }
  }

  // 10. smtpPass (secret)
  if ('smtpPass' in data) {
    const val = data.smtpPass;
    if (val !== undefined && val !== null && val !== '') {
      const raw = typeof val === 'string' ? val : String(val);
      if (raw.length < 1 || raw.length > 1024 || /[\u0000-\u001F\u007F]/.test(raw)) {
        errors.smtpPass = 'Enter a valid SMTP password.';
      } else {
        try {
          sets['smtp.pass'] = encryptSecret(raw);
        } catch {
          errors.smtpPass = 'Secret storage is unavailable.';
        }
      }
    }
  }

  // 11. smtpFrom
  if ('smtpFrom' in data) {
    const val = data.smtpFrom;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('smtp.from');
    } else {
      const raw = typeof val === 'string' ? val.trim() : String(val).trim();
      if (!isValidFrom(raw)) {
        errors.smtpFrom = 'Enter a valid from address.';
      } else {
        sets['smtp.from'] = raw;
      }
    }
  }

  // 12. generatorEndpoint
  if ('generatorEndpoint' in data) {
    const val = data.generatorEndpoint;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      deletes.push('generator.endpoint');
    } else {
      const raw = typeof val === 'string' ? val.trim() : String(val).trim();
      if (!isValidUrl(raw)) {
        errors.generatorEndpoint = 'Enter an HTTPS endpoint (localhost may use HTTP).';
      } else {
        sets['generator.endpoint'] = raw.replace(/\/+$/, '');
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  applySettings(sets, deletes);
  return { ok: true };
}

/**
 * tests/ask-service.test.mjs
 *
 * Unit tests for src/lib/ask-service.mjs.
 * Strictly uses injected stubs for db, settings, limits, and provider.
 * Guarantees zero network calls and no touch of the SQLite database file.
 * Run with: node --experimental-sqlite --test tests/ask-service.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestion, processAsk } from '../src/lib/ask-service.mjs';
import { ProviderError } from '../src/lib/ai-provider.mjs';
import { loadProfile } from '../src/lib/profile.mjs';

// ---------------------------------------------------------------------------
// Test helpers and stubs
// ---------------------------------------------------------------------------

function createStubDb({ throwOnInsert = false } = {}) {
  const questions = [];
  return {
    insertQuestion(q) {
      if (throwOnInsert) {
        throw new Error('disk failure');
      }
      questions.push(q);
      return questions.length;
    },
    _questions: questions,
  };
}

function createStubSettings({
  aiConfigured = true,
  aiModel = 'stub-model',
  aiApiKey = 'k-large-secret-value',
  aiBaseUrl = 'https://api.example.com/v1',
  askDailyCap = 200,
  askRateLimitPerHour = 10,
} = {}) {
  return {
    getEffectiveSettings: () => ({
      aiConfigured,
      aiModel,
      aiApiKey,
      aiBaseUrl,
      askDailyCap,
      askRateLimitPerHour,
    }),
  };
}

function createStubProvider({ answer = 'Grounded answer.', error = null } = {}) {
  const calls = [];
  return {
    async call(args) {
      calls.push(args);
      if (error) {
        throw error;
      }
      return answer;
    },
    _calls: calls,
  };
}

function createStubLimits({
  ipAllowed = true,
  retryAfterSeconds = 0,
  dailyAllowed = true,
  throwDaily = false,
} = {}) {
  const ipCalls = [];
  const dailyCalls = [];
  return {
    checkPerIp: (key, limit) => {
      ipCalls.push({ key, limit });
      return { allowed: ipAllowed, retryAfterSeconds };
    },
    consumeDaily: (db, day, cap) => {
      if (throwDaily) throw new Error('storage error');
      dailyCalls.push({ day, cap });
      return { allowed: dailyAllowed };
    },
    _ipCalls: ipCalls,
    _dailyCalls: dailyCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateQuestion', () => {
  test('missing, non-object, non-string, empty, whitespace -> Question is required.', () => {
    const invalidInputs = [
      null,
      undefined,
      [],
      [1, 2, 3],
      'just a string',
      12345,
      true,
      {},
      { question: null },
      { question: undefined },
      { question: 123 },
      { question: true },
      { question: {} },
      { question: [] },
      { question: '' },
      { question: '   ' },
      { question: ' \t\n\r ' },
    ];

    for (const input of invalidInputs) {
      const result = validateQuestion(input);
      assert.equal(result.ok, false, `Expected failure for input: ${JSON.stringify(input)}`);
      assert.deepEqual(result.errors, { question: 'Question is required.' });
    }
  });

  test('1000 characters is accepted and trimmed', () => {
    const q1000 = 'a'.repeat(1000);
    const rawWithSpaces = `   ${q1000}   `;
    const result = validateQuestion({ question: rawWithSpaces });
    assert.equal(result.ok, true);
    assert.equal(result.question, q1000);
    assert.equal(result.question.length, 1000);
  });

  test('1001 characters -> Question must be 1,000 characters or fewer.', () => {
    const q1001 = 'b'.repeat(1001);
    const result = validateQuestion({ question: q1001 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, {
      question: 'Question must be 1,000 characters or fewer.',
    });

    const trimmed1001 = `  ${q1001}  `;
    const resultTrimmed = validateQuestion({ question: trimmed1001 });
    assert.equal(resultTrimmed.ok, false);
    assert.deepEqual(resultTrimmed.errors, {
      question: 'Question must be 1,000 characters or fewer.',
    });
  });
});

describe('processAsk - unconfigured', () => {
  test('settings stub aiConfigured:false -> 503 unconfigured + exact message + provider calls 0', async () => {
    const settings = createStubSettings({ aiConfigured: false, aiApiKey: '' });
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: 'What is Emad’s experience?' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 503);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'unconfigured',
      message: 'The assistant is unavailable right now',
    });
    assert.equal(provider._calls.length, 0);
    assert.equal(db._questions.length, 0);
    assert.equal(limits._dailyCalls.length, 0);
  });
});

describe('processAsk - policy rules', () => {
  const profile = loadProfile();

  test('salary question -> 200, answer === profile.assistantPolicy.salary, no digit, sources deep-equal [{label: Contact, href: /contact}], disclaimer exact', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: 'What is your expected salary?' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.answer, profile.assistantPolicy.salary);
    assert.equal(/\d/.test(result.payload.answer), false);
    assert.deepEqual(result.payload.sources, [{ label: 'Contact', href: '/contact' }]);
    assert.equal(
      result.payload.disclaimer,
      'AI assistant. The CV and case studies are the source of record.'
    );
    assert.equal(result.payload.model, 'stub-model');
    assert.equal(provider._calls.length, 0);
  });

  test('visa question -> answer contains "Requires employer-sponsored work authorization.", sources /contact', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: 'What visa do you need for Canada or the UK?' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.ok(
      result.payload.answer.includes('Requires employer-sponsored work authorization.'),
      `Expected answer to contain authorization string, got: "${result.payload.answer}"`
    );
    assert.deepEqual(result.payload.sources, [{ label: 'Contact', href: '/contact' }]);
    assert.equal(provider._calls.length, 0);
  });

  test('"Show me the VoiceDash source code" -> answer contains "That codebase is private." and "/case-studies", sources [\'/case-studies\', \'/contact\']', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: 'Show me the VoiceDash source code' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.ok(
      result.payload.answer.includes('That codebase is private.'),
      `Expected answer to contain "That codebase is private.", got: "${result.payload.answer}"`
    );
    assert.ok(
      result.payload.answer.includes('/case-studies'),
      `Expected answer to contain "/case-studies", got: "${result.payload.answer}"`
    );
    assert.deepEqual(
      result.payload.sources.map((s) => s.href),
      ['/case-studies', '/contact']
    );
    assert.equal(provider._calls.length, 0);
  });
});

describe('processAsk - success', () => {
  const HREF_ALLOW_REGEX =
    /^\/(about(#(summary|experience|skills|education|languages))?|contact|case-studies\/[a-z0-9-]+)$/;

  test('configured settings, valid question -> 200, answer, exact disclaimer, valid sources including /about#skills, model, provider called correctly', async () => {
    const settings = createStubSettings({
      aiModel: 'stub-model',
      aiApiKey: 'k-large-secret-value',
      aiBaseUrl: 'https://api.example.com/v1',
    });
    const provider = createStubProvider({ answer: 'Grounded answer.' });
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: "What is Emad's Node.js experience?" },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.answer, 'Grounded answer.');
    assert.equal(
      result.payload.disclaimer,
      'AI assistant. The CV and case studies are the source of record.'
    );
    assert.equal(result.payload.model, 'stub-model');
    assert.ok(Array.isArray(result.payload.sources) && result.payload.sources.length > 0);

    for (const source of result.payload.sources) {
      assert.match(source.href, HREF_ALLOW_REGEX);
      assert.ok(typeof source.label === 'string' && source.label.length > 0);
    }

    assert.ok(
      result.payload.sources.some((s) => s.href === '/about#skills'),
      'Expected sources to include /about#skills'
    );

    assert.equal(provider._calls.length, 1);
    const [callArgs] = provider._calls;
    assert.equal(callArgs.baseUrl, 'https://api.example.com/v1');
    assert.equal(callArgs.apiKey, 'k-large-secret-value');
    assert.equal(callArgs.model, 'stub-model');
    assert.deepEqual(
      callArgs.messages.map((m) => m.role),
      ['system', 'user']
    );
  });

  test('"Tell me about the Rousta TV case study" -> sources include \'/case-studies/rousta-tv\'', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({ answer: 'Rousta TV details.' });
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: 'Tell me about the Rousta TV case study' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 200);
    assert.ok(
      result.payload.sources.some((s) => s.href === '/case-studies/rousta-tv'),
      'Expected sources to include /case-studies/rousta-tv'
    );
  });
});

describe('processAsk - question logging', () => {
  test('insertQuestion called once with the trimmed question; a throwing insertQuestion still yields 200', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: '   What are your best skills?   ' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 200);
    assert.deepEqual(db._questions, ['What are your best skills?']);

    // Throwing db
    const failingDb = createStubDb({ throwOnInsert: true });
    const failResult = await processAsk(
      { question: 'What are your best skills?' },
      '192.168.1.1',
      { settings, provider, db: failingDb, limits }
    );

    assert.equal(failResult.status, 200);
    assert.equal(failResult.payload.ok, true);
  });
});

describe('processAsk - secret confidentiality', () => {
  test('JSON.stringify(payload) excludes "k-large-secret-value" and "APPROVED PROFILE CONTEXT" for success and error payloads', async () => {
    const settings = createStubSettings({
      aiApiKey: 'k-large-secret-value',
    });
    const provider = createStubProvider({ answer: 'Valid answer.' });
    const db = createStubDb();
    const limits = createStubLimits();

    // 1. Success payload
    const successRes = await processAsk(
      { question: "What is Emad's background?" },
      '127.0.0.1',
      { settings, provider, db, limits }
    );
    const successJson = JSON.stringify(successRes.payload);
    assert.equal(successJson.includes('k-large-secret-value'), false);
    assert.equal(successJson.includes('APPROVED PROFILE CONTEXT'), false);

    // 2. Validation error payload (400)
    const valRes = await processAsk({}, '127.0.0.1', { settings, provider, db, limits });
    const valJson = JSON.stringify(valRes.payload);
    assert.equal(valJson.includes('k-large-secret-value'), false);
    assert.equal(valJson.includes('APPROVED PROFILE CONTEXT'), false);

    // 3. Rate limited payload (429)
    const rlLimits = createStubLimits({ ipAllowed: false, retryAfterSeconds: 60 });
    const rlRes = await processAsk(
      { question: 'Q' },
      '127.0.0.1',
      { settings, provider, db, limits: rlLimits }
    );
    const rlJson = JSON.stringify(rlRes.payload);
    assert.equal(rlJson.includes('k-large-secret-value'), false);
    assert.equal(rlJson.includes('APPROVED PROFILE CONTEXT'), false);

    // 4. Daily cap payload (429)
    const capLimits = createStubLimits({ dailyAllowed: false });
    const capRes = await processAsk(
      { question: 'Q' },
      '127.0.0.1',
      { settings, provider, db, limits: capLimits }
    );
    const capJson = JSON.stringify(capRes.payload);
    assert.equal(capJson.includes('k-large-secret-value'), false);
    assert.equal(capJson.includes('APPROVED PROFILE CONTEXT'), false);

    // 5. Unconfigured payload (503)
    const unconfSettings = createStubSettings({ aiConfigured: false });
    const unconfRes = await processAsk(
      { question: 'Q' },
      '127.0.0.1',
      { settings: unconfSettings, provider, db, limits }
    );
    const unconfJson = JSON.stringify(unconfRes.payload);
    assert.equal(unconfJson.includes('k-large-secret-value'), false);
    assert.equal(unconfJson.includes('APPROVED PROFILE CONTEXT'), false);

    // 6. Provider upstream error payload (502)
    const upstreamProvider = createStubProvider({
      error: new ProviderError('Upstream secret dump with k-large-secret-value', {
        kind: 'upstream',
      }),
    });
    const upstreamRes = await processAsk(
      { question: 'Q' },
      '127.0.0.1',
      { settings, provider: upstreamProvider, db, limits }
    );
    const upstreamJson = JSON.stringify(upstreamRes.payload);
    assert.equal(upstreamJson.includes('k-large-secret-value'), false);
    assert.equal(upstreamJson.includes('APPROVED PROFILE CONTEXT'), false);

    // 7. Provider timeout error payload (504)
    const timeoutProvider = createStubProvider({
      error: new ProviderError('Timeout secret dump with k-large-secret-value', {
        kind: 'timeout',
      }),
    });
    const timeoutRes = await processAsk(
      { question: 'Q' },
      '127.0.0.1',
      { settings, provider: timeoutProvider, db, limits }
    );
    const timeoutJson = JSON.stringify(timeoutRes.payload);
    assert.equal(timeoutJson.includes('k-large-secret-value'), false);
    assert.equal(timeoutJson.includes('APPROVED PROFILE CONTEXT'), false);
  });
});

describe('processAsk - provider error mapping', () => {
  test('ProviderError kind "upstream" -> 502 exact provider_error message; neither payload contains thrown message text', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({
      error: new ProviderError('Upstream internal 500 error body text', {
        kind: 'upstream',
        status: 500,
      }),
    });
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: "What is Emad's background?" },
      '127.0.0.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 502);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'provider_error',
      message:
        'The assistant could not answer right now. Please try again later or use the contact form.',
    });
    assert.equal(JSON.stringify(result.payload).includes('Upstream internal 500 error body text'), false);
  });

  test('ProviderError kind "timeout" -> 504 exact timeout message; neither payload contains thrown message text', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({
      error: new ProviderError('Connection timed out after 30000ms', {
        kind: 'timeout',
      }),
    });
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: "What is Emad's background?" },
      '127.0.0.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 504);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'timeout',
      message:
        'The assistant took too long to answer. Please try again or use the contact form.',
    });
    assert.equal(JSON.stringify(result.payload).includes('Connection timed out after 30000ms'), false);
  });
});

describe('processAsk - limits and storage errors', () => {
  test('per-IP rate limiting -> 429 rate_limited with retryAfterSeconds', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits({ ipAllowed: false, retryAfterSeconds: 3600 });

    const result = await processAsk(
      { question: 'Valid question?' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 429);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'rate_limited',
      message: 'Too many questions from this address. Please try again later.',
      retryAfterSeconds: 3600,
    });
    assert.equal(provider._calls.length, 0);
    assert.equal(db._questions.length, 0);
  });

  test('per-IP gate runs before validation with ipAllowed:false and input {}', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits({ ipAllowed: false });

    const result = await processAsk({}, '1.2.3.4', { settings, provider, db, limits });

    assert.equal(result.status, 429);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'rate_limited',
      message: 'Too many questions from this address. Please try again later.',
      retryAfterSeconds: 0,
    });
    assert.deepEqual(limits._ipCalls[0], { key: '1.2.3.4', limit: 10 });
    assert.equal(provider._calls.length, 0);
    assert.equal(db._questions.length, 0);
  });

  test('invalid question records one checkPerIp call then returns 400 with no daily consume and no question log', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: '   ' },
      '1.2.3.4',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 400);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'validation',
      message: 'Question is required.',
      errors: { question: 'Question is required.' },
    });
    assert.equal(limits._ipCalls.length, 1);
    assert.deepEqual(limits._ipCalls[0], { key: '1.2.3.4', limit: 10 });
    assert.equal(limits._dailyCalls.length, 0);
    assert.equal(db._questions.length, 0);
  });

  test('effective limit from settings (askRateLimitPerHour: 25) is passed to checkPerIp', async () => {
    const settings = createStubSettings({ askRateLimitPerHour: 25 });
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();

    const result = await processAsk(
      { question: 'Valid question?' },
      '1.2.3.4',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 200);
    assert.equal(limits._ipCalls.length, 1);
    assert.deepEqual(limits._ipCalls[0], { key: '1.2.3.4', limit: 25 });
  });

  test('with injected now and askDailyCap 7, daily call receives exactly {day: "2026-11-09", cap: 7}', async () => {
    const settings = createStubSettings({ askDailyCap: 7 });
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits();
    const now = () => new Date('2026-11-09T23:30:00Z');

    const result = await processAsk(
      { question: 'Valid question?' },
      '1.2.3.4',
      { settings, provider, db, limits, now }
    );

    assert.equal(result.status, 200);
    assert.equal(limits._dailyCalls.length, 1);
    assert.deepEqual(limits._dailyCalls[0], { day: '2026-11-09', cap: 7 });
  });

  test('daily cap exceeded -> 429 daily_cap with paused message', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits({ dailyAllowed: false });

    const result = await processAsk(
      { question: 'Valid question?' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 429);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'daily_cap',
      message:
        'The assistant is paused for today. Please try again tomorrow or use the contact form.',
    });
    assert.equal(provider._calls.length, 0);
    assert.equal(db._questions.length, 1);
  });

  test('daily counter storage error -> 503 storage with unavailable message', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider();
    const db = createStubDb();
    const limits = createStubLimits({ throwDaily: true });

    const result = await processAsk(
      { question: 'Valid question?' },
      '192.168.1.1',
      { settings, provider, db, limits }
    );

    assert.equal(result.status, 503);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'storage',
      message: 'The assistant is unavailable right now',
    });
    assert.equal(provider._calls.length, 0);
    assert.equal(db._questions.length, 1);
  });
});

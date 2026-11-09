/**
 * tests/cover-letter-service.test.mjs
 *
 * Unit tests for src/lib/cover-letter-service.mjs.
 * Strictly uses injected stubs for db, settings, limits, provider, now, profile, and letterDoc.
 * Guarantees zero network calls and no touch of the SQLite database file.
 * Run with: node --experimental-sqlite --test tests/cover-letter-service.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateJobDescription,
  processCoverLetter,
  DEFAULT_LIMITS,
} from '../src/lib/cover-letter-service.mjs';
import {
  REQUIRED_AUTHORIZATION,
  SIGNOFF,
  buildGeneralLetter,
} from '../src/lib/cover-letter.mjs';
import { GeneratorError } from '../src/lib/generator-provider.mjs';

// ---------------------------------------------------------------------------
// Test helpers and stubs
// ---------------------------------------------------------------------------

const SAMPLE_LETTER_DOC = {
  greeting: 'Dear Hiring Team,',
  paragraphs: [
    'I am writing to share how my engineering background aligns with your role.',
    'Over the past decade I have led backend architecture across Node.js systems.',
  ],
  authorization: REQUIRED_AUTHORIZATION,
  signoff: SIGNOFF,
  links: [
    { label: 'LinkedIn', href: 'https://linkedin.com/in/emad-poursina' },
    { label: 'GitHub', href: 'https://github.com/emadpoursina' },
  ],
  lastUpdated: '2026-11-09',
};

const SAMPLE_PROFILE = {
  name: 'Emad Poursina',
  headline: 'Senior Backend Engineer',
  workAuthorization: REQUIRED_AUTHORIZATION,
  links: {
    linkedin: 'https://linkedin.com/in/emad-poursina',
    github: 'https://github.com/emadpoursina',
  },
};

function createStubSettings({
  endpoint = 'https://generator.example.com/api',
  apiKey = 'distinctive-generator-api-key-12345',
  timeoutMs = 30000,
  configured = true,
  askDailyCap = 3,
} = {}) {
  return {
    getEffectiveGenerator: () => ({
      endpoint,
      apiKey,
      timeoutMs,
      configured,
    }),
    getEffectiveSettings: () => ({
      askDailyCap,
    }),
  };
}

function createStubProvider({ letter = null, error = null } = {}) {
  const calls = [];
  return {
    async call(args) {
      calls.push(args);
      if (error) {
        throw error;
      }
      return letter;
    },
    _calls: calls,
  };
}

function createStubLimits({
  ipAllowed = true,
  retryAfterSeconds = 0,
  dailyAllowed = true,
  throwDaily = false,
  count = 1,
} = {}) {
  const ipCalls = [];
  const dailyCalls = [];
  return {
    checkPerIp: (ip) => {
      ipCalls.push({ ip });
      return { allowed: ipAllowed, retryAfterSeconds };
    },
    consumeDaily: (db, day, cap) => {
      if (throwDaily) throw new Error('database disk failure');
      dailyCalls.push({ day, cap });
      return { count, allowed: dailyAllowed };
    },
    _ipCalls: ipCalls,
    _dailyCalls: dailyCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateJobDescription', () => {
  test('null, array, non-object, missing field, non-string, empty, whitespace -> rejected with exact message', () => {
    const invalidInputs = [
      null,
      undefined,
      [],
      [1, 2, 3],
      'just a string',
      12345,
      true,
      {},
      { jobDescription: null },
      { jobDescription: undefined },
      { jobDescription: 12345 },
      { jobDescription: true },
      { jobDescription: {} },
      { jobDescription: [] },
      { jobDescription: '' },
      { jobDescription: '   ' },
      { jobDescription: ' \t\n\r ' },
    ];

    for (const input of invalidInputs) {
      const result = validateJobDescription(input);
      assert.equal(result.ok, false, `Expected failure for input: ${JSON.stringify(input)}`);
      assert.deepEqual(result.errors, {
        jobDescription: 'Job description is required.',
      });
    }
  });

  test('8001 characters -> rejected with exact message', () => {
    const jd8001 = 'x'.repeat(8001);
    const result = validateJobDescription({ jobDescription: jd8001 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, {
      jobDescription: 'Job description must be 8,000 characters or fewer.',
    });

    const jd8001Padded = `  ${jd8001}  `;
    const resultPadded = validateJobDescription({ jobDescription: jd8001Padded });
    assert.equal(resultPadded.ok, false);
    assert.deepEqual(resultPadded.errors, {
      jobDescription: 'Job description must be 8,000 characters or fewer.',
    });
  });

  test('exactly 8000 accepted, and leading/trailing whitespace trimmed in returned jobDescription', () => {
    const jd8000 = 'y'.repeat(8000);
    const padded = `  \n  ${jd8000}  \t  `;
    const result = validateJobDescription({ jobDescription: padded });

    assert.equal(result.ok, true);
    assert.equal(result.jobDescription, jd8000);
    assert.equal(result.jobDescription.length, 8000);
  });
});

describe('processCoverLetter - unconfigured', () => {
  test('settings.getEffectiveGenerator returns configured:false -> 503, exact message, zero provider calls', async () => {
    const settings = {
      getEffectiveGenerator: () => ({
        endpoint: '',
        apiKey: '',
        timeoutMs: 30000,
        configured: false,
      }),
      getEffectiveSettings: () => ({
        askDailyCap: 3,
      }),
    };
    const provider = createStubProvider({ letter: 'Never generated.' });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Backend engineer role with Node.js expertise.' },
      '192.168.1.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 503);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'unconfigured',
      message: 'The cover-letter generator is unavailable right now',
    });
    assert.equal(provider._calls.length, 0);
    assert.equal(limits._dailyCalls.length, 0);
  });
});

describe('processCoverLetter - success', () => {
  test('configured stub; provider returns letter containing both required lines -> 200, ok true, letter unchanged, appended both false', async () => {
    const settings = createStubSettings();
    const fullLetter = `Dear Hiring Manager,\n\nI am thrilled to apply.\n\n${REQUIRED_AUTHORIZATION}\n\n${SIGNOFF}`;
    const provider = createStubProvider({ letter: fullLetter });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Looking for a Staff Node.js Developer.' },
      '192.168.1.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 200);
    assert.deepEqual(result.payload, {
      ok: true,
      letter: fullLetter,
      appended: {
        authorization: false,
        signoff: false,
      },
    });
    assert.equal(provider._calls.length, 1);
  });
});

describe('processCoverLetter - append combinations', () => {
  test('provider letter missing authorization only -> appended.authorization true, appended.signoff false, starts with provider body unchanged', async () => {
    const settings = createStubSettings();
    const providerBody = `Dear Hiring Manager,\n\nI have the required technical expertise.\n\n${SIGNOFF}`;
    const provider = createStubProvider({ letter: providerBody });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Node engineer' },
      '192.168.1.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.appended, {
      authorization: true,
      signoff: false,
    });
    assert.ok(result.payload.letter.startsWith(providerBody));
    assert.ok(result.payload.letter.includes(REQUIRED_AUTHORIZATION));
    assert.ok(result.payload.letter.includes(SIGNOFF));
  });

  test('provider letter missing sign-off only -> appended.authorization false, appended.signoff true, starts with provider body unchanged', async () => {
    const settings = createStubSettings();
    const providerBody = `Dear Hiring Manager,\n\nI have the required technical expertise.\n\n${REQUIRED_AUTHORIZATION}`;
    const provider = createStubProvider({ letter: providerBody });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Node engineer' },
      '192.168.1.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.appended, {
      authorization: false,
      signoff: true,
    });
    assert.ok(result.payload.letter.startsWith(providerBody));
    assert.ok(result.payload.letter.includes(REQUIRED_AUTHORIZATION));
    assert.ok(result.payload.letter.includes(SIGNOFF));
    assert.equal(
      result.payload.letter,
      `${providerBody}\n\n${SIGNOFF}`
    );
  });

  test('provider letter missing both -> appended both true, exact lines present, starts with provider body unchanged', async () => {
    const settings = createStubSettings();
    const providerBody = 'Dear Hiring Manager,\n\nI am excited about this opportunity.';
    const provider = createStubProvider({ letter: providerBody });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Node engineer' },
      '192.168.1.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.appended, {
      authorization: true,
      signoff: true,
    });
    assert.ok(result.payload.letter.startsWith(providerBody));
    assert.equal(
      result.payload.letter,
      `${providerBody}\n\n${REQUIRED_AUTHORIZATION}\n\n${SIGNOFF}`
    );
  });
});

describe('processCoverLetter - error mapping', () => {
  const expectedGeneralLetter = buildGeneralLetter(SAMPLE_LETTER_DOC);

  test('provider throws GeneratorError kind "timeout" -> 504 generator_timeout, fallback true, exact generalLetter', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({
      error: new GeneratorError('Upstream socket timed out', { kind: 'timeout' }),
    });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Node engineer job description' },
      '127.0.0.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 504);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'generator_timeout',
      message:
        'The cover-letter generator took too long. The general cover letter is available below.',
      fallback: true,
      generalLetter: expectedGeneralLetter,
    });
    assert.ok(result.payload.generalLetter.includes(REQUIRED_AUTHORIZATION));
    assert.ok(result.payload.generalLetter.includes(SIGNOFF));
  });

  test('provider throws GeneratorError kind "upstream", status 500 -> 502 generator_error, fallback true, exact generalLetter', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({
      error: new GeneratorError('Generator returned HTTP 500', {
        kind: 'upstream',
        status: 500,
      }),
    });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Node engineer job description' },
      '127.0.0.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 502);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'generator_error',
      message:
        'The cover-letter generator could not produce a letter right now. The general cover letter is available below.',
      fallback: true,
      generalLetter: expectedGeneralLetter,
    });
  });

  test('provider throws plain Error -> 502 generator_error, fallback true, exact generalLetter', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({
      error: new Error('Unexpected crash in provider fetch'),
    });
    const limits = createStubLimits();

    const result = await processCoverLetter(
      { jobDescription: 'Node engineer job description' },
      '127.0.0.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 502);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'generator_error',
      message:
        'The cover-letter generator could not produce a letter right now. The general cover letter is available below.',
      fallback: true,
      generalLetter: expectedGeneralLetter,
    });
  });

  test('502/504 payload keys are exactly { ok, error, message, fallback, generalLetter }', async () => {
    const settings = createStubSettings();
    const limits = createStubLimits();

    // 504 case
    const timeoutProvider = createStubProvider({
      error: new GeneratorError('Timeout', { kind: 'timeout' }),
    });
    const res504 = await processCoverLetter(
      { jobDescription: 'Node engineer' },
      '127.0.0.1',
      { settings, provider: timeoutProvider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
    );
    assert.deepEqual(Object.keys(res504.payload).sort(), [
      'error',
      'fallback',
      'generalLetter',
      'message',
      'ok',
    ]);

    // 502 case
    const errorProvider = createStubProvider({
      error: new GeneratorError('Upstream failure', { kind: 'upstream', status: 502 }),
    });
    const res502 = await processCoverLetter(
      { jobDescription: 'Node engineer' },
      '127.0.0.1',
      { settings, provider: errorProvider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
    );
    assert.deepEqual(Object.keys(res502.payload).sort(), [
      'error',
      'fallback',
      'generalLetter',
      'message',
      'ok',
    ]);
  });
});

describe('processCoverLetter - limits', () => {
  test('checkPerIp returns allowed:false, retryAfterSeconds:1234 -> 429 rate_limited, provider not called, even with empty body', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({ letter: 'Should never run' });
    const limits = createStubLimits({
      ipAllowed: false,
      retryAfterSeconds: 1234,
    });

    // Body is empty {} - per-IP runs before validation
    const result = await processCoverLetter({}, '10.0.0.1', {
      settings,
      provider,
      limits,
      letterDoc: SAMPLE_LETTER_DOC,
      profile: SAMPLE_PROFILE,
    });

    assert.equal(result.status, 429);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'rate_limited',
      message: 'Too many cover-letter requests from this address. Please try again later.',
      retryAfterSeconds: 1234,
    });
    assert.equal(provider._calls.length, 0);
    assert.equal(limits._dailyCalls.length, 0);
    assert.deepEqual(limits._ipCalls, [{ ip: '10.0.0.1' }]);
  });

  test('consumeDaily returns {count:4, allowed:false} -> 429 daily_cap with exact message and provider not called', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({ letter: 'Should never run' });
    const limits = createStubLimits({
      dailyAllowed: false,
      count: 4,
    });

    const result = await processCoverLetter(
      { jobDescription: 'Valid job description' },
      '10.0.0.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 429);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'daily_cap',
      message:
        'The cover-letter generator is paused for today. Please try again tomorrow or use the general cover letter.',
    });
    assert.equal(provider._calls.length, 0);
    assert.equal(limits._dailyCalls.length, 1);
  });

  test('consumeDaily throws -> 503 storage and provider not called', async () => {
    const settings = createStubSettings();
    const provider = createStubProvider({ letter: 'Should never run' });
    const limits = createStubLimits({
      throwDaily: true,
    });

    const result = await processCoverLetter(
      { jobDescription: 'Valid job description' },
      '10.0.0.1',
      {
        settings,
        provider,
        limits,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 503);
    assert.deepEqual(result.payload, {
      ok: false,
      error: 'storage',
      message: 'The cover-letter generator is unavailable right now',
    });
    assert.equal(provider._calls.length, 0);
  });
});

describe('processCoverLetter - ordering', () => {
  test('with valid body and configured generator, assert checkPerIp ran before provider, and consumeDaily called once with UTC day and cap from settings', async () => {
    const callOrder = [];

    const settings = {
      getEffectiveGenerator: () => {
        callOrder.push('getEffectiveGenerator');
        return {
          endpoint: 'https://api.example.com',
          apiKey: 'key',
          timeoutMs: 30000,
          configured: true,
        };
      },
      getEffectiveSettings: () => {
        callOrder.push('getEffectiveSettings');
        return {
          askDailyCap: 3,
        };
      },
    };

    const limits = {
      checkPerIp: (ip) => {
        callOrder.push('checkPerIp');
        return { allowed: true, retryAfterSeconds: 0 };
      },
      consumeDaily: (db, day, cap) => {
        callOrder.push({ name: 'consumeDaily', day, cap });
        return { allowed: true, count: 1 };
      },
    };

    const provider = {
      call: async (args) => {
        callOrder.push('providerCall');
        return `Hello\n\n${REQUIRED_AUTHORIZATION}\n\n${SIGNOFF}`;
      },
    };

    const fixedNow = () => new Date('2026-11-09T23:30:00Z');

    const result = await processCoverLetter(
      { jobDescription: 'Senior Backend Engineer role at tech company' },
      '192.168.1.50',
      {
        settings,
        limits,
        provider,
        now: fixedNow,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      }
    );

    assert.equal(result.status, 200);

    const checkPerIpIndex = callOrder.indexOf('checkPerIp');
    const getEffectiveGeneratorIndex = callOrder.indexOf('getEffectiveGenerator');
    const consumeDailyIndex = callOrder.findIndex(
      (c) => typeof c === 'object' && c.name === 'consumeDaily'
    );
    const providerCallIndex = callOrder.indexOf('providerCall');

    assert.ok(checkPerIpIndex !== -1, 'checkPerIp was called');
    assert.ok(getEffectiveGeneratorIndex !== -1, 'getEffectiveGenerator was called');
    assert.ok(consumeDailyIndex !== -1, 'consumeDaily was called');
    assert.ok(providerCallIndex !== -1, 'providerCall was called');

    assert.ok(
      checkPerIpIndex < getEffectiveGeneratorIndex,
      'checkPerIp ran before getEffectiveGenerator'
    );
    assert.ok(
      getEffectiveGeneratorIndex < consumeDailyIndex,
      'getEffectiveGenerator ran before consumeDaily'
    );
    assert.ok(
      consumeDailyIndex < providerCallIndex,
      'consumeDaily ran before providerCall'
    );

    const dailyCall = callOrder[consumeDailyIndex];
    assert.ok(dailyCall, 'consumeDaily was called');
    assert.equal(dailyCall.day, '2026-11-09');
    assert.equal(dailyCall.cap, 3);
  });
});

describe('processCoverLetter - secret-free', () => {
  test('distinctive apiKey/endpoint strings: JSON.stringify every payload and assert key, endpoint, and job description never appear', async () => {
    const SECRET_KEY = 'distinctive-generator-api-key-999xyz';
    const SECRET_ENDPOINT = 'https://secret-generator-endpoint.internal.example.com/v1/generate';
    const SECRET_JOB_DESC = 'CONFIDENTIAL_JOB_DESCRIPTION_TEXT_DO_NOT_LEAK';

    const baseSettings = createStubSettings({
      endpoint: SECRET_ENDPOINT,
      apiKey: SECRET_KEY,
    });

    const cases = [
      // 1. Success 200
      async () => {
        const provider = createStubProvider({
          letter: `Generated cover letter.\n\n${REQUIRED_AUTHORIZATION}\n\n${SIGNOFF}`,
        });
        const limits = createStubLimits();
        return processCoverLetter(
          { jobDescription: SECRET_JOB_DESC },
          '1.2.3.4',
          { settings: baseSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
      // 2. 400 validation error
      async () => {
        const provider = createStubProvider();
        const limits = createStubLimits();
        return processCoverLetter(
          { jobDescription: '' },
          '1.2.3.4',
          { settings: baseSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
      // 3. 429 rate_limited
      async () => {
        const provider = createStubProvider();
        const limits = createStubLimits({ ipAllowed: false, retryAfterSeconds: 50 });
        return processCoverLetter(
          { jobDescription: SECRET_JOB_DESC },
          '1.2.3.4',
          { settings: baseSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
      // 4. 429 daily_cap
      async () => {
        const provider = createStubProvider();
        const limits = createStubLimits({ dailyAllowed: false });
        return processCoverLetter(
          { jobDescription: SECRET_JOB_DESC },
          '1.2.3.4',
          { settings: baseSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
      // 5. 503 unconfigured
      async () => {
        const unconfSettings = {
          getEffectiveGenerator: () => ({
            endpoint: SECRET_ENDPOINT,
            apiKey: SECRET_KEY,
            timeoutMs: 30000,
            configured: false,
          }),
          getEffectiveSettings: () => ({ askDailyCap: 3 }),
        };
        const provider = createStubProvider();
        const limits = createStubLimits();
        return processCoverLetter(
          { jobDescription: SECRET_JOB_DESC },
          '1.2.3.4',
          { settings: unconfSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
      // 6. 503 storage
      async () => {
        const provider = createStubProvider();
        const limits = createStubLimits({ throwDaily: true });
        return processCoverLetter(
          { jobDescription: SECRET_JOB_DESC },
          '1.2.3.4',
          { settings: baseSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
      // 7. 502 generator_error
      async () => {
        const provider = createStubProvider({
          error: new GeneratorError(`Internal crash at ${SECRET_ENDPOINT} using ${SECRET_KEY}`, {
            kind: 'upstream',
            status: 500,
          }),
        });
        const limits = createStubLimits();
        return processCoverLetter(
          { jobDescription: SECRET_JOB_DESC },
          '1.2.3.4',
          { settings: baseSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
      // 8. 504 generator_timeout
      async () => {
        const provider = createStubProvider({
          error: new GeneratorError(`Timeout talking to ${SECRET_ENDPOINT}`, {
            kind: 'timeout',
          }),
        });
        const limits = createStubLimits();
        return processCoverLetter(
          { jobDescription: SECRET_JOB_DESC },
          '1.2.3.4',
          { settings: baseSettings, provider, limits, letterDoc: SAMPLE_LETTER_DOC, profile: SAMPLE_PROFILE }
        );
      },
    ];

    for (let i = 0; i < cases.length; i++) {
      const res = await cases[i]();
      const serialized = JSON.stringify(res.payload);
      assert.equal(
        serialized.includes(SECRET_KEY),
        false,
        `Case ${i + 1} leaked apiKey`
      );
      assert.equal(
        serialized.includes(SECRET_ENDPOINT),
        false,
        `Case ${i + 1} leaked endpoint`
      );
      assert.equal(
        serialized.includes(SECRET_JOB_DESC),
        false,
        `Case ${i + 1} leaked jobDescription`
      );
    }
  });
});

describe('DEFAULT_LIMITS', () => {
  test('exports DEFAULT_LIMITS with checkPerIp and consumeDaily functions', () => {
    assert.equal(typeof DEFAULT_LIMITS.checkPerIp, 'function');
    assert.equal(typeof DEFAULT_LIMITS.consumeDaily, 'function');
    const ipCheck = DEFAULT_LIMITS.checkPerIp();
    assert.deepEqual(ipCheck, { allowed: true, retryAfterSeconds: 0 });
  });
});

describe('processCoverLetter - real default limits', () => {
  test('default per-IP window: first 10 attempts 400 validation, 11th 429 rate_limited, provider never called', async () => {
    const uniqueIp = `198.51.100.${Date.now() % 250}.${Math.floor(Math.random() * 10000)}`;
    const settings = createStubSettings();
    const provider = createStubProvider({ letter: 'unused' });

    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      for (let i = 0; i < 10; i++) {
        const result = await processCoverLetter({}, uniqueIp, {
          settings,
          provider,
          letterDoc: SAMPLE_LETTER_DOC,
          profile: SAMPLE_PROFILE,
        });
        assert.equal(result.status, 400);
      }

      const eleventh = await processCoverLetter({}, uniqueIp, {
        settings,
        provider,
        letterDoc: SAMPLE_LETTER_DOC,
        profile: SAMPLE_PROFILE,
      });

      assert.equal(eleventh.status, 429);
      assert.equal(eleventh.payload?.error, 'rate_limited');
      assert.equal(
        Number.isInteger(eleventh.payload?.retryAfterSeconds),
        true,
        'retryAfterSeconds should be an integer'
      );
      assert.ok(
        eleventh.payload.retryAfterSeconds >= 1 && eleventh.payload.retryAfterSeconds <= 3600,
        `retryAfterSeconds (${eleventh.payload.retryAfterSeconds}) should be between 1 and 3600`
      );
      assert.equal(provider._calls.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('DEFAULT_LIMITS.consumeDaily delegates to daily-cap with feature cover_letter', async () => {
    let askCount = 0;
    const getCapCalls = [];
    const insertCapCalls = [];

    const fakeDb = {
      consumeDailyAsk: (day, cap) => {
        askCount += 1;
        return { count: askCount, allowed: askCount <= cap };
      },
      getCapEvent: (day, feature) => {
        getCapCalls.push({ day, feature });
        return null;
      },
      insertCapEvent: (day, feature) => {
        insertCapCalls.push({ day, feature });
      },
    };

    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      const first = DEFAULT_LIMITS.consumeDaily(fakeDb, '2026-11-09', 1);
      assert.deepEqual(first, { count: 1, allowed: true });

      const second = DEFAULT_LIMITS.consumeDaily(fakeDb, '2026-11-09', 1);
      assert.equal(second.allowed, false);

      assert.equal(getCapCalls.length, 1);
      assert.deepEqual(getCapCalls[0], { day: '2026-11-09', feature: 'cover_letter' });

      assert.equal(insertCapCalls.length, 1);
      assert.deepEqual(insertCapCalls[0], { day: '2026-11-09', feature: 'cover_letter' });
    } finally {
      console.warn = originalWarn;
    }
  });
});

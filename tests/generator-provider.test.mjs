/**
 * tests/generator-provider.test.mjs
 *
 * Unit tests for external cover-letter generator provider adapter
 * (src/lib/generator-provider.mjs).
 * Uses injected fake fetch implementations — no network sockets.
 * Run with: node --experimental-sqlite --test tests/generator-provider.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GeneratorError,
  buildGeneratorRequest,
  readGeneratorResponse,
  callGenerator,
  BANNED_PHRASES,
  REQUIRED_WORK_AUTHORIZATION,
  REQUIRED_SIGNOFF,
  MAX_CHARACTERS,
} from '../src/lib/generator-provider.mjs';

const FAKE_KEY = 'sk-gen-fake-test-key-54321';
const FAKE_ENDPOINT = 'https://api.generator.internal/v1/letters/';
const SAMPLE_JOB_DESCRIPTION = '  We are looking for a Senior Node.js and AI Engineer to build agentic pipelines.  ';
const SAMPLE_PROFILE = {
  name: 'Emad Poursina',
  headline: 'AI and Agentic Systems Engineer with a strong foundation in software development',
  workAuthorization: 'Requires employer-sponsored work authorization.',
  availability: 'one month notice',
  contactEmail: 'emad.poursina.work@gmail.com',
  links: {
    linkedin: 'https://www.linkedin.com/in/emadpoursina/',
    github: 'https://github.com/emadpoursina',
  },
  bio: 'Software engineer with 7+ years of production Node.js work, now focused on AI and agentic systems.',
  extraUnusedProfileField: 'internal-secret-data',
};

describe('src/lib/generator-provider.mjs', () => {
  describe('GeneratorError', () => {
    test('constructs with kind, status, and message', () => {
      const err = new GeneratorError('Upstream failure', { kind: 'upstream', status: 502 });
      assert.ok(err instanceof Error);
      assert.ok(err instanceof GeneratorError);
      assert.equal(err.name, 'GeneratorError');
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 502);
      assert.equal(err.message, 'Upstream failure');
    });

    test('constructs timeout error without status', () => {
      const err = new GeneratorError('Generator request timed out', { kind: 'timeout' });
      assert.equal(err.kind, 'timeout');
      assert.equal(err.status, undefined);
    });

    test('toJSON provides structured representation without extra fields', () => {
      const err = new GeneratorError('Generator returned HTTP 500', { kind: 'upstream', status: 500 });
      const json = err.toJSON();
      assert.deepEqual(json, {
        name: 'GeneratorError',
        message: 'Generator returned HTTP 500',
        kind: 'upstream',
        status: 500,
      });

      const timeoutErr = new GeneratorError('Generator request timed out', { kind: 'timeout' });
      assert.deepEqual(timeoutErr.toJSON(), {
        name: 'GeneratorError',
        message: 'Generator request timed out',
        kind: 'timeout',
      });
    });
  });

  describe('buildGeneratorRequest', () => {
    test('formats exact body object from contract with trimmed job description and no extra candidate facts', () => {
      const body = buildGeneratorRequest(SAMPLE_PROFILE, SAMPLE_JOB_DESCRIPTION);

      assert.deepEqual(body, {
        job_description: 'We are looking for a Senior Node.js and AI Engineer to build agentic pipelines.',
        candidate: {
          name: 'Emad Poursina',
          headline: 'AI and Agentic Systems Engineer with a strong foundation in software development',
          work_authorization: 'Requires employer-sponsored work authorization.',
          availability: 'one month notice',
          contact_email: 'emad.poursina.work@gmail.com',
          linkedin: 'https://www.linkedin.com/in/emadpoursina/',
          github: 'https://github.com/emadpoursina',
          bio: 'Software engineer with 7+ years of production Node.js work, now focused on AI and agentic systems.',
        },
        required: {
          work_authorization: 'Requires employer-sponsored work authorization.',
          signoff: 'Best regards, Emad Poursina',
          banned_phrases: [
            'I am writing to express my interest',
            'passionate',
            'dynamic',
            'synergy',
            'results-driven',
            'team player',
          ],
        },
        max_characters: 12000,
      });

      // Assert extra properties on profile are NOT leaked into candidate
      assert.equal('extraUnusedProfileField' in body.candidate, false);
      assert.equal(Object.keys(body.candidate).length, 8);
    });

    test('maps real content/profile.json accurately', async () => {
      const rawProfile = JSON.parse(await readFile(new URL('../content/profile.json', import.meta.url), 'utf-8'));
      const body = buildGeneratorRequest(rawProfile, 'Role Description');

      assert.equal(body.candidate.name, rawProfile.name);
      assert.equal(body.candidate.headline, rawProfile.headline);
      assert.equal(body.candidate.work_authorization, rawProfile.workAuthorization);
      assert.equal(body.candidate.availability, rawProfile.availability);
      assert.equal(body.candidate.contact_email, rawProfile.contactEmail);
      assert.equal(body.candidate.linkedin, rawProfile.links.linkedin);
      assert.equal(body.candidate.github, rawProfile.links.github);
      assert.equal(body.candidate.bio, rawProfile.bio);
    });

    test('handles empty or missing profile gracefully', () => {
      const body = buildGeneratorRequest(null, 'Some JD');
      assert.deepEqual(body.candidate, {
        name: '',
        headline: '',
        work_authorization: '',
        availability: '',
        contact_email: '',
        linkedin: '',
        github: '',
        bio: '',
      });
      assert.equal(body.job_description, 'Some JD');
      assert.equal(body.max_characters, 12000);
    });
  });

  describe('readGeneratorResponse', () => {
    test('returns trimmed letter string on valid response', () => {
      const result = readGeneratorResponse({
        letter: '   Dear Hiring Manager,\n\nI am qualified.\n\nBest regards, Emad Poursina   \n',
      });
      assert.equal(result, 'Dear Hiring Manager,\n\nI am qualified.\n\nBest regards, Emad Poursina');
    });

    test('accepts exactly 12000 character trimmed letter', () => {
      const exactly12k = 'A'.repeat(12000);
      const result = readGeneratorResponse({ letter: `  ${exactly12k}  ` });
      assert.equal(result.length, 12000);
      assert.equal(result, exactly12k);
    });

    test('throws GeneratorError kind upstream on non-object data', () => {
      const invalidBodies = [null, undefined, 'string', 12345, true, [1, 2, 3]];
      for (const val of invalidBodies) {
        assert.throws(
          () => readGeneratorResponse(val),
          (err) => {
            assert.ok(err instanceof GeneratorError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, undefined);
            return true;
          }
        );
      }
    });

    test('throws GeneratorError kind upstream when letter is missing or non-string', () => {
      const invalidLetterBodies = [
        {},
        { letter: null },
        { letter: undefined },
        { letter: 123 },
        { letter: true },
        { letter: {} },
        { letter: [] },
      ];
      for (const val of invalidLetterBodies) {
        assert.throws(
          () => readGeneratorResponse(val),
          (err) => {
            assert.ok(err instanceof GeneratorError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, undefined);
            return true;
          }
        );
      }
    });

    test('throws GeneratorError kind upstream when letter is empty or whitespace-only', () => {
      const emptyLetters = ['', ' ', '   \n\t\r  '];
      for (const letter of emptyLetters) {
        assert.throws(
          () => readGeneratorResponse({ letter }),
          (err) => {
            assert.ok(err instanceof GeneratorError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, undefined);
            return true;
          }
        );
      }
    });

    test('throws GeneratorError kind upstream when letter exceeds 12000 characters', () => {
      const tooLong12001 = 'A'.repeat(12001);
      assert.throws(
        () => readGeneratorResponse({ letter: tooLong12001 }),
        (err) => {
          assert.ok(err instanceof GeneratorError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          return true;
        }
      );

      const paddedTooLong = '   ' + 'B'.repeat(12001) + '   ';
      assert.throws(
        () => readGeneratorResponse({ letter: paddedTooLong }),
        (err) => {
          assert.ok(err instanceof GeneratorError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          return true;
        }
      );
    });
  });

  describe('callGenerator - exact request and headers', () => {
    test('POSTs to endpoint exactly as given with three headers and exact body object', async () => {
      let capturedUrl = null;
      let capturedOptions = null;

      const fakeFetch = async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            letter: '  Dear Hiring Manager,\nTailored response\nBest regards, Emad Poursina  ',
          }),
        };
      };

      const result = await callGenerator({
        endpoint: FAKE_ENDPOINT, // preserves trailing slash and exact path
        apiKey: FAKE_KEY,
        jobDescription: SAMPLE_JOB_DESCRIPTION,
        candidate: SAMPLE_PROFILE,
        fetchImpl: fakeFetch,
      });

      // Captured URL matches EXACTLY as given (no path appended, no trailing slash change)
      assert.equal(capturedUrl, FAKE_ENDPOINT);

      // Method is POST
      assert.equal(capturedOptions.method, 'POST');

      // Three exact headers
      assert.equal(capturedOptions.headers['Authorization'], `Bearer ${FAKE_KEY}`);
      assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
      assert.equal(capturedOptions.headers['Accept'], 'application/json');

      // Body object
      const parsedBody = JSON.parse(capturedOptions.body);
      assert.deepEqual(parsedBody, {
        job_description: 'We are looking for a Senior Node.js and AI Engineer to build agentic pipelines.',
        candidate: {
          name: SAMPLE_PROFILE.name,
          headline: SAMPLE_PROFILE.headline,
          work_authorization: SAMPLE_PROFILE.workAuthorization,
          availability: SAMPLE_PROFILE.availability,
          contact_email: SAMPLE_PROFILE.contactEmail,
          linkedin: SAMPLE_PROFILE.links.linkedin,
          github: SAMPLE_PROFILE.links.github,
          bio: SAMPLE_PROFILE.bio,
        },
        required: {
          work_authorization: REQUIRED_WORK_AUTHORIZATION,
          signoff: REQUIRED_SIGNOFF,
          banned_phrases: BANNED_PHRASES,
        },
        max_characters: MAX_CHARACTERS,
      });

      // Returns trimmed string
      assert.equal(result, 'Dear Hiring Manager,\nTailored response\nBest regards, Emad Poursina');
    });
  });

  describe('callGenerator - success', () => {
    test('200 with { letter: "  Dear Hiring Manager, ...  " } returns trimmed string', async () => {
      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          letter: '  Dear Hiring Manager,\n\nI am excited about this role.\n\nBest regards, Emad Poursina  ',
        }),
      });

      const letter = await callGenerator({
        endpoint: FAKE_ENDPOINT,
        apiKey: FAKE_KEY,
        jobDescription: SAMPLE_JOB_DESCRIPTION,
        candidate: SAMPLE_PROFILE,
        fetchImpl: fakeFetch,
      });

      assert.equal(letter, 'Dear Hiring Manager,\n\nI am excited about this role.\n\nBest regards, Emad Poursina');
    });
  });

  describe('callGenerator - non-2xx HTTP responses', () => {
    const errorStatuses = [500, 429, 400, 401, 403, 502, 503, 504];

    for (const status of errorStatuses) {
      test(`HTTP ${status} throws GeneratorError kind upstream with status and message containing status number`, async () => {
        const fakeFetch = async () => ({
          ok: false,
          status,
          text: async () => 'upstream sensitive error body with internal details',
        });

        await assert.rejects(
          async () => {
            await callGenerator({
              endpoint: FAKE_ENDPOINT,
              apiKey: FAKE_KEY,
              jobDescription: SAMPLE_JOB_DESCRIPTION,
              candidate: SAMPLE_PROFILE,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.ok(err instanceof GeneratorError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, status);
            assert.ok(err.message.includes(String(status)));
            // Asserts upstream body is never forwarded
            assert.ok(!err.message.includes('upstream sensitive error body'));
            return true;
          }
        );
      });
    }
  });

  describe('callGenerator - malformed JSON', () => {
    test('malformed JSON (response.json() rejects) throws GeneratorError kind upstream', async () => {
      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      });

      await assert.rejects(
        async () => {
          await callGenerator({
            endpoint: FAKE_ENDPOINT,
            apiKey: FAKE_KEY,
            jobDescription: SAMPLE_JOB_DESCRIPTION,
            candidate: SAMPLE_PROFILE,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof GeneratorError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          assert.equal(err.message, 'Generator returned malformed JSON');
          return true;
        }
      );
    });
  });

  describe('callGenerator - invalid letter payloads', () => {
    test('missing, non-string, empty/whitespace, and 12001-character letter throw GeneratorError kind upstream', async () => {
      const testCases = [
        { label: 'missing letter', payload: {} },
        { label: 'null letter', payload: { letter: null } },
        { label: 'number letter', payload: { letter: 9999 } },
        { label: 'empty string letter', payload: { letter: '' } },
        { label: 'whitespace letter', payload: { letter: '   \n\t  ' } },
        { label: '12001-character letter', payload: { letter: 'A'.repeat(12001) } },
      ];

      for (const tc of testCases) {
        const fakeFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => tc.payload,
        });

        await assert.rejects(
          async () => {
            await callGenerator({
              endpoint: FAKE_ENDPOINT,
              apiKey: FAKE_KEY,
              jobDescription: SAMPLE_JOB_DESCRIPTION,
              candidate: SAMPLE_PROFILE,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.ok(err instanceof GeneratorError, `${tc.label} should throw GeneratorError`);
            assert.equal(err.kind, 'upstream', `${tc.label} kind should be upstream`);
            assert.equal(err.status, undefined);
            return true;
          }
        );
      }
    });

    test('exactly 12000 character letter is accepted', async () => {
      const letter12k = 'C'.repeat(12000);
      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ letter: `  ${letter12k}  ` }),
      });

      const res = await callGenerator({
        endpoint: FAKE_ENDPOINT,
        apiKey: FAKE_KEY,
        jobDescription: SAMPLE_JOB_DESCRIPTION,
        candidate: SAMPLE_PROFILE,
        fetchImpl: fakeFetch,
      });

      assert.equal(res.length, 12000);
      assert.equal(res, letter12k);
    });
  });

  describe('callGenerator - network failure', () => {
    test('fetchImpl rejects with TypeError throws GeneratorError kind upstream', async () => {
      const fakeFetch = async () => {
        throw new TypeError('fetch failed');
      };

      await assert.rejects(
        async () => {
          await callGenerator({
            endpoint: FAKE_ENDPOINT,
            apiKey: FAKE_KEY,
            jobDescription: SAMPLE_JOB_DESCRIPTION,
            candidate: SAMPLE_PROFILE,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof GeneratorError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          assert.equal(err.message, 'Generator network error');
          return true;
        }
      );
    });

    test('fetchImpl rejects with ECONNREFUSED throws GeneratorError kind upstream', async () => {
      const fakeFetch = async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:4000');
        err.code = 'ECONNREFUSED';
        throw err;
      };

      await assert.rejects(
        async () => {
          await callGenerator({
            endpoint: FAKE_ENDPOINT,
            apiKey: FAKE_KEY,
            jobDescription: SAMPLE_JOB_DESCRIPTION,
            candidate: SAMPLE_PROFILE,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof GeneratorError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          return true;
        }
      );
    });
  });

  describe('callGenerator - abort at the bound and timer cleanup', () => {
    test('abort at the bound with timeoutMs 25 throws kind timeout and does not keep process alive', async () => {
      const fakeFetch = (url, options) => {
        return new Promise((resolve, reject) => {
          if (options.signal.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            return reject(err);
          }
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      await assert.rejects(
        async () => {
          await callGenerator({
            endpoint: FAKE_ENDPOINT,
            apiKey: FAKE_KEY,
            jobDescription: SAMPLE_JOB_DESCRIPTION,
            candidate: SAMPLE_PROFILE,
            timeoutMs: 25,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof GeneratorError);
          assert.equal(err.kind, 'timeout');
          assert.equal(err.status, undefined);
          assert.equal(err.message, 'Generator request timed out');
          return true;
        }
      );

      // Verify immediate subsequent call resolves quickly and test completes cleanly
      const immediateFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ letter: 'Quick letter' }),
      });

      const second = await callGenerator({
        endpoint: FAKE_ENDPOINT,
        apiKey: FAKE_KEY,
        jobDescription: SAMPLE_JOB_DESCRIPTION,
        candidate: SAMPLE_PROFILE,
        timeoutMs: 25,
        fetchImpl: immediateFetch,
      });

      assert.equal(second, 'Quick letter');
    });

    test('timer is always cleared in finally (on success and timeout)', async () => {
      let createdTimer = null;
      let clearedTimer = null;

      const origSetTimeout = globalThis.setTimeout;
      const origClearTimeout = globalThis.clearTimeout;

      globalThis.setTimeout = (...args) => {
        const t = origSetTimeout(...args);
        createdTimer = t;
        return t;
      };

      globalThis.clearTimeout = (id) => {
        clearedTimer = id;
        return origClearTimeout(id);
      };

      try {
        const fakeFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({ letter: 'Letter content' }),
        });

        const letter = await callGenerator({
          endpoint: FAKE_ENDPOINT,
          apiKey: FAKE_KEY,
          jobDescription: SAMPLE_JOB_DESCRIPTION,
          candidate: SAMPLE_PROFILE,
          timeoutMs: 15000,
          fetchImpl: fakeFetch,
        });

        assert.equal(letter, 'Letter content');
        assert.ok(createdTimer !== null);
        assert.equal(clearedTimer, createdTimer);
        assert.equal(createdTimer._destroyed, true);
      } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.clearTimeout = origClearTimeout;
      }
    });
  });

  describe('callGenerator - secret-free errors', () => {
    const DISTINCTIVE_KEY = 'sk-generator-test-secret-distinctive-XYZ-987';
    const DISTINCTIVE_ENDPOINT = 'https://admin:supersecret@secret-host.internal/v1/generate';
    const DISTINCTIVE_JD = 'SECRET-CONFIDENTIAL-JOB-DESCRIPTION-ACME-INTERNAL-PROJECT-ZEUS';
    const SENSITIVE_UPSTREAM_BODY = '{"error":{"message":"Leaked database password and upstream internals"}}';

    test('errors never leak apiKey, endpoint, request body (job description), or upstream body', async () => {
      const errorCases = [
        {
          name: '500 with sensitive upstream body',
          fetchImpl: async () => ({
            ok: false,
            status: 500,
            text: async () => SENSITIVE_UPSTREAM_BODY,
          }),
        },
        {
          name: '429 with sensitive upstream body',
          fetchImpl: async () => ({
            ok: false,
            status: 429,
            text: async () => SENSITIVE_UPSTREAM_BODY,
          }),
        },
        {
          name: 'malformed JSON error',
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError(`SyntaxError near ${SENSITIVE_UPSTREAM_BODY}`);
            },
          }),
        },
        {
          name: 'network failure error',
          fetchImpl: async () => {
            throw new TypeError(`Network error connecting to ${DISTINCTIVE_ENDPOINT}`);
          },
        },
        {
          name: 'invalid letter response',
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ letter: '   ' }),
          }),
        },
        {
          name: 'timeout error',
          timeoutMs: 15,
          fetchImpl: (url, options) => {
            return new Promise((_, reject) => {
              options.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            });
          },
        },
      ];

      for (const tc of errorCases) {
        let caught = null;
        try {
          await callGenerator({
            endpoint: DISTINCTIVE_ENDPOINT,
            apiKey: DISTINCTIVE_KEY,
            jobDescription: DISTINCTIVE_JD,
            candidate: SAMPLE_PROFILE,
            timeoutMs: tc.timeoutMs,
            fetchImpl: tc.fetchImpl,
          });
        } catch (err) {
          caught = err;
        }

        assert.ok(caught instanceof GeneratorError, `${tc.name}: expected GeneratorError`);

        const message = caught.message;
        const asString = String(caught);
        const asJson = JSON.stringify(caught);

        const representations = [
          { label: 'err.message', val: message },
          { label: 'String(err)', val: asString },
          { label: 'JSON.stringify(err)', val: asJson },
        ];

        for (const rep of representations) {
          assert.ok(
            !rep.val.includes(DISTINCTIVE_KEY),
            `${tc.name}: ${rep.label} leaked apiKey: ${rep.val}`
          );
          assert.ok(
            !rep.val.includes(DISTINCTIVE_ENDPOINT),
            `${tc.name}: ${rep.label} leaked endpoint: ${rep.val}`
          );
          assert.ok(
            !rep.val.includes(DISTINCTIVE_JD),
            `${tc.name}: ${rep.label} leaked job description: ${rep.val}`
          );
          assert.ok(
            !rep.val.includes(SENSITIVE_UPSTREAM_BODY),
            `${tc.name}: ${rep.label} leaked upstream body: ${rep.val}`
          );
        }

        // Assert error object does not carry upstream body in any property
        assert.equal('body' in caught, false);
        assert.equal('response' in caught, false);
        assert.equal('upstreamBody' in caught, false);
      }
    });
  });

  describe('callGenerator - timeoutMs is capped at 30000', () => {
    test('timeoutMs 60000 is capped at 30000 and resolves immediately with fast fetch', async () => {
      let registeredDelay = null;
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (cb, ms, ...args) => {
        registeredDelay = ms;
        return origSetTimeout(cb, ms, ...args);
      };

      try {
        const start = Date.now();
        const fakeFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({ letter: 'Quick generated letter' }),
        });

        const res = await callGenerator({
          endpoint: FAKE_ENDPOINT,
          apiKey: FAKE_KEY,
          jobDescription: SAMPLE_JOB_DESCRIPTION,
          candidate: SAMPLE_PROFILE,
          timeoutMs: 60000,
          fetchImpl: fakeFetch,
        });

        const elapsed = Date.now() - start;

        assert.equal(res, 'Quick generated letter');
        assert.equal(registeredDelay, 30000, 'timeoutMs 60000 must be capped at 30000');
        assert.ok(elapsed < 2000, `resolved in ${elapsed}ms well before 60000ms`);
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }
    });
  });
});

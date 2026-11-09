/**
 * tests/ai-provider.test.mjs
 *
 * Unit tests for OpenAI-compatible provider adapter (src/lib/ai-provider.mjs).
 * Uses injected fake fetch implementations — no real network access.
 * Run with: node --experimental-sqlite --test tests/ai-provider.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, callProvider } from '../src/lib/ai-provider.mjs';
import { reset } from '../src/lib/env.mjs';

const FAKE_KEY = 'sk-fake-test-key-12345';
const BASE_URL = 'https://api.fake-provider.internal/v1';
const TEST_MODEL = 'test-model-haiku';
const TEST_MESSAGES = [
  { role: 'system', content: 'You are an assistant.' },
  { role: 'user', content: 'What is 2 + 2?' },
];

describe('src/lib/ai-provider.mjs', () => {
  describe('ProviderError', () => {
    test('constructs with kind, status, and message', () => {
      const err = new ProviderError('Upstream failure', { kind: 'upstream', status: 502 });
      assert.ok(err instanceof Error);
      assert.ok(err instanceof ProviderError);
      assert.equal(err.name, 'ProviderError');
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 502);
      assert.equal(err.message, 'Upstream failure');
    });

    test('constructs timeout error without status', () => {
      const err = new ProviderError('Timeout occurred', { kind: 'timeout' });
      assert.equal(err.kind, 'timeout');
      assert.equal(err.status, undefined);
    });

    test('toJSON provides structured representation without leaking secrets', () => {
      const err = new ProviderError('HTTP 500 error', { kind: 'upstream', status: 500 });
      const serialized = JSON.stringify(err);
      assert.ok(serialized.includes('"name":"ProviderError"'));
      assert.ok(serialized.includes('"kind":"upstream"'));
      assert.ok(serialized.includes('"status":500'));
    });
  });

  describe('callProvider - success', () => {
    test('normalizes baseUrl trailing slashes and formats POST request accurately', async () => {
      let recordedUrl = null;
      let recordedOptions = null;

      const fakeFetch = async (url, options) => {
        recordedUrl = url;
        recordedOptions = options;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: '  \n Four is the answer.   \t',
                },
              },
            ],
          }),
        };
      };

      const result = await callProvider({
        baseUrl: 'https://api.fake-provider.internal/v1///',
        apiKey: FAKE_KEY,
        model: TEST_MODEL,
        messages: TEST_MESSAGES,
        fetchImpl: fakeFetch,
      });

      // Trailing slashes removed and path appended
      assert.equal(recordedUrl, 'https://api.fake-provider.internal/v1/chat/completions');

      // Method and headers
      assert.equal(recordedOptions.method, 'POST');
      assert.equal(recordedOptions.headers['Authorization'], `Bearer ${FAKE_KEY}`);
      assert.equal(recordedOptions.headers['Content-Type'], 'application/json');

      // Exact JSON body: model, messages, temperature 0.2, max_tokens 500, stream false
      const parsedBody = JSON.parse(recordedOptions.body);
      assert.deepEqual(parsedBody, {
        model: TEST_MODEL,
        messages: TEST_MESSAGES,
        temperature: 0.2,
        max_tokens: 500,
        stream: false,
      });

      // Returns trimmed content
      assert.equal(result, 'Four is the answer.');
    });

    test('handles baseUrl without trailing slash', async () => {
      let recordedUrl = null;
      const fakeFetch = async (url) => {
        recordedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'OK' } }],
          }),
        };
      };

      const result = await callProvider({
        baseUrl: 'http://localhost:4000',
        apiKey: 'key',
        model: 'm',
        messages: [],
        fetchImpl: fakeFetch,
      });

      assert.equal(recordedUrl, 'http://localhost:4000/chat/completions');
      assert.equal(result, 'OK');
    });
  });

  describe('callProvider - non-2xx HTTP responses', () => {
    const errorStatuses = [400, 401, 403, 404, 429, 500, 502, 503, 504];

    for (const status of errorStatuses) {
      test(`HTTP ${status} throws ProviderError with kind upstream and status ${status}`, async () => {
        const fakeFetch = async () => ({
          ok: false,
          status,
          text: async () => 'Sensitive upstream error body: internal database connection failed',
          headers: new Headers({ 'x-upstream-header': 'secret-debug-id' }),
        });

        await assert.rejects(
          async () => {
            await callProvider({
              baseUrl: BASE_URL,
              apiKey: FAKE_KEY,
              model: TEST_MODEL,
              messages: TEST_MESSAGES,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.ok(err instanceof ProviderError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, status);
            // Must not contain upstream body or API key
            assert.ok(!err.message.includes('Sensitive upstream error body'));
            assert.ok(!err.message.includes(FAKE_KEY));
            assert.ok(!err.message.includes(BASE_URL));
            return true;
          }
        );
      });
    }
  });

  describe('callProvider - malformed JSON, missing choices, empty/non-string content', () => {
    test('malformed JSON response throws ProviderError kind upstream with no status', async () => {
      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      });

      await assert.rejects(
        async () => {
          await callProvider({
            baseUrl: BASE_URL,
            apiKey: FAKE_KEY,
            model: TEST_MODEL,
            messages: TEST_MESSAGES,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          return true;
        }
      );
    });

    test('missing choices array throws ProviderError kind upstream', async () => {
      const cases = [
        {},
        { choices: [] },
        { choices: null },
        { choices: undefined },
        { choices: 'not-an-array' },
      ];

      for (const payload of cases) {
        const fakeFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => payload,
        });

        await assert.rejects(
          async () => {
            await callProvider({
              baseUrl: BASE_URL,
              apiKey: FAKE_KEY,
              model: TEST_MODEL,
              messages: TEST_MESSAGES,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.ok(err instanceof ProviderError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, undefined);
            return true;
          }
        );
      }
    });

    test('empty or whitespace-only choices[0].message.content throws ProviderError kind upstream', async () => {
      const cases = [
        '',
        ' ',
        '\t\n\r  ',
      ];

      for (const content of cases) {
        const fakeFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content } }],
          }),
        });

        await assert.rejects(
          async () => {
            await callProvider({
              baseUrl: BASE_URL,
              apiKey: FAKE_KEY,
              model: TEST_MODEL,
              messages: TEST_MESSAGES,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.ok(err instanceof ProviderError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, undefined);
            return true;
          }
        );
      }
    });

    test('non-string choices[0].message.content throws ProviderError kind upstream', async () => {
      const cases = [
        null,
        undefined,
        12345,
        true,
        {},
        [],
      ];

      for (const content of cases) {
        const fakeFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content } }],
          }),
        });

        await assert.rejects(
          async () => {
            await callProvider({
              baseUrl: BASE_URL,
              apiKey: FAKE_KEY,
              model: TEST_MODEL,
              messages: TEST_MESSAGES,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.ok(err instanceof ProviderError);
            assert.equal(err.kind, 'upstream');
            assert.equal(err.status, undefined);
            return true;
          }
        );
      }
    });
  });

  describe('callProvider - abort / timeout', () => {
    test('fake fetch rejects with AbortError when timeout signal fires -> kind timeout', async () => {
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
          await callProvider({
            baseUrl: BASE_URL,
            apiKey: FAKE_KEY,
            model: TEST_MODEL,
            messages: TEST_MESSAGES,
            timeoutMs: 15,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'timeout');
          assert.equal(err.status, undefined);
          return true;
        }
      );
    });

    test('timeoutMs is capped at 30000 ms', async () => {
      let registeredDelay = null;
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (cb, ms, ...args) => {
        registeredDelay = ms;
        // Fire quickly in test rather than waiting 30 seconds
        return origSetTimeout(cb, 10, ...args);
      };

      const fakeFetch = (url, options) => {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      try {
        await assert.rejects(
          async () => {
            await callProvider({
              baseUrl: BASE_URL,
              apiKey: FAKE_KEY,
              model: TEST_MODEL,
              messages: TEST_MESSAGES,
              timeoutMs: 60000, // Exceeds cap
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.equal(err.kind, 'timeout');
            return true;
          }
        );
        assert.equal(registeredDelay, 30000);
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }
    });

    test('omitted timeoutMs falls back to getConfig().AI_TIMEOUT_MS capped at 30000', async () => {
      let registeredDelay = null;
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (cb, ms, ...args) => {
        registeredDelay = ms;
        return origSetTimeout(cb, 10, ...args);
      };

      const fakeFetch = (url, options) => {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      try {
        await assert.rejects(
          async () => {
            await callProvider({
              baseUrl: BASE_URL,
              apiKey: FAKE_KEY,
              model: TEST_MODEL,
              messages: TEST_MESSAGES,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.equal(err.kind, 'timeout');
            return true;
          }
        );
        assert.equal(registeredDelay, 30000);
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }
    });
  });

  describe('callProvider - network error', () => {
    test('network error (TypeError: fetch failed) throws ProviderError kind upstream', async () => {
      const fakeFetch = async () => {
        throw new TypeError('fetch failed');
      };

      await assert.rejects(
        async () => {
          await callProvider({
            baseUrl: BASE_URL,
            apiKey: FAKE_KEY,
            model: TEST_MODEL,
            messages: TEST_MESSAGES,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          return true;
        }
      );
    });

    test('connection refused error throws ProviderError kind upstream', async () => {
      const fakeFetch = async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:4000');
        err.code = 'ECONNREFUSED';
        throw err;
      };

      await assert.rejects(
        async () => {
          await callProvider({
            baseUrl: BASE_URL,
            apiKey: FAKE_KEY,
            model: TEST_MODEL,
            messages: TEST_MESSAGES,
            fetchImpl: fakeFetch,
          });
        },
        (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, undefined);
          return true;
        }
      );
    });
  });

  describe('callProvider - secret-free and timer lifecycle', () => {
    const DISTINCTIVE_FAKE_KEY = 'sk-distinctive-secret-key-EXACT-TOKEN-999-XYZ';
    const DISTINCTIVE_BASE_URL = 'https://admin:supersecretpassword@api.internal.corp/v1';
    const SENSITIVE_BODY = '{"error":{"message":"Internal database password leaked: secretpass123"}}';
    const SENSITIVE_HEADER_VAL = 'Bearer sensitive-token-in-header';

    test('errors never contain the API key, base URL, request URL, upstream body, or upstream headers', async () => {
      const errorCases = [
        {
          name: 'non-2xx response with sensitive body',
          fetchImpl: async () => ({
            ok: false,
            status: 500,
            text: async () => SENSITIVE_BODY,
            headers: new Headers({ 'x-upstream-auth': SENSITIVE_HEADER_VAL }),
          }),
        },
        {
          name: 'malformed JSON response',
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError(`SyntaxError near ${SENSITIVE_BODY}`);
            },
          }),
        },
        {
          name: 'network failure',
          fetchImpl: async () => {
            throw new TypeError(`Network error connecting to ${DISTINCTIVE_BASE_URL}`);
          },
        },
        {
          name: 'empty content response',
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: '   ' } }] }),
          }),
        },
        {
          name: 'timeout / abort',
          fetchImpl: (url, options) => {
            return new Promise((_, reject) => {
              options.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            });
          },
          timeoutMs: 15,
        },
      ];

      for (const tc of errorCases) {
        let caught = null;
        try {
          await callProvider({
            baseUrl: DISTINCTIVE_BASE_URL,
            apiKey: DISTINCTIVE_FAKE_KEY,
            model: TEST_MODEL,
            messages: TEST_MESSAGES,
            timeoutMs: tc.timeoutMs,
            fetchImpl: tc.fetchImpl,
          });
        } catch (err) {
          caught = err;
        }

        assert.ok(caught instanceof ProviderError, `${tc.name}: expected ProviderError`);

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
            !rep.val.includes(DISTINCTIVE_FAKE_KEY),
            `${tc.name}: ${rep.label} leaked API key: ${rep.val}`
          );
          assert.ok(
            !rep.val.includes(DISTINCTIVE_BASE_URL),
            `${tc.name}: ${rep.label} leaked base URL: ${rep.val}`
          );
          assert.ok(
            !rep.val.includes('/chat/completions'),
            `${tc.name}: ${rep.label} leaked request endpoint: ${rep.val}`
          );
          assert.ok(
            !rep.val.includes(SENSITIVE_BODY),
            `${tc.name}: ${rep.label} leaked upstream body: ${rep.val}`
          );
          assert.ok(
            !rep.val.includes(SENSITIVE_HEADER_VAL),
            `${tc.name}: ${rep.label} leaked upstream header: ${rep.val}`
          );
        }
      }
    });

    test('timeout path leaves no timer keeping the process alive', async () => {
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

      const fakeFetch = (url, options) => {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      };

      try {
        await assert.rejects(
          async () => {
            await callProvider({
              baseUrl: BASE_URL,
              apiKey: FAKE_KEY,
              model: TEST_MODEL,
              messages: TEST_MESSAGES,
              timeoutMs: 15,
              fetchImpl: fakeFetch,
            });
          },
          (err) => {
            assert.equal(err.kind, 'timeout');
            return true;
          }
        );

        // Assert clearTimeout was called with the created timer handle
        assert.ok(createdTimer !== null, 'timer should have been created');
        assert.equal(clearedTimer, createdTimer, 'timer should have been passed to clearTimeout');

        // Assert timer is destroyed and does not keep the process alive
        assert.equal(createdTimer._destroyed, true, 'timer must be destroyed');
      } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.clearTimeout = origClearTimeout;
      }
    });

    test('success path also clears timer so long timeouts do not keep process alive', async () => {
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

      const fakeFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Quick answer' } }],
        }),
      });

      try {
        const result = await callProvider({
          baseUrl: BASE_URL,
          apiKey: FAKE_KEY,
          model: TEST_MODEL,
          messages: TEST_MESSAGES,
          timeoutMs: 25000, // Long timeout
          fetchImpl: fakeFetch,
        });

        assert.equal(result, 'Quick answer');
        assert.ok(createdTimer !== null, 'timer should have been created');
        assert.equal(clearedTimer, createdTimer, 'timer should have been passed to clearTimeout');
        assert.equal(createdTimer._destroyed, true, 'timer must be destroyed');
      } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.clearTimeout = origClearTimeout;
      }
    });
  });
});

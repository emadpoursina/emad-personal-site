#!/usr/bin/env node
/**
 * scripts/ai-stub.mjs
 *
 * Dependency-free OpenAI-compatible AI HTTP stub server.
 *
 * Capabilities:
 * - Accepts POST on any path ending with /chat/completions.
 * - Reads JSON body { model, messages, ... }.
 * - Logs { model, messages } to a JSONL file if --log is set.
 * - Delays response if --delay-ms > 0.
 * - Returns OpenAI-compatible { choices: [{ message: { content } }] } where
 *   content is --answer <text> or "This is a canned AI stub answer.".
 * - Rejects non-POST methods with 405 Method Not Allowed (JSON).
 * - Rejects unrecognized paths with 404 Not Found (JSON).
 * - Handles malformed request bodies with 400 Bad Request (JSON).
 * - Self-tests with --self-test.
 *
 * CLI:
 *   node scripts/ai-stub.mjs --port <n> [--log <path>] [--delay-ms <n>] [--answer <text>]
 *   node scripts/ai-stub.mjs --self-test [--answer <text>]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { URL, fileURLToPath } from 'node:url';

const DEFAULT_ANSWER = 'This is a canned AI stub answer.';
const DEFAULT_MODEL = 'stub-model';

/**
 * Creates an HTTP server acting as an OpenAI-compatible stub.
 * @param {object} options
 * @param {string|null} [options.logPath]
 * @param {number} [options.delayMs]
 * @param {string|null} [options.answer]
 * @returns {http.Server}
 */
export function createAiStubServer(options = {}) {
  const {
    logPath = null,
    delayMs = 0,
    answer = null,
  } = options;

  const cannedAnswer = answer !== null && answer !== undefined
    ? answer
    : DEFAULT_ANSWER;

  const server = http.createServer((req, res) => {
    // 1. Path check: accept POST when path ends with /chat/completions (any prefix)
    let pathname = '';
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      pathname = parsedUrl.pathname;
    } catch {
      pathname = req.url || '';
    }

    const normalizedPath = pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;

    if (!normalizedPath.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Not found: ${pathname}`,
          type: 'invalid_request_error',
          code: 404,
        },
      }));
      return;
    }

    // 2. Method check: accept POST only
    if (req.method !== 'POST') {
      res.writeHead(405, {
        'Content-Type': 'application/json',
        'Allow': 'POST',
      });
      res.end(JSON.stringify({
        error: {
          message: `Method ${req.method} not allowed`,
          type: 'invalid_request_error',
          code: 405,
        },
      }));
      return;
    }

    // 3. Read body
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Request stream error',
            type: 'invalid_request_error',
            code: 400,
          },
        }));
      }
    });

    req.on('end', async () => {
      let body;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        body = JSON.parse(raw);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new Error('Body must be a JSON object');
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Invalid JSON body',
            type: 'invalid_request_error',
            code: 400,
          },
        }));
        return;
      }

      // 4. Log to JSONL if logPath is set
      if (logPath) {
        try {
          const resolvedPath = path.resolve(logPath);
          const parentDir = path.dirname(resolvedPath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          const record = {
            model: body.model !== undefined ? body.model : DEFAULT_MODEL,
            messages: body.messages !== undefined ? body.messages : [],
          };
          fs.appendFileSync(resolvedPath, JSON.stringify(record) + '\n', 'utf8');
        } catch (err) {
          console.error('[ai-stub] log write error:', err.message);
        }
      }

      // 5. Delay if requested
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      // 6. Respond 200 with OpenAI-compatible body
      const responseModel = typeof body.model === 'string' && body.model
        ? body.model
        : DEFAULT_MODEL;

      const responsePayload = {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        model: responseModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: cannedAnswer,
            },
            finish_reason: 'stop',
          },
        ],
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });
  });

  return server;
}

/**
 * Self-test routine.
 * @param {object} options
 * @param {string|null} [options.answer]
 * @returns {Promise<void>}
 */
async function runSelfTest(options = {}) {
  const { answer = null } = options;
  const expectedAnswer = answer !== null && answer !== undefined
    ? answer
    : DEFAULT_ANSWER;

  const tempLogPath = path.join(
    os.tmpdir(),
    `ai-stub-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );

  const server = createAiStubServer({
    logPath: tempLogPath,
    delayMs: 0,
    answer,
  });

  try {
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve(undefined));
      server.once('error', reject);
    });

    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr !== null ? addr.port : null;
    if (!actualPort) {
      throw new Error('Could not determine ephemeral port');
    }

    const testUrl = `http://127.0.0.1:${actualPort}/v1/chat/completions`;
    const payload = {
      model: 'stub-model',
      messages: [{ role: 'user', content: 'ping' }],
    };

    const res = await fetch(testUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status !== 200) {
      throw new Error(`Expected HTTP 200, got ${res.status}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content !== expectedAnswer) {
      throw new Error(`Response answer mismatch: expected "${expectedAnswer}", got "${content}"`);
    }

    if (!fs.existsSync(tempLogPath)) {
      throw new Error(`Temporary log file was not created: ${tempLogPath}`);
    }

    const logLines = fs
      .readFileSync(tempLogPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);

    if (logLines.length !== 1) {
      throw new Error(`Expected exactly 1 JSONL log line, got ${logLines.length}`);
    }

    const record = JSON.parse(logLines[0]);
    if (record.model !== 'stub-model') {
      throw new Error(`Log record model mismatch: expected "stub-model", got "${record.model}"`);
    }

    if (
      !Array.isArray(record.messages) ||
      record.messages.length !== 1 ||
      record.messages[0]?.role !== 'user' ||
      record.messages[0]?.content !== 'ping'
    ) {
      throw new Error(
        `Log record messages mismatch: expected [{role:'user',content:'ping'}], got ${JSON.stringify(record.messages)}`
      );
    }

    console.log(`[ai-stub] self-test PASSED: answer ok, log recorded 1 request`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      if (fs.existsSync(tempLogPath)) {
        fs.unlinkSync(tempLogPath);
      }
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * Parses CLI arguments.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let port = null;
  let logPath = null;
  let delayMs = 0;
  let answer = null;
  let selfTest = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && i + 1 < argv.length) {
      port = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--port=')) {
      port = parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--log' && i + 1 < argv.length) {
      logPath = argv[++i];
    } else if (arg.startsWith('--log=')) {
      logPath = arg.slice('--log='.length);
    } else if (arg === '--delay-ms' && i + 1 < argv.length) {
      delayMs = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--delay-ms=')) {
      delayMs = parseInt(arg.slice('--delay-ms='.length), 10);
    } else if (arg === '--answer' && i + 1 < argv.length) {
      answer = argv[++i];
    } else if (arg.startsWith('--answer=')) {
      answer = arg.slice('--answer='.length);
    } else if (arg === '--self-test') {
      selfTest = true;
    }
  }

  return { port, logPath, delayMs, answer, selfTest };
}

// CLI execution check
let isMain = false;
try {
  isMain = process.argv[1] && (
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  );
} catch {
  isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}

if (isMain) {
  const { port, logPath, delayMs, answer, selfTest } = parseArgs(process.argv.slice(2));

  if (selfTest) {
    runSelfTest({ answer })
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[ai-stub] self-test FAILED:', err.message);
        process.exit(1);
      });
  } else {
    if (port === null || isNaN(port)) {
      console.error(
        'Usage: node scripts/ai-stub.mjs --port <n> [--log <path>] [--delay-ms <n>] [--answer <text>] [--self-test]'
      );
      process.exit(1);
    }

    const server = createAiStubServer({ logPath, delayMs, answer });
    server.listen(port, '0.0.0.0', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      console.log(`[ai-stub] listening on port ${actualPort}`);
      if (logPath) {
        console.log(`[ai-stub] logging to ${logPath}`);
      }
    });

    server.on('error', (err) => {
      console.error('[ai-stub] server error:', err.message);
      process.exit(1);
    });

    const shutdown = () => {
      server.close(() => {
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

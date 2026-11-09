# Contract: generator adapter (outbound) — Phase 4

**Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md) · **API**: [cover-letter-api.md](./cover-letter-api.md) · **Data model**: [../data-model.md](../data-model.md)

This is the **site-side** contract for the external cover-letter generator. The real service's own API documentation is still pending (PRD R11, §13); the parent card's locked decision 6 makes this adapter the single integration point, so remapping to the real service means changing this module and nothing else. Enabling it in production is an operator-review item: confirm the real endpoint, request shape, and authentication first.

Module: `src/lib/generator-provider.mjs`. Function: `callGenerator({ endpoint, apiKey, jobDescription, candidate, timeoutMs, fetchImpl })`.

## Outbound request

```http
POST <effective endpoint, exactly as configured>
Authorization: Bearer <GENERATOR_API_KEY>
Content-Type: application/json
Accept: application/json
```

```json
{
  "job_description": "<trimmed job description, 1–8000 characters>",
  "candidate": {
    "name": "Emad Poursina",
    "headline": "AI and Agentic Systems Engineer with a strong foundation in software development",
    "work_authorization": "Requires employer-sponsored work authorization.",
    "availability": "one month notice",
    "contact_email": "emad.poursina.work@gmail.com",
    "linkedin": "https://www.linkedin.com/in/emadpoursina/",
    "github": "https://github.com/emadpoursina",
    "bio": "<profile.bio verbatim>"
  },
  "required": {
    "work_authorization": "Requires employer-sponsored work authorization.",
    "signoff": "Best regards, Emad Poursina",
    "banned_phrases": [
      "I am writing to express my interest",
      "passionate",
      "dynamic",
      "synergy",
      "results-driven",
      "team player"
    ]
  },
  "max_characters": 12000
}
```

Rules:

- The endpoint is used exactly as configured; no path or suffix is appended. Trailing slashes are already trimmed by settings resolution.
- The `candidate` object is built from `content/profile.json` at request time; it contains no fact that is not in the profile.
- The job description is sent as data. No prompt, system message, or site rule is sent outside the `required` block above.
- No cookie, no IP address, and no visitor identifier is sent.
- The key appears only in the `Authorization` header. It is never put in the body, a URL, or a log.
- The request is bounded by `timeoutMs` (default 30,000, maximum 30,000) using `AbortController`; the timer is always cleared.

## Inbound response

A 2xx response must be JSON:

```json
{ "letter": "Dear Hiring Manager,\n\n…\n\nBest regards, Emad Poursina" }
```

Rules:

- Only `letter` is read. Extra fields are ignored. A missing, non-string, or whitespace-only `letter` is an upstream error.
- `letter.trim()` longer than 12,000 characters is an upstream error (bounds memory and response size).
- The response body is never forwarded. In particular, an error body never reaches the browser, a log, or SQLite.
- The content type must parse as JSON; anything else is an upstream error.

## Timeout and error mapping

| Condition | Adapter result | API result |
|---|---|---|
| 2xx with a valid `letter` | trimmed string | 200 |
| non-2xx status | `GeneratorError{kind:'upstream', status}` | 502 `generator_error` |
| network failure / malformed JSON / missing or empty `letter` / over-long `letter` | `GeneratorError{kind:'upstream'}` | 502 `generator_error` |
| abort at the timeout bound | `GeneratorError{kind:'timeout'}` | 504 `generator_timeout` |

`GeneratorError` is the only error type thrown. Its message may name the failure class and the upstream HTTP status; it must never contain the key, the endpoint with credentials, the request body, or the upstream body. Tests assert every error message against a secret-leak list.

## Mapping to the real service (operator checklist)

When PRD R11 is answered, the mapping must be confirmed in this order and recorded in `README.md` by the build card (not by this spec card):

1. Endpoint path and method match the real service.
2. Authentication header name and scheme match (this contract assumes `Authorization: Bearer`).
3. Request field names match; if not, only `buildGeneratorRequest()` changes.
4. Response field name matches `letter`; if not, only `readGeneratorResponse()` changes.
5. The service's timeout and rate limits are compatible with a 30-second site bound and 10 requests per hour per IP.
6. The service's error statuses map to 502/504 as above.
7. The key is stored in `.env` as `GENERATOR_API_KEY` on the host and in the container environment; it is never committed or baked into the image.

Until that confirmation is recorded, the generator stays unconfigured in production: the form is hidden, `POST /api/cover-letter` returns 503, and the general letter is the only public output.

## Local stub (test double)

`scripts/generator-stub.mjs` implements this contract for tests:

- `POST` on any path; reads JSON; records `{requestId, receivedAt, method, path, authorizationPresent, authorizationScheme, keyLength, keyLast4, body}` to the `--log` JSONL file (never the full key).
- Returns `{"letter": "<--letter value>"}`; `--letter` defaults to a canned letter containing both required lines.
- `--status <n>` returns that status with `{"error":"stub failure"}`.
- `--delay-ms <n>` delays the response.
- `--port <n>`, `--log <path>`, `--self-test`.
- Never prints or logs the key.

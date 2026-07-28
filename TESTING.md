# Testing Plan — Google Health MCP Server

## Where we are

45 unit tests, all on pure functions: formatters, `handleApiError`, truncation, token merge/persistence, constants. They run in ~3s with `node:test` via `tsx` and no extra dependencies.

Everything that touches I/O is untested. These exports have zero coverage:

| Untested export | Why it matters |
|---|---|
| `getValidAccessToken`, `preflight` | The auth state machine — single-flight, retry, recovery |
| `runLoginFlow` | PKCE, state validation, loopback callback parsing |
| `makeApiRequest` | URL construction, param cleaning, header assembly |
| `safeTool` | The error boundary every tool depends on |
| `registerSimpleTool`, `register*Tools`, `buildServer` | Tool schemas and the MCP contract |

That is the entire risk surface. The bugs this codebase actually had — a dropped refresh token, unserialised concurrent writes, an opaque `invalid_grant` — all lived here, and only one of them (the token merge) has a regression test today.

## Testing approach

Five tiers, fastest first. Tiers 1–4 are hermetic and belong in CI; tier 5 needs a real Google account and runs on demand.

```
Tier 5  Live E2E            manual / scheduled    real Google API
Tier 4  Auth state machine  CI                    fake clock + fake login
Tier 3  MCP protocol        CI                    InMemoryTransport
Tier 2  HTTP-mocked         CI                    axios adapter stub
Tier 1  Unit (exists)       CI                    pure functions
```

Two seams are needed before tiers 2–4 can be written. Both are small and improve the production code:

1. **`api-client.ts`** currently calls `axios({...})` directly. Change to a module-level instance (`const http = axios.create()`) so tests can swap `http.defaults.adapter`. Axios supports a custom `adapter` natively — no mocking library required.
2. **`auth/client.ts`** imports `runLoginFlow` directly, so any test of the recovery path would open a browser. Add an injection point (`setLoginFlow(fn)` alongside the existing `resetAuthState()`) defaulting to the real implementation.

Similarly, `oauth.ts` should take its browser-opener as a parameter so the loopback server can be driven by a test HTTP request instead of a real browser.

---

## Tier 1 — Unit (extend what exists)

Gaps in the current suite, all cheap:

- `formatDataPoints` when `dataPoints` is present but not an array, and when a point's `name` has no `/`
- `formatRollUp` with zero buckets and with a bucket that has neither civil nor physical times
- `truncateIfNeeded` on multi-byte characters — confirm we slice by code unit deliberately and don't split a surrogate pair in a way that breaks JSON consumers
- `ungrantedScopeHint` (currently indirectly hit via one 403 test) with a full scope set, a partial set, and no token at all

## Tier 2 — HTTP-mocked integration

With the adapter seam, assert on the request axios *would* have sent, and on how responses are handled.

**`makeApiRequest`**
- builds `${API_BASE_URL}/${path}` with no double slash
- strips `undefined` params but keeps `false` and `0` — a real bug class, since `?pageSize=0` and a dropped param are different requests
- sends `Authorization: Bearer <token>`, and calls `getValidAccessToken` exactly once per request
- passes `data` on POST, omits it on GET
- honours the 30s timeout setting

**`safeTool` boundary**
- a throwing handler produces `{ isError: true }` and never propagates
- the message comes from `handleApiError`, so a 429 inside a tool surfaces as the rate-limit text
- a handler returning normally is passed through untouched

**Tool handlers**, driven directly, one representative per shape:
- `list_data_points` with `response_format: markdown` renders headings; with `json` returns parseable JSON
- `daily_rollup` sends the civil-date body — `{date:{year,month,day},time:{hours:0,...}}` — and omits `pageToken` when absent
- `rollup` sends RFC-3339 `startTime`/`endTime` plus `windowSize`
- `reconcile` hits the `:reconcile` suffix and `list_data_points` does not
- `export_exercise_tcx` returns a string payload unmodified and does **not** truncate it

## Tier 3 — MCP protocol contract

Use `InMemoryTransport.createLinkedPair()` with the SDK's `Client` against `buildServer()`. No subprocess, no stdio, fast.

- exactly 11 tools are registered, by name; `googlehealth_set_token` is absent
- every tool advertises `readOnlyHint: true`
- every description names its required OAuth scope (regex over the description text) — this is the model's only documentation, so drift is a real defect
- input schemas reject bad input at the protocol boundary: `page_size: 0` and `101`, a `data_type` outside the enum, `start_date: "2026-6-9"` against the `YYYY-MM-DD` regex
- defaults apply: omitting `page_size` yields 25, omitting `response_format` yields JSON
- a tool error returns `isError: true` rather than a JSON-RPC transport error

**Guard against stdout pollution.** Spawn `dist/index.js` as a subprocess, run a full initialize → `tools/list` handshake, and assert every stdout line parses as JSON-RPC. One stray `console.log` corrupts the protocol, and this is the only tier that catches it.

## Tier 4 — Auth state machine (highest value)

The area with the most history of breaking. All hermetic, using a stub token endpoint and the injected login flow.

**Refresh**
- an expired `expiry_date` triggers exactly one refresh; a valid one triggers none
- **single-flight:** 10 concurrent `getValidAccessToken()` calls produce exactly **one** token-endpoint request and one resolved value
- a rotated `refresh_token` in the response is persisted; an omitted one leaves the stored value intact (this pins the original bug)
- after refresh, the on-disk file is valid JSON with both tokens present

**`invalid_grant` recovery**
- with `GOOGLE_HEALTH_AUTO_REAUTH` unset: the injected login flow is invoked once, and the original call then succeeds
- concurrent failing calls trigger **one** login, not N
- with `GOOGLE_HEALTH_AUTO_REAUTH=0`: no login is attempted and the error text names `npm run auth`
- a login that itself fails surfaces a clear error rather than hanging

**Credential resolution**
- `token.json` wins over env vars when both are present
- env-only credentials are persisted to disk on first use
- missing credentials produce a message naming the exact missing variable

**`preflight`**
- never throws, whatever the failure — a server that won't start hides its tools
- warns on stderr (never stdout) when a required scope is missing
- a healthy token produces no warning

**`runLoginFlow`** with a stubbed opener and a test HTTP client hitting the loopback port:
- a callback with a mismatched `state` is rejected — the CSRF guard
- `?error=access_denied` produces a clear message
- a callback with no `code` is rejected
- a token response lacking `refresh_token` produces the "revoke and retry" message
- the auth URL carries `code_challenge_method=S256`, `access_type=offline`, `prompt=consent`
- the HTTP server is closed on every path, including timeout — a leaked listener would hang the process

## Tier 5 — Live end-to-end — IMPLEMENTED

`src/live.test.ts`, 11 tests, run with:

```bash
GOOGLE_HEALTH_LIVE_TESTS=1 npm run test:live
```

Gated behind that variable and never part of `npm test` or CI, since it needs a real account and network. Without it, all 11 report as skipped rather than failing.

It drives the actual MCP stdio protocol against `dist/index.js` — a real subprocess, real JSON-RPC, real API — so it covers the protocol contract and the stdout-purity guard from tier 3 as a side effect. Every stdout line is `JSON.parse`d by the reader, so a stray `console.log` fails the run.

**Confirmed API shapes** (all previously undocumented, and all easy to guess wrong):

| Field | Reality |
|---|---|
| Settings timezone | `timeZone`, not `timezone` |
| Rollup step total | `steps.countSum`, and it is a **string** |
| Rollup bucket order | **descending** by date |
| Rollup range | closed-open — `end_date` is exclusive |

Requires a signed-in `token.json` (`npm run auth`). The expectations below come from `evaluation.xml`.

**`evaluation.xml` already contains the oracle** — 10 questions with verified answers. Rather than needing an LLM harness, convert each into a direct API assertion. For example:

| From evaluation.xml | Direct assertion |
|---|---|
| Peak step day, 2026-06-09→16 | `daily_rollup(steps)` max bucket is `2026-06-13` |
| Paired tracker model | `list_devices` contains `Inspire 3` |
| Configured timezone | `get_settings().timezone == "Europe/Paris"` |
| Legacy user ID | `get_identity()` contains `D46NXC` |
| Weight before 2026-06-01 | most recent value is `65600` grams |
| Deep sleep, night of 06-20 | `77` minutes |

These are deterministic against a fixed historical account, so they make a genuine regression suite for API-shape changes — which is exactly what a version bump on Google's side would break.

Still worth adding: the remaining `evaluation.xml` answers not yet asserted — deep sleep minutes (77), weight before 2026-06-01 (65600 g), distinct exercise types (2), and the resting-heart-rate to oxygen-saturation cross-lookup (96.5).

## The `invalid_grant` canary

The 7-day Testing-mode expiry cannot be unit tested — it is a Google-side configuration, and the failure only manifests after a week of wall-clock time. The only way to *test* it is to watch for it.

Add a scheduled job (GitHub Actions `schedule:`, or a local task) that runs `npm run auth:status` daily against a stored credential and fails loudly when the live refresh stops working. Two properties make this worthwhile:

- If the consent screen ever reverts to Testing, it fires on day 8 instead of you discovering it mid-conversation.
- It is the only check that can confirm the fix actually held. A green run on day 9 proves what no unit test can.

This needs a real refresh token in CI secrets. If that is unacceptable, run it locally on a timer instead — the value is in the alerting, not the location.

## Regression tests that must not be deleted

Tie these to the specific defects, and say so in the test name so nobody "simplifies" them away:

1. `mergeTokens` preserves `refresh_token` when the patch omits it — **exists**, keep it
2. Concurrent `saveTokens` leaves valid JSON — **exists**, keep it
3. Single-flight refresh issues exactly one token request — to add
4. Auto-reauth opens exactly one login for N concurrent failures — to add
5. stdout carries only JSON-RPC — to add

## CI wiring

Extend the existing workflow rather than replacing it:

- tiers 1–4 join the existing `npm test` on the Node 20/22 matrix
- add a coverage report via `node --test --experimental-test-coverage`, with a floor on `src/auth/` specifically since that is the risk concentration
- keep the secret-scan job as-is
- tier 5 becomes a separate `workflow_dispatch` job, never on PR

## Fixtures

Capture one real response per data-type *shape* (not per data type — there are 40, but only a handful of shapes: interval-based, sample-based, rollup bucket, device, profile) into `src/__fixtures__/`. Scrub identifiers. These feed tiers 2 and 3 and mean formatter tests exercise real payload structure rather than invented shapes.

## Explicitly out of scope

- Testing Google's API behaviour itself — that is theirs to guarantee
- Load and performance testing — a personal-scale stdio server with a 30s timeout has no meaningful load profile
- Mutation testing — disproportionate for ~1,300 lines
- Testing the 40 data types individually — the enum is validated; per-type behaviour is server-side

## Suggested order

1. ~~Tier 5 live suite from `evaluation.xml`~~ — **done**, 11 tests passing
2. The two testability seams (adapter, login injection) — unblocks everything below
3. Tier 4 auth tests — highest risk, most history of breaking
4. Tier 3 protocol tests — partly covered by tier 5 already, including the stdout guard
5. Tier 2 HTTP tests
6. Tier 1 gap-filling
7. The canary, after the Cloud Console fix lands

Steps 2–4 are the bulk of the remaining value and are roughly a day's work.

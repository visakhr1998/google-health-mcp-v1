# Onboarding — Google Health MCP Server

> A stdio MCP server exposing 11 read-only tools over the Google Health API v4 (Fitbit / Pixel Watch data) to LLM clients.

**Status:** working prototype. Unit tests and CI in place; no linter yet.
**Entry point:** [src/index.ts](src/index.ts) → compiled to `dist/index.js`, launched over stdio by an MCP client.

---

## 1. The one thing to know first

**Auth used to break every 7 days, and the cause was not in this repo.** Google expires refresh tokens after 7 days for any OAuth app whose consent screen is in *Testing* status. The server would work for a week, then fail every call with `invalid_grant`.

The fix is a Cloud Console setting — **OAuth consent screen → Publishing status → In production** — not code. If `invalid_grant` ever returns, run `npm run auth:status`; it detects that specific fingerprint and tells you which of the two causes you are looking at.

The code side is now defensive rather than load-bearing: refreshes are single-flighted, the token file is written atomically, rotated refresh tokens are always persisted, and a rejected token triggers the browser flow automatically instead of failing the call.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node ≥ 18, ESM (`"type": "module"`) | imports must carry `.js` extensions |
| Language | TypeScript 5.7, `strict: true`, `module: Node16` | |
| MCP | `@modelcontextprotocol/sdk` ^1.6.1 | `McpServer` + `StdioServerTransport` |
| Schemas | `zod` ^3 | one schema object per tool's `inputSchema` |
| HTTP | `axios` ^1.7 | single wrapper, 30s timeout |
| OAuth | `google-auth-library` ^9 | `OAuth2Client`, PKCE, auto-refresh |
| Tests | `node:test` via `tsx` | zero extra dependencies |

Transport is **stdio only** — `console.log` would corrupt the protocol stream. All logging goes to `console.error`. Keep it that way.

---

## 3. Architecture

```
MCP client (Claude Code / Desktop / Inspector)
        │  stdio (JSON-RPC)
        ▼
  src/index.ts          wiring only — registers 4 tool groups, connects
        │
        ├── tools/      11 tool definitions + shared schemas/helpers
        │     └── formatters.ts   markdown rendering (pure)
        ▼
  src/api-client.ts     makeApiRequest() + handleApiError()
        │
        ▼
  src/auth/             store.ts (persistence) · oauth.ts (login) · client.ts (refresh)
        │
        ▼
  https://health.googleapis.com/v4
```

Strictly layered, no back-edges. `src/cli/` holds the two operator commands (`login`, `status`) and is not part of the server path.

### The abstractions to learn

In `tools/shared.ts` — learn these five and every tool reads the same:

- `safeTool(fn)` — wraps a handler; any throw becomes `{ isError: true }` with a friendly message.
- `truncateIfNeeded(text)` — caps responses at 25,000 chars so a wide date range can't blow the model's context.
- `respond(data, format, toMarkdown)` — the shared JSON-or-markdown tail every dual-format tool ends with.
- `registerSimpleTool(server, {...})` — collapses the four no-input GET tools into one declaration each.
- `READONLY_ANNOTATIONS` / `paginationSchema` / `responseFormatSchema` — spread in so every tool behaves identically.

### The 11 tools

| Module | Tools |
|---|---|
| `tools/profile.ts` | `get_profile`, `get_settings`, `get_identity` |
| `tools/datapoints.ts` | `list_data_points`, `get_data_point`, `reconcile` |
| `tools/rollups.ts` | `daily_rollup`, `rollup` |
| `tools/devices.ts` | `list_devices`, `get_device`, `export_exercise_tcx` |

All annotated `readOnlyHint: true`. Nothing in this server writes to Google.

---

## 4. Setup

```bash
npm install
cp .env.example .env    # fill in client ID + secret from Cloud Console
npm run auth            # browser opens, consent once
```

The OAuth client must be type **Desktop app** (any `127.0.0.1` port is accepted, so nothing to register) and the consent screen must be **In production** (see §1).

### Verify

```bash
npm test
npx @modelcontextprotocol/inspector node dist/index.js
```

Expect 45 tests green, `Google Health MCP server running via stdio` on stderr, and 11 tools listed. `googlehealth_get_profile` returns timezone `Europe/Paris` for the current test account.

### Daily loop

```bash
npm run dev     # tsx watch, no build step
```

---

## 5. Credential handling

`.env` and `token.json` live in the repo root and are gitignored. Nothing else should ever hold a credential.

Two guards, both running `scripts/check-secrets.mjs`:

- **Pre-commit hook** — enable once per clone with `git config core.hooksPath .githooks`. Scans staged content, so an unstaged "fix" can't smuggle a secret past it.
- **CI job** — scans the tree on every push and PR.

It matches Google client secrets (`GOCSPX-`), access tokens (`ya29.`), refresh tokens (`1//`), API keys (`AIza`), and PEM private keys.

If a credential does leak, rotate it in Cloud Console. Deleting the file is not enough.

---

## 6. Domain quirks worth knowing early

Google Health API behaviours, not bugs here:

- **Two casings for data types.** Tool params use kebab-case (`heart-rate`); filter expressions use snake_case (`heart_rate`). Documented in the tool description because it bites everyone once.
- **Civil vs physical time.** `daily_rollup` posts a `{year, month, day}` civil-date object in the user's local timezone; `rollup` posts RFC-3339 instants with a `windowSize` duration string (`"3600s"`).
- **Ranges are closed-open.** `end_date: "2026-06-16"` returns through June 15.
- **Not every data type supports every operation.** The API error lists what is allowed.
- **The refresh-token footgun.** In `auth/store.ts`, `mergeTokens` takes an incoming `refresh_token` only when truthy. Google omits it from most refresh responses, so a naive spread wipes the one credential that can't be regenerated without a browser. There is a unit test pinning this; do not "simplify" it.

---

## 7. Adding a tool

Pick the module it belongs to, then follow the local pattern. For a no-input GET:

```ts
registerSimpleTool(server, {
  name: "googlehealth_my_tool",
  title: "My Tool",
  path: "users/me/things",
  description: "What it returns.\n\nRequired scope: googlehealth.x.readonly",
});
```

For anything with parameters, use `server.registerTool` with `READONLY_ANNOTATIONS`, wrap the handler in `safeTool`, and return through `jsonResult` or `respond`.

Conventions to match:
- Descriptions state the return shape and the required OAuth scope — the description is the model's only documentation.
- New data types go in the `DATA_TYPES` tuple in `constants.ts`; `dataTypeEnum` picks them up automatically. A test enforces that the tuple stays sorted and duplicate-free.
- Anything returning a list gets `...paginationSchema` and `response_format`.

---

## 8. Debugging

| Symptom | Cause |
|---|---|
| `invalid_grant` | Run `npm run auth:status` — it distinguishes Testing-mode 7-day expiry from a genuine revocation |
| `403 Forbidden` | Scope not granted; the error names which ones are missing. Re-run `npm run auth` |
| Client shows no tools | Stale `dist/` — run `npm run build`; MCP config points at `dist/`, not `src/` |
| Garbled protocol / client hangs | Something wrote to stdout; all logging must use `console.error` |
| `404` on a valid-looking type | Not every data type supports every operation |
| Truncated response | Hit the 25k char cap — narrow the filter or use `page_size` |
| Browser opens unexpectedly | Auto re-auth kicked in after `invalid_grant`. Set `GOOGLE_HEALTH_AUTO_REAUTH=0` to disable |

---

## 9. Known gaps

1. **No linter or formatter.** Deliberately deferred.
2. **Unit tests only.** 45 tests cover the pure functions — formatters, error mapping, truncation, token merge/persistence, constants. Tool handlers and `makeApiRequest` are not covered; that needs mocked HTTP.
3. **`evaluation.xml` has no runner in-repo.** It is a fixture for an external harness.
4. **`export_exercise_tcx` sends `Accept: application/json`** while expecting XML back. The handler tolerates both, but the header is likely wrong.
5. **`token.json` sits in the repo root.** A deliberate call — one folder holds everything — with gitignore plus two scanner guards compensating. `GOOGLE_HEALTH_TOKEN_PATH` moves it if you change your mind.

---

## 10. Where to start, by role

- **New to the codebase:** `constants.ts` → `tools/shared.ts` → one tool module → `auth/client.ts`. Under 700 lines total; an hour gets you all of it.
- **Senior / owning it:** the layering is clean and worth preserving. Highest-value next steps are gaps 1 and 2 above.
- **Contractor / scoped work:** stay inside `tools/`. Touching `auth/` means touching the refresh-token footgun in §6 — read that first, and keep its test green.

# CLAUDE.md

Guidance for Claude Code working in this repository.

## Contribution workflow — required

**Every code change follows: branch → commits → PR → review → merge.**

```bash
git checkout -b <type>/<short-description>   # fix/, feat/, test/, docs/, chore/
# ... make changes, commit ...
gh pr create --fill
# ... review, wait for CI ...
gh pr merge
```

Never commit directly to `main`, and never merge a branch locally and push `main` — that skips review and lets code land without CI having run as a gate. If a PR conflicts, resolve it on the branch and push.

Enable the credential guard once per clone:

```bash
git config core.hooksPath .githooks
```

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Unit tests (`node:test` via `tsx`, no network) |
| `npm run test:live` | Live E2E — needs `GOOGLE_HEALTH_LIVE_TESTS=1` and a signed-in token |
| `npm run auth` | Browser sign-in; writes the token |
| `npm run auth:status` | Diagnose the current credential |
| `npm run check-secrets` | Scan the tree for credentials |

## Architecture

Strictly layered, no back-edges:

```
index.ts (wiring) → tools/ (11 tools) → api-client.ts → auth/ → Google Health API v4
```

- `tools/shared.ts` holds the shared helpers — `safeTool`, `fitJson`, `respond`, `fetchNonEmptyPage`, `READONLY_ANNOTATIONS`. Match the local pattern when adding a tool.
- `auth/` is `store.ts` (persistence), `oauth.ts` (PKCE loopback login), `client.ts` (refresh, `invalid_grant` recovery).
- `src/cli/` holds operator commands, not part of the server path.

## Non-obvious constraints

**stdout is the JSON-RPC stream.** All logging must use `console.error`. A stray `console.log` corrupts the protocol; `src/live.test.ts` guards this.

**Never emit invalid JSON.** Use `fitJson`/`jsonResult`, which drop whole records and set `truncated: true` rather than cutting a document mid-string. A client treating an unparseable body as "no records" silently loses data.

**Every failure must set `isError: true`.** Clients branch on the flag, not on message text. `safeTool` handles this — keep handlers wrapped in it.

**An empty page can still carry `nextPageToken`.** Only a missing token ends a walk. `fetchNonEmptyPage` absorbs this; don't reintroduce "empty means done".

**`daily_rollup` upstream requires `days <= page_size <= 90`** (verified by bisection). The server hides this by chunking; don't expose the coupling in the tool surface.

**Refresh tokens die after 7 days** if the OAuth consent screen is in *Testing* status. That is a Cloud Console setting, not a code bug — `npm run auth:status` names it.

**`mergeTokens` takes an incoming `refresh_token` only when truthy.** Google omits it from most refresh responses, so a naive spread destroys the one credential that needs a browser to regenerate. There is a test pinning this; do not "simplify" it.

## API shapes

Confirmed against the live API — easy to guess wrong:

| Field | Reality |
|---|---|
| Settings timezone | `timeZone`, not `timezone` |
| Rollup step total | `steps.countSum`, and it is a **string** |
| Rollup bucket order | **descending** by date |
| Rollup ranges | closed-open — `end_date` is exclusive |

## Secrets

`.env` and `token.json` are gitignored and hold live credentials. A pre-commit hook and a CI job both run `scripts/check-secrets.mjs`. Anything leaked in plaintext should be rotated in Cloud Console, not just deleted.

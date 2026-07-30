#!/usr/bin/env node
// `npm run auth:status` — diagnose the current credential without changing it.

// Must be set before importing the client: a diagnostic should never pop a
// browser window as a side effect.
process.env.GOOGLE_HEALTH_AUTO_REAUTH = "0";

import { REQUIRED_SCOPES } from "../constants.js";
import {
  getTokenPath,
  loadTokens,
  loadDotEnv,
  warnIfShadowedEnv,
  missingScopes,
} from "../auth/store.js";
import { getValidAccessToken, isInvalidGrant } from "../auth/client.js";

const DAY_MS = 86_400_000;
const fmtAge = (ms: number) => `${(ms / DAY_MS).toFixed(1)} days`;

async function main(): Promise<void> {
  warnIfShadowedEnv(loadDotEnv());
  const path = getTokenPath();
  console.log(`Token file:  ${path}`);

  const tokens = await loadTokens();
  if (!tokens) {
    console.log("Status:      no token file. Run `npm run auth`.");
    process.exit(1);
  }

  const masked = tokens.client_id ? `${tokens.client_id.slice(0, 12)}...` : "(absent)";
  console.log(`Client ID:   ${masked}`);

  const age = tokens.obtained_at ? Date.now() - tokens.obtained_at : null;
  console.log(
    `Minted:      ${
      tokens.obtained_at
        ? `${new Date(tokens.obtained_at).toISOString()} (${fmtAge(age!)} ago)`
        : "unknown (predates obtained_at tracking)"
    }`
  );

  if (tokens.expiry_date) {
    const expired = tokens.expiry_date < Date.now();
    console.log(
      `Access token: expires ${new Date(tokens.expiry_date).toISOString()}` +
        `${expired ? " (expired — will refresh on demand)" : ""}`
    );
  }

  const absent = missingScopes(tokens.scopes, [...REQUIRED_SCOPES]);
  console.log(
    `Scopes:      ${tokens.scopes?.length ?? 0} granted, ` +
      `${absent.length === 0 ? "all required present" : `${absent.length} REQUIRED MISSING`}`
  );
  for (const scope of absent) {
    console.log(`  missing: ${scope}`);
  }

  process.stdout.write("Live refresh: ");
  try {
    await getValidAccessToken();
    console.log("OK");
  } catch (error) {
    console.log("FAILED");
    if (isInvalidGrant(error)) {
      console.log("\n  Google rejected the refresh token (invalid_grant).");
      // The Testing-mode fingerprint: Google expires refresh tokens for apps in
      // "Testing" publishing status after exactly 7 days.
      if (age !== null && age > 6 * DAY_MS && age < 10 * DAY_MS) {
        console.log(
          `  This token is ${fmtAge(age)} old, which matches Google's 7-day\n` +
            "  expiry for OAuth consent screens still in \"Testing\" status.\n" +
            "  Fix: Cloud Console > APIs & Services > OAuth consent screen >\n" +
            "       Publishing status > In production. Then `npm run auth`.\n" +
            "  Re-authing without that change buys you another 7 days, no more."
        );
      } else {
        console.log("  It was revoked, superseded, or the account password changed.");
        console.log("  Fix: `npm run auth`.");
      }
    } else {
      console.log(`\n  ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }

  if (age !== null && age > 8 * DAY_MS) {
    console.log(
      `\nThis refresh token is ${fmtAge(age)} old and still valid — ` +
        "past the 7-day\nTesting-mode cutoff, so the consent screen is published. That is the fix\nfor the recurring invalid_grant working as intended."
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

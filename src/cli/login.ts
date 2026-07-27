#!/usr/bin/env node
// `npm run auth` — interactive browser sign-in.

import { runLoginFlow } from "../auth/oauth.js";
import { saveTokens, getTokenPath } from "../auth/store.js";

async function main(): Promise<void> {
  const { tokens, grantedScopes } = await runLoginFlow((m) => console.log(m));
  await saveTokens(tokens);

  console.log(`Signed in. Credentials written to ${getTokenPath()}`);
  console.log(`\nGranted ${grantedScopes.length} scope(s):`);
  for (const scope of grantedScopes) {
    console.log(`  - ${scope.replace("https://www.googleapis.com/auth/", "")}`);
  }
  console.log(
    "\nIf tool calls start failing with invalid_grant about a week from now,\n" +
      "your OAuth consent screen is still in \"Testing\" status — Google expires\n" +
      "refresh tokens after 7 days there. Fix it in Google Cloud Console under\n" +
      "APIs & Services > OAuth consent screen > Publishing status > In production."
  );
}

main().catch((error: unknown) => {
  console.error(`\nSign-in failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

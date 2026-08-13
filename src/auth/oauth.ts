import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { AddressInfo } from "node:net";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { ALL_SCOPES, OAUTH_REQUEST_TIMEOUT_MS } from "../constants.js";
import { TokenFile, loadDotEnv, warnIfShadowedEnv } from "./store.js";

const LOGIN_TIMEOUT_MS = Number(process.env.GOOGLE_HEALTH_AUTH_TIMEOUT_MS) || 120_000;

const DONE_PAGE = `<!doctype html><meta charset="utf-8">
<title>Signed in</title>
<style>body{font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}
div{text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#666;margin:0}</style>
<div><h1>Signed in to Google Health</h1><p>You can close this tab.</p></div>`;

const FAIL_PAGE = `<!doctype html><meta charset="utf-8">
<title>Sign-in failed</title>
<style>body{font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}
div{text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#666;margin:0}</style>
<div><h1>Sign-in failed</h1><p>Check the terminal for details.</p></div>`;

/**
 * Command that opens a URL in the platform's default browser.
 *
 * Windows deliberately avoids `cmd /c start`. cmd.exe treats `&` as a command
 * separator, so an OAuth URL — which is almost entirely `&`-joined parameters —
 * arrives truncated after the first one, and Google rejects it with
 * "Required parameter is missing: response_type". explorer.exe is spawned
 * directly with no shell in between, so the URL survives as one argument.
 *
 * Exported for testing.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "win32") return ["explorer.exe", [url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

function openBrowser(url: string): void {
  try {
    const [cmd, args] = browserCommand(process.platform, url);
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Headless or locked-down environment — the printed URL is the fallback.
  }
}

export interface LoginResult {
  tokens: TokenFile;
  grantedScopes: string[];
}

/**
 * Interactive OAuth login over a loopback redirect, with PKCE.
 *
 * A "Desktop app" OAuth client accepts any http://127.0.0.1:<port> redirect
 * without pre-registering it, which is what lets this use an ephemeral port and
 * removes all redirect-URI setup. Set GOOGLE_HEALTH_OAUTH_PORT to pin the port
 * if you are stuck on a "Web application" client instead.
 *
 * `log` defaults to stderr: this can be called from inside the MCP server,
 * where stdout carries the JSON-RPC stream and must not be written to.
 */
export async function runLoginFlow(
  log: (msg: string) => void = (m) => console.error(m)
): Promise<LoginResult> {
  warnIfShadowedEnv(loadDotEnv());

  const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const missing = [
      !clientId && "GOOGLE_HEALTH_CLIENT_ID",
      !clientSecret && "GOOGLE_HEALTH_CLIENT_SECRET",
    ]
      .filter(Boolean)
      .join(" and ");
    throw new Error(
      `Missing ${missing}. Copy .env.example to .env and fill in your OAuth ` +
        `client credentials from Google Cloud Console (client type: Desktop app).`
    );
  }

  const port = Number(process.env.GOOGLE_HEALTH_OAUTH_PORT) || 0;
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const actualPort = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${actualPort}`;
  const client = new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
    // The loopback callback wait has its own timeout (LOGIN_TIMEOUT_MS), but
    // once that resolves the code-exchange call below is unguarded — without
    // this, a hung request to the token endpoint hangs the login forever.
    transporterOptions: { timeout: OAUTH_REQUEST_TIMEOUT_MS },
  });

  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(24).toString("hex");

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    // Forces a refresh token to be issued even if this app was authorised before.
    prompt: "consent",
    scope: [...ALL_SCOPES],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for sign-in.`));
    }, LOGIN_TIMEOUT_MS);

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }

      const finish = (ok: boolean, err?: Error) => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ok ? DONE_PAGE : FAIL_PAGE);
        clearTimeout(timer);
        if (err) reject(err);
      };

      const error = url.searchParams.get("error");
      if (error) {
        finish(false, new Error(`Google returned "${error}". Sign-in was not completed.`));
        return;
      }

      // Guards against a forged callback from another page in the browser.
      if (url.searchParams.get("state") !== state) {
        finish(false, new Error("OAuth state mismatch — ignoring this callback."));
        return;
      }

      const received = url.searchParams.get("code");
      if (!received) {
        finish(false, new Error("Callback had no authorization code."));
        return;
      }

      finish(true);
      resolve(received);
    });

    log("\nOpening your browser to sign in to Google Health...");
    log(`If it does not open, paste this into a browser:\n\n${authUrl}\n`);
    openBrowser(authUrl);
  }).finally(() => {
    server.close();
  });

  const { tokens } = await client.getToken({ code, codeVerifier });

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. This usually means the app was " +
        "already authorised without `prompt=consent`. Revoke access at " +
        "https://myaccount.google.com/permissions and run `npm run auth` again."
    );
  }

  const grantedScopes = tokens.scope ? tokens.scope.split(" ") : [...ALL_SCOPES];

  return {
    grantedScopes,
    tokens: {
      type: "authorized_user",
      client_id: clientId,
      client_secret: clientSecret,
      token_uri: "https://oauth2.googleapis.com/token",
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
      scopes: grantedScopes,
      obtained_at: Date.now(),
    },
  };
}

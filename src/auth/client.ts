import { OAuth2Client } from "google-auth-library";
import { OAUTH_REQUEST_TIMEOUT_MS, REQUIRED_SCOPES } from "../constants.js";
import { runLoginFlow } from "./oauth.js";
import {
  TokenFile,
  loadDotEnv,
  warnIfShadowedEnv,
  loadTokens,
  saveTokens,
  mergeTokens,
  missingScopes,
  getTokenPath,
} from "./store.js";

let client: OAuth2Client | null = null;
let current: TokenFile | null = null;

// Single-flight guards. Without these, N concurrent tool calls against an
// expired token fire N refreshes (and, on failure, N browser windows).
let refreshInFlight: Promise<string> | null = null;
let reauthInFlight: Promise<void> | null = null;

const autoReauthEnabled = (): boolean => process.env.GOOGLE_HEALTH_AUTO_REAUTH !== "0";

const REAUTH_HINT = "Run `npm run auth` to sign in again.";

/**
 * `invalid_grant` means the refresh token is dead — revoked, superseded, or
 * expired. The most common cause by far is an OAuth consent screen left in
 * "Testing" status, where Google expires refresh tokens after 7 days.
 */
export function isInvalidGrant(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    message?: string;
    response?: { data?: { error?: string; error_description?: string } };
  };
  if (e.response?.data?.error === "invalid_grant") return true;
  return typeof e.message === "string" && e.message.includes("invalid_grant");
}

function credentialsFromEnv(): TokenFile | null {
  const client_id = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const client_secret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
  const refresh_token = process.env.GOOGLE_HEALTH_REFRESH_TOKEN;
  if (!client_id || !client_secret || !refresh_token) return null;
  return {
    type: "authorized_user",
    client_id,
    client_secret,
    refresh_token,
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

/** Run the browser login flow and adopt the result. Single-flighted. */
async function reauthenticate(): Promise<void> {
  if (reauthInFlight) return reauthInFlight;
  reauthInFlight = (async () => {
    const { tokens, grantedScopes } = await runLoginFlow();
    await saveTokens(tokens);
    current = tokens;
    client = null; // rebuilt lazily with the new credentials
    console.error(`Signed in. Granted ${grantedScopes.length} scope(s).`);
  })().finally(() => {
    reauthInFlight = null;
  });
  return reauthInFlight;
}

async function loadCredentials(): Promise<TokenFile> {
  warnIfShadowedEnv(loadDotEnv());
  const stored = await loadTokens();
  const creds = stored ?? credentialsFromEnv();

  if (!creds?.refresh_token) {
    if (!autoReauthEnabled()) {
      throw new Error(
        `No credentials at ${getTokenPath()}. ${REAUTH_HINT} ` +
          "(Automatic sign-in is disabled via GOOGLE_HEALTH_AUTO_REAUTH=0.)"
      );
    }
    console.error(`No stored credentials found at ${getTokenPath()}.`);
    await reauthenticate();
    if (!current) throw new Error(`Sign-in did not produce credentials. ${REAUTH_HINT}`);
    return current;
  }

  // Credentials supplied only via env vars still get persisted, so the refresh
  // token Google may hand back on rotation is never dropped.
  if (!stored) await saveTokens(creds);
  return creds;
}

async function getClient(): Promise<OAuth2Client> {
  if (client) return client;

  current = await loadCredentials();

  const c = new OAuth2Client({
    clientId: current.client_id,
    clientSecret: current.client_secret,
    // Without this, a hung refresh call blocks forever — and since refreshes
    // are single-flighted (refreshInFlight below), that stalls every tool call.
    transporterOptions: { timeout: OAUTH_REQUEST_TIMEOUT_MS },
  });
  c.setCredentials({
    refresh_token: current.refresh_token,
    access_token: current.access_token,
    expiry_date: current.expiry_date,
  });

  // Persist every credential update Google sends.
  //
  // The library has already merged `tokens` into c.credentials by the time this
  // fires — do NOT call setCredentials(tokens) here. That replaces the whole
  // object, and since refresh responses usually omit refresh_token, it would
  // wipe the one credential we cannot regenerate without a browser.
  c.on("tokens", (tokens) => {
    if (!current) return;
    current = mergeTokens(current, {
      access_token: tokens.access_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
      refresh_token: tokens.refresh_token ?? undefined,
    });
    void saveTokens(current).catch((err) => {
      console.error(`Warning: could not persist refreshed token: ${err.message}`);
    });
  });

  client = c;
  return c;
}

async function fetchAccessToken(): Promise<string> {
  const c = await getClient();
  try {
    const { token } = await c.getAccessToken();
    if (!token) throw new Error("Google returned an empty access token.");
    return token;
  } catch (error) {
    if (!isInvalidGrant(error)) throw error;

    if (!autoReauthEnabled()) {
      throw new Error(
        "Google rejected the refresh token (invalid_grant). It has been revoked " +
          `or has expired. ${REAUTH_HINT}`
      );
    }

    console.error("Refresh token rejected (invalid_grant) — starting sign-in...");
    await reauthenticate();

    // One retry with the freshly-issued credentials.
    const renewed = await getClient();
    const { token } = await renewed.getAccessToken();
    if (!token) throw new Error(`Could not obtain an access token. ${REAUTH_HINT}`);
    return token;
  }
}

/**
 * Current access token, refreshing if needed. Concurrent callers share one
 * in-flight refresh rather than each triggering their own.
 */
export async function getValidAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = fetchAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Validate credentials at startup so a dead token surfaces (and self-heals)
 * before the first tool call rather than mid-conversation.
 *
 * Never throws — a server that refuses to start just hides its tools from the
 * client. Problems are reported on stderr; stdout is the JSON-RPC stream.
 */
export async function preflight(): Promise<void> {
  try {
    await getValidAccessToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Authentication is not ready: ${message}`);
    return;
  }

  const absent = missingScopes(current?.scopes, [...REQUIRED_SCOPES]);
  if (absent.length > 0) {
    console.error(
      `Warning: token is missing ${absent.length} required scope(s):\n` +
        absent.map((s) => `  - ${s}`).join("\n") +
        `\nSome tools will return 403. ${REAUTH_HINT}`
    );
  }
}

/** Credentials currently in memory. For diagnostics only. */
export function currentTokens(): TokenFile | null {
  return current;
}

/** Test seam — drops cached state so a fresh token path takes effect. */
export function resetAuthState(): void {
  client = null;
  current = null;
  refreshInFlight = null;
  reauthInFlight = null;
}

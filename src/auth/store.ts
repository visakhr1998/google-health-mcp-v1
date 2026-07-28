import { readFile, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root — two levels up from src/auth (and from dist/auth after build). */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TokenFile {
  type: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token_uri: string;
  access_token?: string;
  expiry_date?: number;
  scopes?: string[];
  /** When the refresh token was minted. Used by `npm run auth:status`. */
  obtained_at?: number;
}

export function getTokenPath(): string {
  return process.env.GOOGLE_HEALTH_TOKEN_PATH || join(PROJECT_ROOT, "token.json");
}

export interface DotEnvResult {
  /** Keys the file supplied because nothing was already set. */
  applied: string[];
  /**
   * Keys the file declares but a pre-existing environment variable overrode
   * with a *different* value. An identical value is not reported — only a
   * genuine conflict is worth anyone's attention.
   */
  shadowed: Array<{ key: string; fileValue: string; envValue: string }>;
}

/**
 * Minimal .env loader. Node 20.11 predates `process.loadEnvFile`, and the MCP
 * client launches us as a bare `node dist/index.js`, so we cannot rely on
 * `--env-file` either. Existing environment variables always win, which is
 * standard .env behaviour — see `warnIfShadowedEnv` for why that deserves a
 * warning rather than silence.
 */
export function loadDotEnv(path = join(PROJECT_ROOT, ".env")): DotEnvResult {
  const result: DotEnvResult = { applied: [], shadowed: [] };
  if (!existsSync(path)) return result;

  for (const raw of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;

    const existing = process.env[key];
    if (existing === undefined) {
      process.env[key] = value;
      result.applied.push(key);
    } else if (value !== "" && existing !== value) {
      // A blank placeholder in .env is not a conflict, it is an unfilled field.
      result.shadowed.push({ key, fileValue: value, envValue: existing });
    }
  }
  return result;
}

let shadowWarningEmitted = false;

/** Client IDs are public identifiers; everything else here is a secret. */
function describeConflict(key: string, fileValue: string, envValue: string): string {
  if (!key.endsWith("CLIENT_ID")) {
    return `  ${key}: environment value differs from .env (values hidden)`;
  }
  const short = (v: string) => (v.length > 24 ? `${v.slice(0, 24)}...` : v);
  return `  ${key}: using "${short(envValue)}" from the environment, .env declares "${short(fileValue)}"`;
}

/**
 * Warn when the environment silently overrides .env with different values.
 *
 * This is the failure that is hardest to diagnose from the symptom: a stale
 * persistent variable pointing at a retired OAuth client shadows a correct
 * .env, and the only visible effect is invalid_grant with no explanation.
 *
 * Writes to stderr (stdout carries the JSON-RPC stream) and only once per
 * process, so the server does not repeat it on every refresh.
 */
export function warnIfShadowedEnv(result: DotEnvResult): void {
  if (shadowWarningEmitted || result.shadowed.length === 0) return;
  shadowWarningEmitted = true;

  console.error(
    [
      "Warning: environment variables are overriding .env with different values:",
      ...result.shadowed.map((s) => describeConflict(s.key, s.fileValue, s.envValue)),
      "The environment wins, which is standard .env behaviour. If these are stale",
      "leftovers, clear them and restart your terminal — on Windows:",
      "  [Environment]::SetEnvironmentVariable('NAME', $null, 'User')",
      "  export -n NAME        # macOS/Linux, plus remove it from your shell profile",
    ].join("\n")
  );
}

/** Test seam — allows the once-per-process warning to fire again. */
export function resetShadowWarning(): void {
  shadowWarningEmitted = false;
}

export async function loadTokens(): Promise<TokenFile | null> {
  const path = getTokenPath();
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  try {
    return JSON.parse(raw) as TokenFile;
  } catch {
    throw new Error(
      `Token file at ${path} is not valid JSON. Delete it and run: npm run auth`
    );
  }
}

/**
 * Merge a credential update into the stored token.
 *
 * Google omits `refresh_token` from most refresh responses, and may rotate it
 * on the ones where it is present. Taking the incoming value only when it is
 * truthy is what keeps a refresh from silently destroying the credential —
 * losing it here is one of the two ways this server used to start returning
 * `invalid_grant` a week after setup.
 *
 * Pure, so it is directly unit-testable.
 */
export function mergeTokens(base: TokenFile, patch: Partial<TokenFile>): TokenFile {
  return {
    ...base,
    ...patch,
    refresh_token: patch.refresh_token || base.refresh_token,
  };
}

// Serialises writes so two concurrent refreshes cannot interleave.
let writeChain: Promise<void> = Promise.resolve();

/** Write atomically (temp file + rename) so a crash cannot leave a half-file. */
export function saveTokens(tokens: TokenFile): Promise<void> {
  writeChain = writeChain.then(async () => {
    const path = getTokenPath();
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    try {
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    // No-op on Windows, meaningful everywhere else.
    await chmod(path, 0o600).catch(() => {});
  });
  return writeChain;
}

/** Scopes in `required` that the stored token was not granted. */
export function missingScopes(
  granted: readonly string[] | undefined,
  required: readonly string[]
): string[] {
  const have = new Set(granted ?? []);
  return required.filter((s) => !have.has(s));
}

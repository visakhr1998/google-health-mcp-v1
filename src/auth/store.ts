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

/**
 * Minimal .env loader. Node 20.11 predates `process.loadEnvFile`, and the MCP
 * client launches us as a bare `node dist/index.js`, so we cannot rely on
 * `--env-file` either. Existing environment variables always win.
 */
export function loadDotEnv(path = join(PROJECT_ROOT, ".env")): void {
  if (!existsSync(path)) return;
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
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
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
